import type { Api } from 'grammy';
import type { AnimeArchiveService } from '../anime/archive/service.js';
import type { Storage } from '../storage/index.js';
import type { Logger } from '../utils/logger.js';
import { renderTelegramText } from '../telegram/format.js';
import { buildInlineKeyboard } from '../telegram/keyboards.js';
import type { AnimeReleaseNotifier } from './animeReleaseJob.js';
import { animeArchiveSourceLabel } from '../anime/archive/types.js';

export interface AnimeReleaseNotifierDependencies {
  api: Pick<Api, 'sendMessage' | 'deleteMessage' | 'editMessageReplyMarkup'>;
  users: Pick<Storage['users'], 'getByHandle'>;
  animeArchive: Pick<
    AnimeArchiveService,
    'enabled' | 'prepareResolvedEpisodeOffer' | 'invalidateOffer' | 'replaceConfirmationMessage'
  >;
  log: Pick<Logger, 'warn' | 'debug'>;
}

/**
 * Build the durable release notifier used by the scheduler.
 *
 * Only the factual Telegram send controls the delivery result. The exact source episode has
 * already been resolved by the poller; identity lookup and the optional buttons run after that
 * durable boundary and therefore always degrade to `true`.
 */
export function createAnimeReleaseNotifier(
  dependencies: AnimeReleaseNotifierDependencies,
): AnimeReleaseNotifier {
  const { api, users, animeArchive, log } = dependencies;

  return async (notification) => {
    const { series, episode, archiveSeries, archiveEpisode } = notification;
    const lines = [
      `Nuovo episodio di *${series.title}*: episodio ${episode}.`,
      `Fonte: ${animeArchiveSourceLabel(archiveSeries.source)} — ${archiveEpisode.canonicalUrl}`,
      'Vuoi che te lo rehosti qui?',
    ];
    const rendered = renderTelegramText(lines.join('\n'), 'markdown');
    let sent: Awaited<ReturnType<typeof api.sendMessage>>;
    try {
      sent = await api.sendMessage(notification.chatId, rendered.text, {
        parse_mode: rendered.parseMode,
        ...(notification.threadId ? { message_thread_id: notification.threadId } : {}),
      });
    } catch (err) {
      log.warn(
        { err, chatId: notification.chatId, sourceId: series.sourceId, episode },
        'anime release notification send failed',
      );
      return false;
    }

    // The factual notice is durable now. Every optional write below is fail-open and can never
    // release the notification watermark or cause the same release to be announced twice.
    if (!animeArchive.enabled) return true;
    const requester = await users.getByHandle(notification.createdByHandle).catch((err) => {
      log.debug(
        { err, chatId: notification.chatId, sourceId: series.sourceId },
        'release archive requester lookup degraded',
      );
      return null;
    });
    if (!requester) return true;
    const prepared = await animeArchive
      .prepareResolvedEpisodeOffer({
        series: archiveSeries,
        episode: archiveEpisode,
        chatId: notification.chatId,
        threadId: notification.threadId,
        requesterTelegramId: requester.telegramId,
      })
      .catch((err) => {
        log.debug(
          { err, chatId: notification.chatId, sourceId: series.sourceId },
          'release archive action preparation degraded',
        );
        return null;
      });
    if (prepared?.status !== 'confirmation_required') return true;

    const availability = prepared;
    const previousMessageId = availability.offer.confirmationMessageId;
    try {
      await api.editMessageReplyMarkup(notification.chatId, sent.message_id, {
        reply_markup: buildInlineKeyboard(availability.keyboard),
      });
    } catch (err) {
      if (previousMessageId === null) {
        await animeArchive.invalidateOffer(availability.offer.id).catch(() => null);
      }
      log.debug(
        { err, chatId: notification.chatId, sourceId: series.sourceId },
        'release archive keyboard attach degraded',
      );
      return true;
    }
    const attachment = await animeArchive
      .replaceConfirmationMessage(availability.offer.id, sent.message_id)
      .catch((err) => {
        log.debug(
          { err, chatId: notification.chatId, sourceId: series.sourceId },
          'release archive prompt attach degraded',
        );
        return null;
      });
    if (!attachment) {
      await api
        .editMessageReplyMarkup(notification.chatId, sent.message_id, {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => undefined);
      if (previousMessageId === null) {
        await animeArchive.invalidateOffer(availability.offer.id).catch(() => null);
      }
      return true;
    }
    if (attachment.replacedMessageId !== null && attachment.replacedMessageId !== sent.message_id) {
      await api
        .deleteMessage(notification.chatId, attachment.replacedMessageId)
        .catch(() => undefined);
    }
    return true;
  };
}
