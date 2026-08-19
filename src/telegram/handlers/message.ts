import { InputFile, type Context as GrammyContext } from 'grammy';
import type { ChatContext, CommandResponse, IncomingMessage, Person } from '../../domain/types.js';
import type { Services } from '../../services/index.js';
import type { Env } from '../../config/env.js';
import type { AddMessageMeta } from '../../storage/repositories/messages.js';
import { termsKeyboard, termsHeader } from './shared.js';
import { localizeResponse, sendResponse, scheduleDelete } from '../render.js';
import { fingerprint, escapeHtml } from '../../utils/text.js';
import { Cooldown } from '../../utils/rateLimit.js';
import { childLogger } from '../../utils/logger.js';
import { classifyMessage } from '../../ambient/classifier.js';
import type { LinkMediaResult } from '../../services/linkMedia.js';
import { classifyExplicitSystemInfoRequest } from '../../services/systemInfo.js';
import { extractUrls, mediaUrlKey } from '../../providers/media/linkMedia/url.js';
import { extractJokePremises } from '../../brain/repetitionGuard.js';
import { currentLlmUsage } from '../../providers/llm/requestContext.js';
import {
  parseAnimeArchiveConfirmationDecision,
  type AnimeArchiveConfirmationResult,
  type AnimeArchivePreparationResult,
  type AnimeArchiveServiceRejectReason,
} from '../../anime/archive/service.js';
import {
  renderTelegramText,
  splitTelegramMarkdown,
  splitTelegramText,
  telegramPlainText,
} from '../format.js';
import { buildInlineKeyboard } from '../keyboards.js';

const log = childLogger('message');

// Rate-limit the "request approval" DM notice so a non-approved user cannot spam it out of the bot.
const dmInfoCooldown = new Cooldown(30 * 60 * 1000);

export { splitTelegramText };

export interface MessageDeps {
  services: Services;
  env: Env;
  botUsername: string;
}

/**
 * The deterministic link pipeline owns download success/failure. Conversation inference may run
 * only after a successful rehost (when addressed or passive replies are enabled); otherwise an
 * agent could mistake a merely resolved URL for a delivered Telegram media artifact.
 */
export function shouldStopAfterDeterministicLinkMedia(input: {
  handled: boolean;
  failedUrlCount: number;
  /** URLs found before entering the handler; remains trustworthy if the handler itself throws. */
  detectedUrlCount?: number;
  reason?: string;
  addressed: boolean;
  autoengageEnabled: boolean;
}): boolean {
  if (!input.handled && input.failedUrlCount > 0) return true;
  // A thrown handler cannot report its own attempted/failed URLs reliably. The caller still knows
  // whether it invoked the handler for a detected URL, so fail closed instead of letting an agent
  // describe a media artifact that was never delivered.
  if (!input.handled && input.reason === 'handler_error' && (input.detectedUrlCount ?? 0) > 0) {
    return true;
  }
  return input.handled && !input.addressed && !input.autoengageEnabled;
}

/** Preserve deterministic ownership of every detected URL when the rehost handler itself fails. */
export function linkMediaHandlerErrorResult(urls: readonly URL[]): LinkMediaResult {
  const attemptedUrls = [...new Set(urls.map(String))];
  return {
    handled: false,
    reason: 'handler_error',
    ...(attemptedUrls.length > 0 ? { attemptedUrls, failedUrls: attemptedUrls } : {}),
  };
}

/** Human-readable bounded-media durations without invoking the conversational model. */
export function formatMediaDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function durationLimitVars(result: LinkMediaResult): Record<string, string> | undefined {
  if (result.reason !== 'duration_exceeded' || !result.durationLimit) return undefined;
  return {
    duration: formatMediaDuration(result.durationLimit.durationSeconds),
    limit: formatMediaDuration(result.durationLimit.maxDurationSeconds),
  };
}

