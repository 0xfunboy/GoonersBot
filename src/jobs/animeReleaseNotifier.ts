import type { Api } from 'grammy';
import type { AnimeArchiveService } from '../anime/archive/service.js';
import type { Storage } from '../storage/index.js';
import type { Logger } from '../utils/logger.js';
import { renderTelegramText } from '../telegram/format.js';
import { buildInlineKeyboard } from '../telegram/keyboards.js';
import type { AnimeReleaseNotifier } from './animeReleaseJob.js';

export interface AnimeReleaseNotifierDependencies {
  api: Pick<Api, 'sendMessage' | 'deleteMessage'>;
  users: Pick<Storage['users'], 'getByHandle'>;
  animeArchive: Pick<
    AnimeArchiveService,
    'enabled' | 'prepareNaturalEpisodeOffer' | 'invalidateOffer' | 'replaceConfirmationMessage'
  >;
  log: Pick<Logger, 'warn' | 'debug'>;
}

/**
 * Build the durable release notifier used by the scheduler.
 *
 * Only the factual Telegram send controls the delivery result. Archive availability and its
 * optional prompt run after that durable boundary and therefore always degrade to `true`.
 */
export function createAnimeReleaseNotifier(
  dependencies: AnimeReleaseNotifierDependencies,
): AnimeReleaseNotifier {
  const { api, users, animeArchive, log } = dependencies;

  return async (notification) => {
    const { series, episode } = notification;
    const lines = [`Nuovo episodio di *${series.title}*: episodio ${episode}.`, series.url];
    const legal = series.streamingLinks[0];
    if (legal) lines.push(`Disponibile su ${legal.site}: ${legal.url}`);
    const rendered = renderTelegramText(lines.join('\n'), 'markdown');
    try {
      await api.sendMessage(notification.chatId, rendered.text, {
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

    // The release notice is already durable at this point. Availability is an optional second
    // message: a source/attachment failure must never roll back the watermark and duplicate the
    // factual notification on the next poll.
    try {
      const requester = animeArchive.enabled
        ? await users.getByHandle(notification.createdByHandle)
        : null;
      if (!requester) return true;
      const availabilitySignal = AbortSignal.timeout(7_000);
      const queries = [
        ...new Set(
          [
            series.title,
            series.titleEnglish,
            series.titleRomaji,
            series.titleNative,
            ...series.aliases,
          ].filter((title): title is string => Boolean(title?.trim())),
        ),
      ].slice(0, 3);
      for (const query of queries) {
        const availability = await animeArchive
          .prepareNaturalEpisodeOffer({
            query,
            expectedEpisodeNumber: episode,
            chatId: notification.chatId,
            threadId: notification.threadId,
            requesterTelegramId: requester.telegramId,
            signal: availabilitySignal,
          })
          .catch((err) => {
            log.debug(
              { err, chatId: notification.chatId, sourceId: series.sourceId },
              'release archive availability degraded',
            );
            return null;
          });
        if (availability?.status !== 'confirmation_required') {
          if (availabilitySignal.aborted) break;
          continue;
        }

        const previousMessageId = availability.offer.confirmationMessageId;
        const prompt = await api
          .sendMessage(notification.chatId, 'Vuoi che te lo rehosti qui?', {
            ...(notification.threadId ? { message_thread_id: notification.threadId } : {}),
            reply_markup: buildInlineKeyboard(availability.keyboard),
          })
          .catch(async (err) => {
            log.debug(
              { err, chatId: notification.chatId, sourceId: series.sourceId },
              'release archive prompt send degraded',
            );
            if (previousMessageId === null) {
              await animeArchive.invalidateOffer(availability.offer.id).catch(() => null);
            }
            return null;
          });
        if (!prompt) return true;

        const attachment = await animeArchive
          .replaceConfirmationMessage(availability.offer.id, prompt.message_id)
          .catch((err) => {
            log.debug(
              { err, chatId: notification.chatId, sourceId: series.sourceId },
              'release archive prompt attach degraded',
            );
            return null;
          });
        if (!attachment) {
          await api.deleteMessage(notification.chatId, prompt.message_id).catch(() => undefined);
          if (previousMessageId === null) {
            await animeArchive.invalidateOffer(availability.offer.id).catch(() => null);
          }
          return true;
        }
        if (
          attachment.replacedMessageId !== null &&
          attachment.replacedMessageId !== prompt.message_id
        ) {
          await api
            .deleteMessage(notification.chatId, attachment.replacedMessageId)
            .catch(() => undefined);
        }
        return true;
      }
      return true;
    } catch (err) {
      log.debug(
        { err, chatId: notification.chatId, sourceId: series.sourceId },
        'release archive optional prompt degraded after notification delivery',
      );
      return true;
    }
  };
}
