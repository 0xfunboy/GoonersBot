import { InputFile, type Context as GrammyContext } from 'grammy';
import type { ChatContext, IncomingMessage, Person } from '../../domain/types.js';
import type { Services } from '../../services/index.js';
import type { Env } from '../../config/env.js';
import { termsKeyboard } from './shared.js';
import { localizeResponse, sendResponse } from '../render.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('message');

export interface MessageDeps {
  services: Services;
  env: Env;
  botUsername: string;
}

/**
 * Core conversational handler (ports messages/message_handler.py).
 *
 * Flow:
 *  1. Permission gate (allowed_user, not_banned).
 *  2. Chat-started + tracking/mention gate.
 *  3. Terms gate (prompt only when addressed).
 *  4. Autoengage decision (mention => almost always; passive => scored + rate-limited).
 *  5. Not engaging but tracking => store message, return.
 *  6. Engaging => usage check, stream reply, persist user+bot messages, record usage, auto-facts.
 */
export async function handleMessage(
  ctx: GrammyContext,
  person: Person,
  context: ChatContext,
  message: IncomingMessage,
  deps: MessageDeps,
): Promise<void> {
  const { services, env, botUsername } = deps;

  await services.initializeContext(person, context);

  // 1. permissions
  const allowed = await services.permissions.checkAll(
    ['allowed_user', 'not_banned'],
    person,
    context,
  );
  if (!allowed) return;

  // 2. chat-started + tracking/mention gate
  const started = await services.conversation.isStarted(context.chatId);
  if (!started) return;
  const tracking = await services.conversation.isTrackingEnabled(context.chatId);
  const addressed = context.isBotMentioned || context.isReplyToBot;
  if (!tracking && !addressed) return;

  // 3. terms gate
  const declined = await services.terms.hasDeclined(person.userHandle);
  if (declined) return;
  const accepted = await services.terms.hasAccepted(person.userHandle);
  if (!accepted) {
    if (!addressed) return;
    const language = await services.getLanguage(context.chatId);
    const localized = await localizeResponse(services, context.chatId, {
      text: 'terms_text',
      keyboard: termsKeyboard(services, language),
    });
    await sendResponse(ctx, localized);
    return;
  }

  // 4. autoengage decision
  const autoengageEnabled = await services.storage.chats.getAutoengage(context.chatId);
  const [history, userFacts, groupFacts, mode] = await Promise.all([
    services.conversation.getRecent(context.chatId),
    services.facts.getForUser(context.chatId, person.userHandle),
    services.facts.getChatFacts(context.chatId),
    services.modes.getActive(context.chatId),
  ]);
  const modeName = mode?.name ?? 'Default';
  const modeDescription = mode?.description ?? 'Natural group participant.';

  const decision = await services.autoengage.decide(
    {
      person,
      context,
      currentMessage: message.messageText,
      modeName,
      modeDescription,
      history,
      userFacts,
      groupFacts,
    },
    addressed,
    autoengageEnabled,
  );

  // 5. not engaging -> store as context (if tracking) and return
  if (!decision.shouldReply) {
    if (tracking) {
      await services.conversation.addUserMessage(context.chatId, person.userHandle, {
        messageText: message.messageText || null,
        timestamp: message.timestamp,
        imageDescription: null,
        voiceDescription: null,
      });
    }
    log.debug({ chatId: context.chatId, reason: decision.reason }, 'not engaging');
    return;
  }

  // 6. usage pre-check
  const underLimit = await services.usage.isUnderLimit(
    person.userHandle,
    message.messageText,
    Boolean(message.imageBuffer),
    Boolean(message.audioBuffer),
  );
  if (!underLimit) {
    const limit = await services.usage.getLimit(person.userHandle);
    const localized = await localizeResponse(services, context.chatId, {
      text: 'usage_limit_exceeded',
      vars: { user_handle: person.userHandle, usage_limit: limit },
    });
    await sendResponse(ctx, localized);
    return;
  }

  const language = await services.getLanguage(context.chatId);
  await streamAndPersist(ctx, person, context, message, {
    services,
    env,
    botUsername,
    language,
    modeName,
    modeDescription,
  });

  services.autoengage.noteReply(context.chatId, person.userHandle);
}

interface StreamCtx {
  services: Services;
  env: Env;
  botUsername: string;
  language: string;
  modeName: string;
  modeDescription: string;
}