function mediaRehostFailureText(
  services: Services,
  result: LinkMediaResult,
  url: string,
  language: string,
): string {
  const durationVars = durationLimitVars(result);
  if (durationVars) {
    return (
      services.localizer.t('media_rehost_duration_exceeded', durationVars, language) ??
      `Rehost disabled: video ${durationVars['duration']}, limit ${durationVars['limit']}.`
    );
  }
  return services.localizer.t('media_rehost_failed', { url }, language) ?? url;
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
  const addressed = !context.isGroup || context.isBotMentioned || context.isReplyToBot;
  const mediaUrls = message.messageText
    ? extractUrls(message.messageText, services.config.linkMedia.maxUrlsPerMessage)
    : [];
  // Keep lightweight diagnostic/test consumers that supply a partial Services facade inert.
  // Production always wires this service through createServices().
  const animeArchive = services.animeArchive;
  const archiveMatches = message.messageText
    ? (animeArchive?.classifyText(message.messageText) ?? [])
    : [];
  // Archive sources must never fall through to the generic short-form downloader. In mixed
  // messages we pass only the unrelated URLs to LinkMediaService, whose limits remain unchanged.
  const genericMediaUrls = mediaUrls.filter(
    (url) => !animeArchive || animeArchive.classifyUrl(url) === null,
  );
  const linkMediaAllowed =
    services.linkMedia.enabled && (await services.storage.chats.getLinkMedia(context.chatId));
  const linkMediaEnabled =
    linkMediaAllowed && services.linkMedia.autoRehostEnabled && genericMediaUrls.length > 0;
  const hasMediaUrl = linkMediaEnabled;
  const hasArchiveInteraction =
    Boolean(animeArchive) &&
    (archiveMatches.length > 0 ||
      parseAnimeArchiveConfirmationDecision(message.messageText ?? '') !== null);
  // Link rehosting is an independent per-chat feature: disabling conversation storage must not
  // disable the interceptor. Messages with neither an address nor a rehostable URL can stop here.
  if (!tracking && !addressed && !linkMediaEnabled && !hasArchiveInteraction) return;
  // Passive inference is an explicit per-chat opt-in. Without it, unaddressed traffic is stored
  // only as context and costs neither a model request nor a group quota turn.
  const autoengageEnabled =
    !addressed && tracking && (await services.storage.chats.getAutoengage(context.chatId));

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

  // approval gate: the model only talks to admins, approved users, or approved community chats.
  // Non-approved DMs get the "request approval" notice (rate-limited); non-approved groups stay silent.
  if (!services.isApproved(person, context)) {
    if (!context.isGroup && addressed && dmInfoCooldown.tryAcquire(person.userHandle)) {
      const localized = await localizeResponse(services, context.chatId, {
        text: 'dm_info',
        vars: { admin_handle: services.adminContact() },
      });
      await sendResponse(ctx, localized);
    }
    return;
  }

  const bypassGroupPlan = services.bypassesGroupPlan(person, context);

  // Anime source URLs and terse SI/NO confirmations are deterministic writes. They run before the
  // generic 180-second link-media interceptor and before any conversational/LLM accounting.
  if (message.messageText) {
    const archiveHandled = await handleAnimeArchiveInteraction(
      ctx,
      person,
      context,
      message.messageText,
      {
        services,
        archiveMatches,
        quotaBypass: bypassGroupPlan,
      },
    ).catch(async (err) => {
      log.warn({ err, chatId: context.chatId }, 'anime archive interaction failed');
      await sendResponse(ctx, {
        text: 'Non riesco ad avviare l’archivio in questo momento.',
        textFormat: 'plain',
      }).catch(() => undefined);
      return true;
    });
    const hasNonArchiveUrl = genericMediaUrls.length > 0;
    if (archiveHandled && !hasNonArchiveUrl) return;
  }

  // Host/model/quota inspection is a deterministic, allowlisted action. It is available only when
  // an approved user explicitly addresses the bot, and exits before history, RAG, LLM admission or
  // media quota. Do not persist the live report into conversational context.
  if (
    mediaUrls.length === 0 &&
    message.messageText &&
    !message.imageBuffer &&
    !message.audioBuffer
  ) {
    const systemRequest = classifyExplicitSystemInfoRequest(message.messageText, addressed);
    if (systemRequest.explicit) {
      const report = await services.systemInfo.report({
        chatId: context.chatId,
        scopes: systemRequest.scopes,
        operatorSession: bypassGroupPlan,
      });
      const replyTo = ctx.message?.message_id;
      await ctx.reply(report, replyTo ? { reply_parameters: { message_id: replyTo } } : {});
      log.info(
        { chatId: context.chatId, scopes: systemRequest.scopes },
        'explicit system information action served',
      );
      return;
    }
  }

  // Passive group traffic is retained as lightweight conversation context unless this specific
  // chat has opted into autoengage. That keeps background traffic free by default.
  if (!addressed && !autoengageEnabled && !hasMediaUrl) {
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
    log.debug({ chatId: context.chatId }, 'passive message stored without inference');
    return;
  }

  const [history, mode, recentGlobalReplies, recentPersonalReplies] = await Promise.all([
    services.conversation.getRecent(context.chatId),
    services.modes.getActive(context.chatId),
    services.storage.botReplies.getRecent(context.chatId, 10),
    services.storage.botReplies.getRecentFor(context.chatId, person.userHandle, 8),
  ]);
  const recentReplies = [...recentPersonalReplies, ...recentGlobalReplies]
    .filter(
      (reply, index, all) =>
        all.findIndex(
          (candidate) =>
            (reply._id && candidate._id === reply._id) ||
            (candidate.messageId === reply.messageId &&
              candidate.createdAt.getTime() === reply.createdAt.getTime()),
        ) === index,
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 14);
  const modeName = mode?.name ?? 'Default';
  const modeDescription = mode?.description ?? 'Natural group participant.';
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
  let initialLinkMedia: LinkMediaResult | undefined;
  let initialFailureNoticeMessageId: number | undefined;
  if (linkMediaEnabled && message.messageText) {
    initialLinkMedia = await services.linkMedia
      .handleMessage({
        ctx,
        person,
        context,
        text: genericMediaUrls.map(String).join('\n'),
        addressed,
        quotaBypass: bypassGroupPlan,
      })
      .catch((err) => {
        log.warn({ err }, 'link media handler failed');
        return linkMediaHandlerErrorResult(genericMediaUrls);
      });
    const linkMedia = initialLinkMedia;

    if (!linkMedia.handled && linkMedia.reason && linkMedia.reason !== 'no_supported_url') {
      log.info(
        { chatId: context.chatId, reason: linkMedia.reason },
        'link media did not rehost a detected URL',
      );
    }

    if ((linkMedia.failedUrls?.length ?? 0) > 0) {
      const durationVars = durationLimitVars(linkMedia);
      const notice = await localizeResponse(services, context.chatId, {
        text: durationVars ? 'media_rehost_duration_exceeded' : 'media_rehost_auto_failed',
        ...(durationVars ? { vars: durationVars } : {}),
      });
      initialFailureNoticeMessageId = (await sendResponse(ctx, notice))?.message_id;
    }

    if (linkMedia.injectedText) {
      message.messageText = `${message.messageText ? `${message.messageText}\n` : ''}[media context]: ${linkMedia.injectedText}`;
    }

    if (
      shouldStopAfterDeterministicLinkMedia({
        handled: linkMedia.handled,
        failedUrlCount: linkMedia.failedUrls?.length ?? 0,
        detectedUrlCount: genericMediaUrls.length,
        reason: linkMedia.reason,
        addressed,
        autoengageEnabled,
      })
    ) {
      if (tracking) {
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
      }
      return;
    }
  }

  // A passive URL may fail to rehost (for example a social site demanding cookies). It must not
  // then fall through into the evaluator unless this chat explicitly enabled autoengage.
  if (!addressed && !autoengageEnabled) {
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
    return;
  }

  if (!addressed && !bypassGroupPlan && !(await services.quota.canPassiveReply(context.chatId))) {
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
    log.debug({ chatId: context.chatId }, 'passive quota exhausted before LLM scoring');
    return;
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
      // One regex pass: the bot is a little readier to jump in when it recognises the subject
      // than when it would just be interrupting. Gated on the same config as recall itself, so
      // disabling ambient recall also removes its influence on when the bot speaks.
      knownTopic:
        services.config.ambient.enabled &&
        classifyMessage(message.messageText ?? '', {
          minScore: services.config.ambient.minDomainScore,
          maxDomains: services.config.ambient.maxDomains,
        }).domains.length > 0,
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

  const quota = bypassGroupPlan
    ? { allowed: true, tokenReservation: 0 }
    : await services.quota.admitConversation({
        chatId: context.chatId,
        telegramId: person.telegramId,
        passive: !addressed,
      });
  if (!quota.allowed) {
    if (addressed) {
      const localized = await localizeResponse(services, context.chatId, {
        text: 'group_quota_exceeded',
        vars: { reason: quota.reason ?? 'limit', retry_after: quota.retryAfterSeconds ?? 0 },
      });
      await sendResponse(ctx, localized);
    }
    return;
  }

  // Model routing (NSFW) followed by plan policy. Free is pinned to the economy model and cannot
  // escalate to a separate refusal fallback model.
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
  const plan = await services.planForTurn(person, context);
  const model = services.modelForPlan(plan, route.model);
  const freePlan = services.isFreePlan(plan);

  await ctx.replyWithChatAction('typing').catch(() => undefined);

  let pendingNaturalOfferId: string | undefined;
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
      allowVision: !freePlan,
      model,
      ...(freePlan ? { internalModel: model } : {}),
      allowRefusalFallback: freePlan ? false : route.allowRefusalFallback,
      nsfwModel: freePlan ? undefined : services.modelRouter.nsfwModel,
      recentBotReplies: recentReplies,
      quotaBypass: bypassGroupPlan,
      passive: !addressed,
      allowLinkMedia: linkMediaAllowed,
      allowCapabilityInstall: services.permissions.isBotAdmin(person.userHandle),
    });
    const meteredUsage = currentLlmUsage();
    if (meteredUsage?.calls) {
      outcome.usage = {
        inputTokens: meteredUsage.inputTokens,
        outputTokens: meteredUsage.outputTokens,
        estimated: meteredUsage.estimated,
      };
    }

    if (outcome.suppressed) {
      await services.conversation.addUserMessage(
        context.chatId,
        person.userHandle,
        outcome.transcribedUserMessage,
        metaOf(person, context),
      );
      if (env.BRAIN_DEBUG_ENABLED) {
        await services.storage.brainDebug
          .record({
            chatId: context.chatId,
            ...(context.messageId !== undefined ? { inputMessageId: context.messageId } : {}),
            createdAt: new Date(),
            scene: outcome.scene,
            evaluation: outcome.evaluation,
            ...(outcome.cortex ? { cortex: outcome.cortex } : {}),
            providerSources: outcome.providerBundle.sources,
            providerBundle: outcome.providerBundle,
            ...(outcome.providerBundle.threadContext
              ? { threadContext: outcome.providerBundle.threadContext }
              : {}),
            retrievedMemories: [],
            plan: outcome.plan,
            styleVariant: outcome.styleVariant,
            candidates: [],
            ranked: [],
            repetitionChecks: [],
            finalText: '',
          })
          .catch((err) => log.debug({ err }, 'suppressed brain debug record failed'));
      }
      if (!bypassGroupPlan) {
        await services.quota.recordLlmTokens(
          context.chatId,
          outcome.usage.inputTokens + outcome.usage.outputTokens,
          quota.tokenReservation ?? 0,
        );
      }
      log.debug(
        { chatId: context.chatId, reason: outcome.evaluation.reason },
        'reply suppressed by evaluator',
      );
      return;
    }

    let naturalArchiveOffer:
      | Extract<AnimeArchivePreparationResult, { status: 'confirmation_required' }>
      | undefined;
    const archiveQueries = [
      ...new Set(outcome.animeArchiveLookup?.titles.map((title) => title.trim()).filter(Boolean)),
    ].slice(0, 3);
    if (archiveQueries.length > 0 && services.animeArchive.enabled) {
      const availabilitySignal = AbortSignal.timeout(7_000);
      for (const query of archiveQueries) {
        const availability = await services.animeArchive
          .prepareNaturalEpisodeOffer({
            query,
            ...(outcome.animeArchiveLookup?.episodeNumber !== undefined
              ? { expectedEpisodeNumber: outcome.animeArchiveLookup.episodeNumber }
              : {}),
            chatId: context.chatId,
            threadId: context.threadId,
            replyToMessageId: context.messageId,
            requesterTelegramId: person.telegramId,
            quotaBypass: bypassGroupPlan,
            signal: availabilitySignal,
          })
          .catch((err) => {
            log.debug({ err, chatId: context.chatId }, 'anime archive availability degraded');
            return null;
          });
        if (availability?.status === 'confirmation_required') {
          naturalArchiveOffer = availability;
          // Only a newly-created, not-yet-delivered offer belongs to this turn. An equivalent
          // offer may already back a visible prompt; a later failure while sending the factual
          // answer must not invalidate that existing prompt.
          pendingNaturalOfferId =
            availability.offer.confirmationMessageId === null ? availability.offer.id : undefined;
          break;
        }
        if (availabilitySignal.aborted) break;
      }
    }
    const finalText = outcome.text;
    const replyTo = ctx.message?.message_id;
    const replyOpts = replyTo ? { reply_parameters: { message_id: replyTo } } : {};
    let botMessageId: number | undefined;
    const botMessageIds: number[] = [];
    const rememberBotMessage = (messageId: number): void => {
      if (!botMessageIds.includes(messageId)) botMessageIds.push(messageId);
      botMessageId ??= messageId;
    };
    for (const messageId of initialLinkMedia?.messageIds ?? []) rememberBotMessage(messageId);
    if (initialFailureNoticeMessageId !== undefined)
      rememberBotMessage(initialFailureNoticeMessageId);
    if (finalText.trim().length > 0) {
      log.info(
        {
          chatId: context.chatId,
          messageId: context.messageId,
          model: outcome.model,
          chars: finalText.length,
          lines: finalText.split(/\r?\n/).length,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          estimatedUsage: outcome.usage.estimated,
          styleVariant: outcome.styleVariant,
          action: outcome.evaluation.action,
          tail: finalText.replace(/\s+/g, ' ').trim().slice(-180),
        },
        'sending final text reply',
      );
    }
    const hasExplicitArtifact = Boolean(
      outcome.music ||
      outcome.linkMediaUrl ||
      outcome.audioBuffer ||
      outcome.imageBuffer ||
      outcome.imageUrl ||
      outcome.videoBuffer,
    );
    if (finalText.trim().length > 0) {
      const ttsCfg = services.config.voice.tts;
      const wantVoiceReply =
        !hasExplicitArtifact &&
        services.tts.enabled &&
        finalText.length <= ttsCfg.maxChars &&
        ((wasVoice && ttsCfg.replyToVoice) || Math.random() < ttsCfg.autoVoiceProbability);
      let voiceSent = false;
      if (wantVoiceReply) {
        const ogg = await services.tts.synth(finalText, language);
        if (ogg) {
          const sent = await ctx.replyWithVoice(new InputFile(ogg), replyOpts);
          rememberBotMessage(sent.message_id);
          voiceSent = true;
        }
      }
      if (!voiceSent) {
        const chunks = splitTelegramMarkdown(finalText);
        for (const [index, chunk] of chunks.entries()) {
          const rendered = renderTelegramText(chunk, 'markdown');
          const options = {
            ...(index === 0 ? replyOpts : {}),
            parse_mode: rendered.parseMode,
          };
          const sent = await ctx.reply(rendered.text, options).catch(async (err) => {
            log.warn({ err, chatId: context.chatId, index }, 'formatted text send failed');
            return ctx.reply(telegramPlainText(chunk, 'markdown'), {
              ...(index === 0 ? replyOpts : {}),
            });
          });
          rememberBotMessage(sent.message_id);
        }
        log.info(
          {
            chatId: context.chatId,
            inputMessageId: context.messageId,
            botMessageId,
            chars: finalText.length,
            chunks: chunks.length,
          },
          'text reply sent',
        );
      }
    }
    if (naturalArchiveOffer) {
      const previousMessageId = naturalArchiveOffer.offer.confirmationMessageId;
      const prompt = await ctx
        .reply('Vuoi che te lo rehosti qui?', {
          ...replyOpts,
          reply_markup: buildInlineKeyboard(naturalArchiveOffer.keyboard),
        })
        .catch(async (err) => {
          log.warn({ err, chatId: context.chatId }, 'natural anime archive prompt send failed');
          if (previousMessageId === null) {
            await services.animeArchive
              .invalidateOffer(naturalArchiveOffer.offer.id)
              .catch(() => undefined);
          }
          return null;
        });
      if (prompt) {
        const attachment = await services.animeArchive
          .replaceConfirmationMessage(naturalArchiveOffer.offer.id, prompt.message_id)
          .catch((err) => {
            log.warn({ err }, 'natural anime archive confirmation message attach failed');
            return null;
          });
        if (attachment) {
          pendingNaturalOfferId = undefined;
          rememberBotMessage(prompt.message_id);
          if (
            attachment.replacedMessageId !== null &&
            attachment.replacedMessageId !== prompt.message_id
          ) {
            await ctx.api
              .deleteMessage(context.chatId, attachment.replacedMessageId)
              .catch(() => undefined);
          }
        } else {
          await ctx.api.deleteMessage(context.chatId, prompt.message_id).catch(() => undefined);
          if (previousMessageId === null) {
            await services.animeArchive
              .invalidateOffer(naturalArchiveOffer.offer.id)
              .catch(() => undefined);
          }
        }
      }
      // Either this prompt is attached, the previous equivalent prompt remains attached, or the
      // new undelivered offer has been invalidated. The outer failure guard need not touch it.
      pendingNaturalOfferId = undefined;
    }
    if (outcome.music) {
      const replyToMusic = ctx.message?.message_id;
      const musicReplyOpts = replyToMusic ? { reply_parameters: { message_id: replyToMusic } } : {};
      const captionHead = outcome.music.url
        ? `🎵 <a href="${outcome.music.url}">${escapeHtml(outcome.music.title)}</a>`
        : `🎵 ${escapeHtml(outcome.music.title)}`;
      const captionTail = outcome.music.truncated
        ? `\n(taglio ai primi ${Math.round(services.config.music.maxDurationSeconds / 60)} min)`
        : '';
      const sent = await ctx
        .replyWithVoice(new InputFile(outcome.music.ogg), {
          ...musicReplyOpts,
          caption: captionHead + captionTail,
          parse_mode: 'HTML',
        })
        .catch((err) => {
          log.warn({ err }, 'music voice send failed');
          return null;
        });
      if (sent) rememberBotMessage(sent.message_id);
    }
    const alreadyRehosted =
      outcome.linkMediaUrl !== undefined &&
      (initialLinkMedia?.handledUrls ?? []).some((url) => sameUrl(url, outcome.linkMediaUrl!));
    const alreadyAttempted =
      outcome.linkMediaUrl !== undefined &&
      (initialLinkMedia?.attemptedUrls ?? []).some((url) => sameUrl(url, outcome.linkMediaUrl!));
    if (outcome.linkMediaUrl && !alreadyAttempted) {
      const sent = await services.linkMedia.rehostUrl({
        ctx,
        context,
        url: outcome.linkMediaUrl,
        addressed: true,
        quotaBypass: bypassGroupPlan,
      });
      for (const messageId of sent.messageIds ?? []) rememberBotMessage(messageId);
      if (!sent.handled) {
        const fallback = await ctx.reply(
          mediaRehostFailureText(services, sent, outcome.linkMediaUrl, language),
          replyOpts,
        );
        rememberBotMessage(fallback.message_id);
      }
    } else if (
      outcome.linkMediaUrl &&
      alreadyAttempted &&
      !alreadyRehosted &&
      initialFailureNoticeMessageId === undefined
    ) {
      const fallback = await ctx.reply(
        mediaRehostFailureText(
          services,
          initialLinkMedia ?? { handled: false },
          outcome.linkMediaUrl,
          language,
        ),
        replyOpts,
      );
      rememberBotMessage(fallback.message_id);
    }
    if (outcome.audioBuffer) {
      const sent = await ctx
        .replyWithVoice(new InputFile(outcome.audioBuffer), replyOpts)
        .catch((err) => {
          log.warn({ err }, 'generated voice send failed');
          return null;
        });
      if (sent) rememberBotMessage(sent.message_id);
    }
    if (outcome.imageBuffer || outcome.imageUrl) {
      const photo = outcome.imageBuffer ? new InputFile(outcome.imageBuffer) : outcome.imageUrl!;
      const imageOptions = outcome.imageSpoiler ? { has_spoiler: true } : {};
      const sent = await ctx.replyWithPhoto(photo, imageOptions).catch((err) => {
        log.warn({ err }, 'image send failed');
        return null;
      });
      if (sent) rememberBotMessage(sent.message_id);
    }
    if (outcome.videoBuffer) {
      // supports_streaming + poster => inline autoplaying clip instead of a downloadable file
      const meta = outcome.videoMeta ?? {};
      const sent = await ctx
        .replyWithVideo(new InputFile(outcome.videoBuffer), {
          supports_streaming: true,
          ...(outcome.videoSpoiler ? { has_spoiler: true } : {}),
          ...(typeof meta.width === 'number' ? { width: meta.width } : {}),
          ...(typeof meta.height === 'number' ? { height: meta.height } : {}),
          ...(typeof meta.duration === 'number' ? { duration: meta.duration } : {}),
          ...(meta.thumbnail ? { thumbnail: new InputFile(meta.thumbnail) } : {}),
        })
        .catch((err) => {
          log.warn({ err }, 'generated video send failed');
          return null;
        });
      if (sent) rememberBotMessage(sent.message_id);
    }
    await Promise.all(
      botMessageIds.map((messageId) =>
        services.threadTracker
          .attachMessage(context.chatId, outcome.threadState?.currentThread?.threadId, messageId)
          .catch((err) => log.debug({ err }, 'thread bot-message attach failed')),
      ),
    );

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
        voiceDescription: outcome.music
          ? outcome.music.title
          : outcome.linkMediaUrl
            ? 'downloaded media'
            : outcome.audioBuffer
              ? 'voice note'
              : null,
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
    if (!bypassGroupPlan) {
      await services.quota.recordLlmTokens(
        context.chatId,
        outcome.usage.inputTokens + outcome.usage.outputTokens,
        quota.tokenReservation ?? 0,
      );
    }

    // record bot reply (repetition guard + feedback) + brain debug + memory usage
    const reply: import('../../brain/types.js').BotReplyRecord = {
      chatId: context.chatId,
      recipientHandle: person.userHandle,
      text: finalText,
      normalizedText: finalText.toLowerCase().replace(/\s+/g, ' ').trim(),
      fingerprint: fingerprint(finalText),
      createdAt: new Date(),
      styleVariant: outcome.styleVariant,
      ...(outcome.plan.comedyStrategy ? { comedyStrategy: outcome.plan.comedyStrategy } : {}),
      jokePremises: extractJokePremises(finalText),
      ...(outcome.plan.socialSignal?.situation
        ? { socialSituation: outcome.plan.socialSignal.situation }
        : {}),
      usedMemoryIds: outcome.usedMemoryIds,
      model: outcome.model,
    };
    if (botMessageId !== undefined) reply.messageId = botMessageId;
    if (botMessageIds.length > 0) reply.messageIds = botMessageIds;
    await services.storage.botReplies.record(reply);

    if (env.BRAIN_DEBUG_ENABLED) {
      await services.storage.brainDebug
        .record({
          chatId: context.chatId,
          ...(context.messageId !== undefined ? { inputMessageId: context.messageId } : {}),
          createdAt: new Date(),
          scene: outcome.scene,
          evaluation: outcome.evaluation,
          ...(outcome.cortex ? { cortex: outcome.cortex } : {}),
          providerSources: outcome.providerBundle.sources,
          providerBundle: outcome.providerBundle,
          ...(outcome.providerBundle.threadContext
            ? { threadContext: outcome.providerBundle.threadContext }
            : {}),
          retrievedMemories: outcome.retrieved.map((m) => ({
            id: m.item._id ?? '',
            text: m.item.text,
            relevance: m.relevance,
            reason: m.reason,
            ...(m.cosineScore !== undefined ? { cosineScore: m.cosineScore } : {}),
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
    if (pendingNaturalOfferId) {
      await services.animeArchive.invalidateOffer(pendingNaturalOfferId).catch(() => undefined);
    }
    log.error({ err }, 'reply generation failed');
    const localized = await localizeResponse(services, context.chatId, {
      text: 'generation_failed',
    });
    await sendResponse(ctx, localized).catch(() => undefined);
  }
}

function sameUrl(left: string, right: string): boolean {
  const a = mediaUrlKey(left);
  const b = mediaUrlKey(right);
  return a && b ? a === b : left === right;
}

async function handleAnimeArchiveInteraction(
  ctx: GrammyContext,
  person: Person,
  context: ChatContext,
  text: string,
  input: {
    services: Services;
    archiveMatches: ReturnType<Services['animeArchive']['classifyText']>;
    quotaBypass: boolean;
  },
): Promise<boolean> {
  const { services } = input;
  const decision = parseAnimeArchiveConfirmationDecision(text);
  if (decision) {
    const result = await services.animeArchive.confirmText({
      text,
      actorTelegramId: person.telegramId,
      chatId: context.chatId,
      threadId: context.threadId,
      replyToMessageId: context.repliedToMessageId,
      isAdmin: services.isAnimeArchiveAdmin(person, context),
      quotaBypass: input.quotaBypass,
      signal: AbortSignal.timeout(20_000),
    });
    // A casual "sì" with no pending prompt remains ordinary conversation.
    if (result.status === 'rejected' && result.reason === 'not_found') return false;
    const consumedOffer =
      result.status === 'cancelled'
        ? result.offer
        : result.status === 'queued'
          ? result.offer
          : undefined;
    const confirmationMessageId = consumedOffer?.confirmationMessageId;
    if (confirmationMessageId) {
      // Text confirmations should retire the same short prompt a button callback would delete.
      await ctx.api.deleteMessage(context.chatId, confirmationMessageId).catch(() => undefined);
    }
    await sendArchiveResult(ctx, services, result);
    return true;
  }

  if (input.archiveMatches.length === 0) return false;
  for (const match of input.archiveMatches) {
    const result = await services.animeArchive.prepareUrl({
      url: match.url,
      chatId: context.chatId,
      threadId: context.threadId,
      replyToMessageId: context.messageId,
      requesterTelegramId: person.telegramId,
      isAdmin: services.isAnimeArchiveAdmin(person, context),
      quotaBypass: input.quotaBypass,
      signal: AbortSignal.timeout(20_000),
    });
    await sendArchiveResult(ctx, services, result);
  }
  return true;
}

async function sendArchiveResult(
  ctx: GrammyContext,
  services: Services,
  result: AnimeArchivePreparationResult | AnimeArchiveConfirmationResult,
): Promise<void> {
  const response = archiveResultResponse(result);
  if (result.status !== 'confirmation_required') {
    await sendResponse(ctx, await localizeResponse(services, ctx.chat?.id ?? 0, response));
    return;
  }

  const previousMessageId = result.offer.confirmationMessageId;
  let sent: Awaited<ReturnType<typeof sendResponse>>;
  try {
    sent = await sendResponse(ctx, await localizeResponse(services, ctx.chat?.id ?? 0, response));
  } catch (error) {
    if (previousMessageId === null) {
      await services.animeArchive.invalidateOffer(result.offer.id).catch(() => undefined);
    }
    throw error;
  }
  if (!sent) {
    if (previousMessageId === null) {
      await services.animeArchive.invalidateOffer(result.offer.id).catch(() => undefined);
    }
    throw new Error('Anime archive confirmation prompt was not delivered');
  }
  const attachment = await services.animeArchive
    .replaceConfirmationMessage(result.offer.id, sent.message_id)
    .catch((err) => {
      log.warn({ err }, 'anime archive confirmation message attach failed');
      return null;
    });
  if (!attachment) {
    await ctx.api.deleteMessage(ctx.chat?.id ?? 0, sent.message_id).catch(() => undefined);
    if (previousMessageId === null) {
      await services.animeArchive.invalidateOffer(result.offer.id).catch(() => undefined);
    }
    throw new Error('Anime archive confirmation prompt could not be attached');
  }
  if (attachment.replacedMessageId !== null && attachment.replacedMessageId !== sent.message_id) {
    await ctx.api
      .deleteMessage(ctx.chat?.id ?? 0, attachment.replacedMessageId)
      .catch(() => undefined);
  }
}

export function archiveResultResponse(
  result: AnimeArchivePreparationResult | AnimeArchiveConfirmationResult,
): CommandResponse {
  if (result.status === 'queued') {
    return {
      rawText:
        result.created || result.changed
          ? result.job.episodes.length === 1
            ? 'Episodio in coda. Lo preparo per il telefono e te lo mando qui appena è pronto.'
            : `Serie in coda: ${result.job.episodes.length} episodi, rigorosamente uno alla volta.`
          : 'Questa richiesta è già stata presa in carico.',
      textFormat: 'plain',
    };
  }
  if (result.status === 'confirmation_required') {
    return {
      rawText: 'Vuoi scaricare e rehostare l’intero anime su telegram?',
      textFormat: 'plain',
      keyboard: result.keyboard,
    };
  }
  if (result.status === 'cancelled') {
    return { rawText: 'Va bene, richiesta annullata.', textFormat: 'plain' };
  }
  return { rawText: archiveRejectText(result.reason), textFormat: 'plain' };
}

function archiveRejectText(reason: AnimeArchiveServiceRejectReason): string {
  switch (reason) {
    case 'admin_required':
      return 'La serie completa può essere archiviata solo da un vero amministratore.';
    case 'bulk_disabled':
      return 'L’archivio delle serie complete è disabilitato.';
    case 'nsfw_disabled':
      return 'Questa sorgente è bloccata dalla policy NSFW del media layer.';
    case 'quota_denied':
      return 'La quota media della chat è esaurita; riprova più tardi.';
    case 'source_unavailable':
    case 'no_episodes':
      return 'La sorgente non espone episodi utilizzabili in questo momento.';
    case 'ambiguous_confirmation':
      return 'Ci sono più conferme aperte: rispondi direttamente al messaggio giusto.';
    case 'expired':
      return 'Questa conferma è scaduta.';
    case 'already_consumed':
      return 'Questa conferma è già stata usata.';
    case 'disabled':
      return 'L’archivio anime non è disponibile in questo momento.';
    default:
      return 'Richiesta di archivio non valida per questo utente, chat o argomento.';
  }
}
