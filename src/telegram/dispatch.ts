import type { Context as GrammyContext } from 'grammy';
import type { Permission, Services } from '../services/index.js';
import type { CommandSpec, CallbackSpec, HandlerInput } from './handlers/types.js';
import { buildChatContext, buildIncomingMessage, buildPerson } from './context.js';
import { localizeResponse, sendResponse, scheduleDelete } from './render.js';
import { termsKeyboard, termsHeader } from './handlers/shared.js';
import { parseArgs } from '../utils/args.js';
import { parseCallbackData } from './keyboards.js';
import { childLogger } from '../utils/logger.js';
import { currentLlmUsage, runWithGroupPlan } from '../providers/llm/requestContext.js';

const log = childLogger('dispatch');

// Commands always allowed without approval (the rest require admin / approved user / approved chat).
// `terms` is an alias of `tos`, so the spec.command checked here is 'tos'.
const BASIC_COMMANDS = new Set(['start', 'tos', 'help']);

export interface DispatchDeps {
  services: Services;
  botUsername: string;
}

interface CommandAccounting {
  bypassGroupPlan: boolean;
  tokenReservation: number;
}

/** Shared pre-handler bootstrap: build input, init context, permission + terms gate. */
async function prepare(
  ctx: GrammyContext,
  deps: DispatchDeps,
  permissions: readonly Permission[],
  needsTermsAccepted: boolean,
  args: string[],
): Promise<{ input: HandlerInput } | { denied: 'auth' } | { skip: true } | { terms: true }> {
  const { services, botUsername } = deps;
  const person = buildPerson(ctx);
  const context = await buildChatContext(ctx, botUsername);
  if (!person || !context) return { skip: true };
  // Explicit interactions (commands/callbacks) are always "addressed".
  const message = await buildIncomingMessage(ctx, { image: true, voice: true, documents: true });

  await services.initializeContext(person, context);

  const input: HandlerInput = {
    services,
    person,
    context,
    message,
    args,
    botUsername,
    addressed: true,
  };

  const ok = await services.permissions.checkAll(permissions, person, context);
  if (!ok) return { denied: 'auth' };

  if (needsTermsAccepted) {
    if (await services.terms.hasDeclined(person.userHandle)) return { skip: true };
    if (!(await services.terms.hasAccepted(person.userHandle))) return { terms: true };
  }

  return { input };
}

export async function runCommand(
  ctx: GrammyContext,
  spec: CommandSpec,
  deps: DispatchDeps,
): Promise<void> {
  // Anti-spam: drop commands over the per-user/per-chat rate limit BEFORE any DB/LLM work.
  const rlKey = `${ctx.chat?.id ?? 0}:${ctx.from?.id ?? 0}`;
  if (!deps.services.commandRateLimit.tryAcquire(rlKey)) {
    log.debug({ key: rlKey, command: spec.command }, 'command rate-limited');
    return;
  }
  const args = parseArgs(ctx.message?.text ?? '');
  const prepared = await prepare(ctx, deps, spec.permissions, spec.needsTermsAccepted, args);
  // Approval gate: non-basic commands require an admin / approved user / approved chat. Everyone
  // else (incl. private DMs) is limited to the basic commands and gets the "request approval" notice.
  if ('input' in prepared && !BASIC_COMMANDS.has(spec.command)) {
    if (!(await requireApproval(ctx, deps, prepared.input))) return;
  }
  let accounting: CommandAccounting | undefined;
  if ('input' in prepared && spec.quotaConversation) {
    const { person, context, message } = prepared.input;
    if (
      !(await deps.services.usage.isUnderLimit(
        person.userHandle,
        message.messageText,
        Boolean(
          message.imageBuffer ||
          message.repliedImageBuffer ||
          message.videoBuffer ||
          message.repliedVideoBuffer ||
          message.attachments?.some((attachment) => /^image\//i.test(attachment.mime)),
        ),
        Boolean(message.audioBuffer || message.repliedAudioBuffer),
      ))
    ) {
      const localized = await localizeResponse(deps.services, context.chatId, {
        text: 'usage_limit_exceeded',
        vars: {
          user_handle: person.userHandle,
          usage_limit: await deps.services.usage.getLimit(person.userHandle),
        },
      });
      await sendResponse(ctx, localized);
      return;
    }

    const bypassGroupPlan = deps.services.bypassesGroupPlan(person, context);
    const decision = bypassGroupPlan
      ? { allowed: true as const, tokenReservation: 0 }
      : await deps.services.quota.admitConversation({
          chatId: context.chatId,
          telegramId: person.telegramId,
          passive: false,
          // Some command handlers use no LLM at all (voice/music), so do not reject them merely
          // because a generic token reservation does not fit. Provider-level metering below still
          // records every token actually spent by commands that do call an LLM.
          reserveTokens: false,
        });
    if (!decision.allowed) {
      const localized = await localizeResponse(deps.services, ctx.chat?.id ?? 0, {
        text: 'group_quota_exceeded',
        vars: {
          reason: decision.reason ?? 'limit',
          retry_after: decision.retryAfterSeconds ?? 0,
        },
      });
      await sendResponse(ctx, localized);
      return;
    }
    accounting = {
      bypassGroupPlan,
      tokenReservation: decision.tokenReservation ?? 0,
    };
  }
  await finish(ctx, deps, prepared, (input) => spec.handle(input), accounting);
}

export async function runCallback(
  ctx: GrammyContext,
  spec: CallbackSpec,
  deps: DispatchDeps,
): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  if (spec.ownerOnly && !callbackBelongsToActor(ctx)) return;
  const data = ctx.callbackQuery?.data ?? '';
  const { args } = parseCallbackData(data);
  const prepared = await prepare(ctx, deps, spec.permissions, spec.needsTermsAccepted, args);
  if ('input' in prepared && !spec.approvalExempt) {
    if (!(await requireApproval(ctx, deps, prepared.input))) return;
  }
  await finish(ctx, deps, prepared, (input) => spec.handle(input));
}