async function streamAndPersist(
  ctx: GrammyContext,
  person: Person,
  context: ChatContext,
  message: IncomingMessage,
  sc: StreamCtx,
): Promise<void> {
  const { services, env } = sc;
  let sentMessageId: number | undefined;
  let lastEditAt = 0;
  let lastSentText = '';

  const replyTo = ctx.message?.message_id;
  const editInterval = env.STREAM_EDIT_INTERVAL_MS;
  const streaming = env.ENABLE_MESSAGE_STREAMING;

  const stream = services.reply.streamReply({
    person,
    context,
    message,
    botUsername: sc.botUsername,
    language: sc.language,
    modeName: sc.modeName,
    modeDescription: sc.modeDescription,
  });

  let accumulated = '';
  try {
    await ctx.replyWithChatAction('typing').catch(() => undefined);
    let next = await stream.next();
    while (!next.done) {
      accumulated += next.value;
      if (streaming) {
        const now = Date.now();
        if (sentMessageId === undefined && accumulated.trim().length > 0) {
          const sent = await ctx.reply(accumulated, {
            ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
          });
          sentMessageId = sent.message_id;
          lastSentText = accumulated;
          lastEditAt = now;
        } else if (
          sentMessageId !== undefined &&
          now - lastEditAt >= editInterval &&
          accumulated !== lastSentText
        ) {
          await editText(ctx, sentMessageId, accumulated);
          lastSentText = accumulated;
          lastEditAt = now;
        }
      }
      next = await stream.next();
    }
    const result = next.value;
    const finalText = result.text || accumulated;

    // Finalize text
    if (streaming && sentMessageId !== undefined) {
      if (finalText !== lastSentText) await editText(ctx, sentMessageId, finalText);
    } else if (finalText.trim().length > 0) {
      await ctx.reply(finalText, {
        ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
      });
    }

    // Media output sent as a follow-up message.
    if (result.imageBuffer || result.imageUrl) {
      const photo = result.imageBuffer ? new InputFile(result.imageBuffer) : result.imageUrl!;
      await ctx.replyWithPhoto(photo).catch((err) => log.warn({ err }, 'image send failed'));
    }

    // Persist user + bot messages.
    await services.conversation.addUserMessage(
      context.chatId,
      person.userHandle,
      result.transcribedUserMessage,
    );
    await services.conversation.addBotMessage(context.chatId, {
      messageText: finalText || null,
      timestamp: message.timestamp,
      imageDescription: result.imageUrl || result.imageBuffer ? 'generated image' : null,
      voiceDescription: null,
    });

    // Record usage.
    const points = result.usage.inputTokens + result.usage.outputTokens + result.imageCalls * 100;
    await services.usage.record({
      handle: person.userHandle,
      chatId: context.chatId,
      provider: services.llm.name,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedTokens: result.usage.estimated
        ? result.usage.inputTokens + result.usage.outputTokens
        : 0,
      imageCalls: result.imageCalls,
      transcriptionCalls: result.transcriptionCalls,
      visionCalls: result.visionCalls,
      points,
      costEstimate: 0,
    });

    // Media bookkeeping.
    if (result.imageCalls > 0) {
      await services.storage.media.record({
        chatId: context.chatId,
        handle: person.userHandle,
        direction: 'outbound',
        kind: 'image',
        description: 'generated image',
        ...(result.imageUrl ? { url: result.imageUrl } : {}),
      });
    }

    // Auto fact extraction (inline, when enabled).
    const autofact = await services.storage.chats.getAutoFact(context.chatId);
    if (autofact && finalText) {
      await services.reply.extractAndStoreFacts(
        context.chatId,
        person.userHandle,
        message.messageText,
        finalText,
      );
    }
  } catch (err) {
    log.error({ err }, 'reply generation failed');
    const localized = await localizeResponse(services, context.chatId, {
      text: 'generation_failed',
    });
    await sendResponse(ctx, localized).catch(() => undefined);
  }
}

async function editText(ctx: GrammyContext, messageId: number, text: string): Promise<void> {
  if (!ctx.chat) return;
  try {
    await ctx.api.editMessageText(ctx.chat.id, messageId, text);
  } catch (err) {
    // Telegram throws on identical content / rate limits — safe to ignore.
    log.debug({ err }, 'editMessageText ignored');
  }
}
