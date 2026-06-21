import { InputFile, type Context as GrammyContext } from 'grammy';
import type { ChatContext, IncomingMessage, Person } from '../../domain/types.js';
import type { Services } from '../../services/index.js';
import type { Env } from '../../config/env.js';
import type { AddMessageMeta } from '../../storage/repositories/messages.js';
import { termsKeyboard, termsHeader } from './shared.js';
import { localizeResponse, sendResponse, scheduleDelete } from '../render.js';
import { fingerprint } from '../../utils/text.js';
import { parseMusicRequest } from '../../services/musicIntent.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('message');

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface MessageDeps {
  services: Services;
  env: Env;
  botUsername: string;
}

/** Build message-storage metadata from the platform context. */
function metaOf(person: Person, context: ChatContext): AddMessageMeta {
  const meta: AddMessageMeta = {
    telegramId: person.telegramId,
    mentionedHandles: context.mentionedHandles ?? [],
  };
  if (context.messageId !== undefined) meta.messageId = context.messageId;
  if (context.repliedToMessageId !== undefined) meta.replyToMessageId = context.repliedToMessageId;
  if (context.repliedToUserHandle !== undefined) meta.replyToHandle = context.repliedToUserHandle;
  return meta;
}

/**
 * Core conversational handler - drives the brain pipeline.
 *
 * permission → started + tracking/mention gate → terms gate → autoengage decision →
 * (not engaging but tracking ⇒ store) → usage check → model route → brain reply →
 * send → persist user+bot → record usage → record bot reply + brain debug → mark memory used.
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

  if (!(await services.permissions.checkAll(['allowed_user', 'not_banned'], person, context))) {
    return;
  }

  const started = await services.conversation.isStarted(context.chatId);
  if (!started) return;
  const tracking = await services.conversation.isTrackingEnabled(context.chatId);
  const addressed = context.isBotMentioned || context.isReplyToBot;
  if (!tracking && !addressed) return;

  // terms gate
  if (await services.terms.hasDeclined(person.userHandle)) return;
  if (!(await services.terms.hasAccepted(person.userHandle))) {
    if (!addressed) return;
    const language = await services.getLanguage(context.chatId);
    const header = termsHeader();
    const localized = await localizeResponse(services, context.chatId, {
      text: 'terms_text',
      keyboard: termsKeyboard(services, language),
      ...(header ? { imageBuffer: header } : {}),
    });
    const sent = await sendResponse(ctx, localized);
    scheduleDelete(ctx, sent, 60_000); // personal prompt: self-destruct if not signed in 1 minute
    return;
  }

  const autoengageEnabled = await services.storage.chats.getAutoengage(context.chatId);
  const [history, mode, recentReplies] = await Promise.all([
    services.conversation.getRecent(context.chatId),
    services.modes.getActive(context.chatId),
    services.storage.botReplies.getRecent(context.chatId, 8),
  ]);
  const modeName = mode?.name ?? 'Default';
  const modeDescription = mode?.description ?? 'Partecipante naturale del gruppo.';
  const recentNegativeFeedback = recentReplies.some((r) => (r.feedbackScore ?? 0) < 0);

  const language = await services.getLanguage(context.chatId);

  // Transcribe incoming voice/audio/video up-front so its words feed scene/autoengage/storage/reply.
  const wasVoice = Boolean(message.audioBuffer);
  if (wasVoice && services.stt.enabled && message.audioBuffer) {
    const spoken = await services.media.transcribeVoice(
      message.audioBuffer,
      message.audioMime ?? 'audio/ogg',
      { language },
    );
    if (spoken) {
      message.messageText = message.messageText ? `${message.messageText} ${spoken}` : spoken;
      log.info({ chatId: context.chatId, chars: spoken.length }, 'media transcribed');
    } else {
      log.info(
        { chatId: context.chatId },
        'media transcription empty (muted / no speech / failed)',
      );
    }
    message.audioBuffer = undefined; // avoid re-transcription downstream
  }

  // If the user is replying to a voice/audio/video (e.g. "@bot trascrivi l'audio"), transcribe THAT
  // and inject it into the message so the reply can actually report/use it.
  const repliedMedia = message.repliedAudioBuffer ?? message.repliedVideoBuffer;
  if (repliedMedia && services.stt.enabled) {
    const spoken = await services.media.transcribeVoice(
      repliedMedia,
      message.repliedAudioMime ?? 'video/mp4',
      { language },
    );
    if (spoken) {
      message.messageText = `${message.messageText ? `${message.messageText}\n` : ''}[transcript of the replied audio/video]: ${spoken}`;
      log.info({ chatId: context.chatId, chars: spoken.length }, 'replied media transcribed');
    } else {
      log.info({ chatId: context.chatId }, 'replied media transcription empty (muted / no speech)');
    }
    message.repliedAudioBuffer = undefined; // consumed (keep repliedVideoBuffer for the vision frame)
  }

  // Link-media rehost: if the message has media URLs, download and re-upload them as Telegram
  // attachments. Unaddressed -> rehost and stop; addressed -> rehost + feed media context to the AI.
  // Honors the per-chat /linkmedia toggle (on by default).
  if (
    services.linkMedia.enabled &&
    message.messageText &&
    (await services.storage.chats.getLinkMedia(context.chatId))
  ) {
    const linkMedia = await services.linkMedia
      .handleMessage({ ctx, person, context, text: message.messageText, addressed })
      .catch((err) => {
        log.warn({ err }, 'link media handler failed');
        return { handled: false } as { handled: boolean; injectedText?: string };
      });

    if (linkMedia.injectedText) {
      message.messageText = `${message.messageText ? `${message.messageText}\n` : ''}[media context]: ${linkMedia.injectedText}`;
    }

    if (linkMedia.handled && !addressed) {
      await services.conversation.addUserMessage(
        context.chatId,
        person.userHandle,
        {
          messageText: message.messageText || null,
          timestamp: message.timestamp,
          imageDescription: linkMedia.injectedText ?? null,
          voiceDescription: null,
        },
        metaOf(person, context),
      );
      return;
    }
  }

  // Natural-language music request ("mi canti X", "suona X", "play X", "cántame X"): when the bot is
  // addressed, fetch the track from YouTube and reply with a voice note, bypassing the brain pipeline.
  if (addressed && services.music.enabled) {
    const songQuery = parseMusicRequest(message.messageText, botUsername);
    if (songQuery) {
      await ctx.replyWithChatAction('record_voice').catch(() => undefined);
      const result = await services.music.fetch(songQuery);
      const replyTo = ctx.message?.message_id;
      const replyOpts = replyTo ? { reply_parameters: { message_id: replyTo } } : {};
      if (result) {
        const caption = result.url
          ? `🎵 <a href="${result.url}">${escapeHtml(result.title)}</a>`
          : `🎵 ${escapeHtml(result.title)}`;
        await ctx
          .replyWithVoice(new InputFile(result.ogg), { ...replyOpts, caption, parse_mode: 'HTML' })
          .catch((err) => log.warn({ err }, 'music voice send failed'));
      } else {
        const localized = await localizeResponse(services, context.chatId, {
          text: 'music_not_found',
          vars: { query: songQuery },
        });
        await sendResponse(ctx, localized);
      }
      // keep the request in context so the conversation stays coherent
      await services.conversation.addUserMessage(
        context.chatId,
        person.userHandle,
        {
          messageText: message.messageText || null,
          timestamp: message.timestamp,
          imageDescription: null,
          voiceDescription: null,
        },
        metaOf(person, context),
      );
      return;
    }
  }

  const decision = await services.autoengage.decide(
    {
      person,
      context,
      currentMessage: message.messageText,
      modeName,
      modeDescription,
      history,
      userFacts: [],
      groupFacts: [],
      recentNegativeFeedback,
    },
    addressed,
    autoengageEnabled,
  );

  // not engaging → store as context (if tracking) and bail
  if (!decision.shouldReply) {
    if (tracking) {
      await services.conversation.addUserMessage(
        context.chatId,
        person.userHandle,
        {
          messageText: message.messageText || null,
          timestamp: message.timestamp,
          imageDescription: null,
          voiceDescription: null,
        },
        metaOf(person, context),
      );
    }
    log.debug({ chatId: context.chatId, reason: decision.reason }, 'not engaging');
    return;
  }

  // usage pre-check
  if (
    !(await services.usage.isUnderLimit(
      person.userHandle,
      message.messageText,
      Boolean(message.imageBuffer),
      Boolean(message.audioBuffer),
    ))
  ) {
    const limit = await services.usage.getLimit(person.userHandle);
    const localized = await localizeResponse(services, context.chatId, {
      text: 'usage_limit_exceeded',
      vars: { user_handle: person.userHandle, usage_limit: limit },
    });
    await sendResponse(ctx, localized);
    return;
  }

  // model routing (NSFW)
  const chatNsfwMode = await services.storage.chats.getNsfwMode(
    context.chatId,
    env.LLM_NSFW_DEFAULT_MODE,
  );
  const route = services.modelRouter.route({
    chatNsfwMode,
    modeNsfw: mode?.nsfw ?? false,
    messageText: message.messageText,
    contextText: history.map((h) => h.message.messageText ?? '').join(' '),
  });

  await ctx.replyWithChatAction('typing').catch(() => undefined);

  try {
    const outcome = await services.reply.generateReply({
      person,
      context,
      message,
      botUsername,
      language,
      modeName,
      modeDescription,
      nsfwEnabled: route.nsfw,
      model: route.model,
      allowRefusalFallback: route.allowRefusalFallback,
      nsfwModel: services.modelRouter.nsfwModel,
      recentBotReplies: recentReplies,
    });

    const finalText = outcome.text;
    const replyTo = ctx.message?.message_id;
    const replyOpts = replyTo ? { reply_parameters: { message_id: replyTo } } : {};
    let botMessageId: number | undefined;
    if (finalText.trim().length > 0) {
      const ttsCfg = services.config.voice.tts;
      const wantVoiceReply =
        services.tts.enabled &&
        finalText.length <= ttsCfg.maxChars &&
        ((wasVoice && ttsCfg.replyToVoice) || Math.random() < ttsCfg.autoVoiceProbability);
      let voiceSent = false;
      if (wantVoiceReply) {
        const ogg = await services.tts.synth(finalText, language);
        if (ogg) {
          const sent = await ctx.replyWithVoice(new InputFile(ogg), replyOpts);
          botMessageId = sent.message_id;
          voiceSent = true;
        }
      }
      if (!voiceSent) {
        const sent = await ctx.reply(finalText, replyOpts);
        botMessageId = sent.message_id;
      }
    }
    if (outcome.imageBuffer || outcome.imageUrl) {
      const photo = outcome.imageBuffer ? new InputFile(outcome.imageBuffer) : outcome.imageUrl!;
      await ctx.replyWithPhoto(photo).catch((err) => log.warn({ err }, 'image send failed'));
    }

    // persist user + bot messages (with ids for windows + mining)
    await services.conversation.addUserMessage(
      context.chatId,
      person.userHandle,
      outcome.transcribedUserMessage,
      metaOf(person, context),
    );
    await services.conversation.addBotMessage(
      context.chatId,
      {
        messageText: finalText || null,
        timestamp: message.timestamp,
        imageDescription: outcome.imageUrl || outcome.imageBuffer ? 'generated image' : null,
        voiceDescription: null,
      },
      botMessageId !== undefined ? { messageId: botMessageId } : {},
    );

    // record usage
    const points =
      outcome.usage.inputTokens + outcome.usage.outputTokens + outcome.imageCalls * 100;
    await services.usage.record({
      handle: person.userHandle,
      chatId: context.chatId,
      provider: services.llm.name,
      model: outcome.model,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      estimatedTokens: outcome.usage.estimated
        ? outcome.usage.inputTokens + outcome.usage.outputTokens
        : 0,
      imageCalls: outcome.imageCalls,
      transcriptionCalls: outcome.transcriptionCalls,
      visionCalls: outcome.visionCalls,
      points,
      costEstimate: 0,
    });

    // record bot reply (repetition guard + feedback) + brain debug + memory usage
    const reply: import('../../brain/types.js').BotReplyRecord = {
      chatId: context.chatId,
      text: finalText,
      normalizedText: finalText.toLowerCase().replace(/\s+/g, ' ').trim(),
      fingerprint: fingerprint(finalText),
      createdAt: new Date(),
      styleVariant: outcome.styleVariant,
      usedMemoryIds: outcome.usedMemoryIds,
      model: outcome.model,
    };
    if (botMessageId !== undefined) reply.messageId = botMessageId;
    await services.storage.botReplies.record(reply);

    if (env.BRAIN_DEBUG_ENABLED) {
      await services.storage.brainDebug
        .record({
          chatId: context.chatId,
          ...(context.messageId !== undefined ? { inputMessageId: context.messageId } : {}),
          createdAt: new Date(),
          scene: outcome.scene,
          retrievedMemories: outcome.retrieved.map((m) => ({
            id: m.item._id ?? '',
            text: m.item.text,
            relevance: m.relevance,
            reason: m.reason,
          })),
          plan: outcome.plan,
          styleVariant: outcome.styleVariant,
          candidates: outcome.candidates,
          ranked: outcome.ranked,
          repetitionChecks: outcome.repetitionChecks,
          finalText,
        })
        .catch((err) => log.debug({ err }, 'brain debug record failed'));
    }

    if (outcome.usedMemoryIds.length > 0) {
      await services.lore.markUsed(outcome.usedMemoryIds).catch(() => undefined);
    }
    if (outcome.imageCalls > 0) {
      await services.storage.media.record({
        chatId: context.chatId,
        handle: person.userHandle,
        direction: 'outbound',
        kind: 'image',
        description: 'generated image',
        ...(outcome.imageUrl ? { url: outcome.imageUrl } : {}),
      });
    }

    services.autoengage.noteReply(context.chatId, person.userHandle);
  } catch (err) {
    log.error({ err }, 'reply generation failed');
    const localized = await localizeResponse(services, context.chatId, {
      text: 'generation_failed',
    });
    await sendResponse(ctx, localized).catch(() => undefined);
  }
}