async function finish(
  ctx: GrammyContext,
  deps: DispatchDeps,
  prepared: Awaited<ReturnType<typeof prepare>>,
  run: (input: HandlerInput) => Promise<import('../domain/types.js').CommandResponse | null>,
  accounting?: CommandAccounting,
): Promise<void> {
  const { services } = deps;
  const chatId = ctx.chat?.id ?? 0;

  if ('skip' in prepared) return;
  if ('denied' in prepared) {
    const localized = await localizeResponse(services, chatId, { text: 'not_authenticated' });
    await sendResponse(ctx, localized);
    return;
  }
  if ('terms' in prepared) {
    const language = await services.getLanguage(chatId);
    const header = termsHeader();
    const localized = await localizeResponse(services, chatId, {
      text: 'terms_text',
      keyboard: termsKeyboard(services, language),
      ...(header ? { imageBuffer: header } : {}),
    });
    const sent = await sendResponse(ctx, localized);
    scheduleDelete(ctx, sent, 60_000); // personal prompt: self-destruct if not signed in 1 minute
    return;
  }

  let meteredUsage: ReturnType<typeof currentLlmUsage>;
  let providerUsage: import('../domain/types.js').CommandResponse['usage'];
  let plan: Awaited<ReturnType<Services['planForTurn']>> | undefined;
  try {
    plan = await services.planForTurn(prepared.input.person, prepared.input.context);
    const response = await runWithGroupPlan(plan.id, async () => {
      try {
        const value = await run(prepared.input);
        providerUsage = value?.usage;
        return value;
      } finally {
        meteredUsage = currentLlmUsage();
      }
    });
    if (!response) return;
    // Terms prompts disappear; durable action prompts may instead remain as an audit trail with
    // their now-consumed buttons removed.
    if (response.deleteOrigin && ctx.callbackQuery) {
      await ctx.deleteMessage().catch(() => undefined);
    } else if (response.clearOriginKeyboard && ctx.callbackQuery?.message?.message_id) {
      await ctx.api
        .editMessageReplyMarkup(
          prepared.input.context.chatId,
          ctx.callbackQuery.message.message_id,
          {
            reply_markup: { inline_keyboard: [] },
          },
        )
        .catch(() => undefined);
    }
    const localized = await localizeResponse(services, prepared.input.context.chatId, response);
    const sent = await sendResponse(ctx, localized);
    if (response.ephemeralMs) scheduleDelete(ctx, sent, response.ephemeralMs);
  } catch (err) {
    log.error({ err }, 'handler failed');
    const localized = await localizeResponse(services, chatId, { text: 'generation_failed' });
    await sendResponse(ctx, localized).catch(() => undefined);
  } finally {
    if (accounting) {
      await settleCommandAccounting(
        services,
        prepared.input,
        accounting,
        plan,
        meteredUsage,
        providerUsage,
      );
    }
  }
}

async function requireApproval(
  ctx: GrammyContext,
  deps: DispatchDeps,
  input: HandlerInput,
): Promise<boolean> {
  if (deps.services.isApproved(input.person, input.context)) return true;
  const localized = await localizeResponse(deps.services, input.context.chatId, {
    text: 'approval_required',
    vars: { admin_handle: deps.services.adminContact() },
  });
  await sendResponse(ctx, localized);
  return false;
}

function callbackBelongsToActor(ctx: GrammyContext): boolean {
  const message = ctx.callbackQuery?.message;
  if (!message || !('reply_to_message' in message)) return true;
  const ownerId = message.reply_to_message?.from?.id;
  return ownerId === undefined || ownerId === ctx.from?.id;
}

async function settleCommandAccounting(
  services: Services,
  input: HandlerInput,
  accounting: CommandAccounting,
  plan: Awaited<ReturnType<Services['planForTurn']>> | undefined,
  usage: ReturnType<typeof currentLlmUsage>,
  providerUsage: import('../domain/types.js').CommandResponse['usage'],
): Promise<void> {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;
  const imageCalls = providerUsage?.imageCalls ?? 0;
  const transcriptionCalls = providerUsage?.transcriptionCalls ?? 0;
  const visionCalls = providerUsage?.visionCalls ?? 0;

  if (!accounting.bypassGroupPlan) {
    await services.quota
      .recordLlmTokens(input.context.chatId, totalTokens, accounting.tokenReservation)
      .catch((err) => log.error({ err }, 'command group token accounting failed'));
  }
  if (
    (!usage?.calls && imageCalls === 0 && transcriptionCalls === 0 && visionCalls === 0) ||
    !plan
  ) {
    return;
  }

  await services.usage
    .record({
      handle: input.person.userHandle,
      chatId: input.context.chatId,
      provider: services.llm.name,
      model: services.modelForPlan(plan, services.config.llm.model) ?? null,
      inputTokens,
      outputTokens,
      estimatedTokens: usage?.estimated ? totalTokens : 0,
      imageCalls,
      transcriptionCalls,
      visionCalls,
      points: totalTokens + imageCalls * 100,
      costEstimate: 0,
    })
    .catch((err) => log.error({ err }, 'command user usage accounting failed'));
}
