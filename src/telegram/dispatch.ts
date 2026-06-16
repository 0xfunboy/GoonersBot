import type { Context as GrammyContext } from 'grammy';
import type { Permission, Services } from '../services/index.js';
import type { CommandSpec, CallbackSpec, HandlerInput } from './handlers/types.js';
import { buildChatContext, buildIncomingMessage, buildPerson } from './context.js';
import { localizeResponse, sendResponse } from './render.js';
import { termsKeyboard } from './handlers/shared.js';
import { parseArgs } from '../utils/args.js';
import { parseCallbackData } from './keyboards.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('dispatch');

export interface DispatchDeps {
  services: Services;
  botUsername: string;
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
  const message = await buildIncomingMessage(ctx, { image: true, voice: true });

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
  await finish(ctx, deps, prepared, (input) => spec.handle(input));
}

export async function runCallback(
  ctx: GrammyContext,
  spec: CallbackSpec,
  deps: DispatchDeps,
): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data ?? '';
  const { args } = parseCallbackData(data);
  const prepared = await prepare(ctx, deps, spec.permissions, spec.needsTermsAccepted, args);
  await finish(ctx, deps, prepared, (input) => spec.handle(input));
}

async function finish(
  ctx: GrammyContext,
  deps: DispatchDeps,
  prepared: Awaited<ReturnType<typeof prepare>>,
  run: (input: HandlerInput) => Promise<import('../domain/types.js').CommandResponse | null>,
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
    const localized = await localizeResponse(services, chatId, {
      text: 'terms_text',
      keyboard: termsKeyboard(services, language),
    });
    await sendResponse(ctx, localized);
    return;
  }

  try {
    const response = await run(prepared.input);
    if (!response) return;
    const localized = await localizeResponse(services, prepared.input.context.chatId, response);
    await sendResponse(ctx, localized);
  } catch (err) {
    log.error({ err }, 'handler failed');
    const localized = await localizeResponse(services, chatId, { text: 'generation_failed' });
    await sendResponse(ctx, localized).catch(() => undefined);
  }
}
