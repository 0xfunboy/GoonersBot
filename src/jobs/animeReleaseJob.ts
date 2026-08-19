import type { AnimeCatalogService } from '../anime/catalogService.js';
import type { AnimeArchiveEpisode, AnimeArchiveSeries } from '../anime/archive/types.js';
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
  /** Follower who owns any optional per-user action attached to this notification. */
  createdByHandle: string;
  series: AnimeSeries;
  /** Episode number that just became available. */
  episode: number;
  /** Exact no-gateway source that made this notification actionable. */
  archiveSeries: AnimeArchiveSeries;
  archiveEpisode: AnimeArchiveEpisode;
}

export interface AnimeReleaseAvailability {
  series: AnimeArchiveSeries;
  episode: AnimeArchiveEpisode;
}

export type AnimeReleaseAvailabilityResolver = (
  series: AnimeSeries,
) => Promise<AnimeReleaseAvailability | null>;

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
  resolveAvailability: AnimeReleaseAvailabilityResolver,
  notify: AnimeReleaseNotifier,
): Promise<AnimeReleaseJobResult> {
  const result: AnimeReleaseJobResult = { polled: 0, newEpisodes: 0, notified: 0 };
  if (!cfg.follows.enabled) return result;

  const targets = await storage.animeFollows.listSeriesToPoll(cfg.follows.batchSize);
  for (const target of targets) {
    result.polled += 1;
    let series: AnimeSeries | null = null;
    try {
      // Release detection must not depend on a gateway catalog. Persisted metadata is used only
      // for aliases/display; AnimeUnity or HentaiSaturn below is the sole live availability source.
      series = await catalog.getPersisted(target.source, target.sourceId);
    } catch (error) {
      log.warn({ error, ...target }, 'anime follow metadata read failed');
    }
    // Mark the poll attempt regardless of outcome; otherwise one permanently failing series
    // would monopolise every batch and starve all the others.
    await storage.animeFollows.markChecked(target.source, target.sourceId);
    series ??= releaseSeriesStub(target);

    let availability: AnimeReleaseAvailability | null = null;
    try {
      availability = await resolveAvailability(series);
    } catch (error) {
      log.warn({ error, ...target }, 'anime archive availability refresh failed');
    }
    if (!availability) continue;
    const episode = availability.episode.order;
    if (!Number.isFinite(episode) || episode < 1) continue;

    const claims = await storage.animeFollows.claimArchiveNotifications(
      target.source,
      target.sourceId,
      availability.series.source,
      availability.series.sourceId,
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
          createdByHandle: claim.createdByHandle,
          series,
          episode,
          archiveSeries: availability.series,
          archiveEpisode: availability.episode,
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
        .releaseArchiveClaim(
          claim.chatId,
          target.source,
          target.sourceId,
          availability.series.source,
          availability.series.sourceId,
          episode,
          claim.archiveLastNotifiedEpisode ?? -1,
        )
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

function releaseSeriesStub(target: {
  source: AnimeSeries['source'];
  sourceId: string;
  title: string;
}): AnimeSeries {
  return {
    source: target.source,
    sourceId: target.sourceId,
    title: target.title,
    aliases: [],
    titleKeys: [],
    url: '',
    status: 'unknown',
    genres: [],
    studios: [],
    externalIds: {},
  };
}
