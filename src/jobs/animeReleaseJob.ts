import type { AnimeCatalogService } from '../anime/catalogService.js';
import type { AnimeSeries } from '../anime/types.js';
import type { AnimeConfig } from '../config/index.js';
import type { Storage } from '../storage/index.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('anime-releases');

/** Delivery callback; returning false means "not delivered", which releases the claim. */
export type AnimeReleaseNotifier = (notification: AnimeReleaseNotification) => Promise<boolean>;

export interface AnimeReleaseNotification {
  chatId: number;
  threadId?: number | undefined;
  series: AnimeSeries;
  /** Episode number that just became available. */
  episode: number;
}

export interface AnimeReleaseJobResult {
  polled: number;
  newEpisodes: number;
  notified: number;
}

/**
 * Poll followed series and announce genuinely new episodes exactly once per chat.
 *
 * Correctness rests on the repository's conditional watermark update rather than on this loop:
 * the claim is taken *before* sending, so a crash between claim and delivery costs at most one
 * missed notification, while a restart can never produce a duplicate one.
 */
export async function runAnimeReleaseJob(
  cfg: AnimeConfig,
  storage: Storage,
  catalog: AnimeCatalogService,
  notify: AnimeReleaseNotifier,
): Promise<AnimeReleaseJobResult> {
  const result: AnimeReleaseJobResult = { polled: 0, newEpisodes: 0, notified: 0 };
  if (!cfg.follows.enabled || !catalog.enabled) return result;

  const targets = await storage.animeFollows.listSeriesToPoll(cfg.follows.batchSize);
  for (const target of targets) {
    result.polled += 1;
    let series: AnimeSeries | null = null;
    try {
      series = await catalog.refresh(target.source, target.sourceId);
    } catch (error) {
      log.warn({ error, ...target }, 'anime follow refresh failed');
    }
    // Mark the poll attempt regardless of outcome; otherwise one permanently failing series
    // would monopolise every batch and starve all the others.
    await storage.animeFollows.markChecked(target.source, target.sourceId);
    if (!series) continue;

    const episode = series.latestEpisode;
    if (episode === undefined || !Number.isFinite(episode) || episode < 1) continue;

    const claims = await storage.animeFollows.claimNotifications(
      target.source,
      target.sourceId,
      episode,
    );
    if (claims.length === 0) continue;
    result.newEpisodes += 1;

    for (const claim of claims) {
      let delivered = false;
      try {
        delivered = await notify({
          chatId: claim.chatId,
          threadId: claim.threadId,
          series,
          episode,
        });
      } catch (error) {
        log.warn({ error, chatId: claim.chatId, ...target }, 'anime release notification failed');
      }
      if (delivered) {
        result.notified += 1;
        continue;
      }
      // Undeliverable now: restore the previous watermark so the next tick retries this chat.
      await storage.animeFollows
        .releaseClaim(claim.chatId, target.source, target.sourceId, claim.lastNotifiedEpisode)
        .catch((error: unknown) =>
          log.warn({ error, chatId: claim.chatId, ...target }, 'anime claim release failed'),
        );
    }
  }

  if (result.polled > 0) {
    log.info(result, 'anime release poll finished');
  }
  return result;
}
