import { fetchSafeRemoteBuffer } from '../../utils/safeRemoteFetch.js';
import { childLogger } from '../../utils/logger.js';
import { SlidingWindowCounter } from '../../utils/rateLimit.js';
import type { AnimeSeries, IsoWeekday } from '../types.js';

const log = childLogger('anime-jikan');

/** Jikan documents 60 requests/minute; half of that leaves room for other consumers. */
const RATE_LIMIT_PER_MINUTE = 30;

const WEEKDAYS: Readonly<Record<string, IsoWeekday>> = {
  mondays: 1,
  tuesdays: 2,
  wednesdays: 3,
  thursdays: 4,
  fridays: 5,
  saturdays: 6,
  sundays: 7,
};

export interface JikanEnricherConfig {
  enabled: boolean;
  apiUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

/** The subset of MAL data that genuinely fills gaps AniList leaves. */
export interface AnimeEnrichment {
  /** Broadcast weekday for series with no scheduled next episode (e.g. between seasons). */
  airingWeekday?: IsoWeekday | undefined;
  /** MAL score on a 0-100 scale, matching the AniList convention. */
  score?: number | undefined;
  /** Total episodes when AniList has not published one yet. */
  episodeCount?: number | undefined;
}

/**
 * Optional secondary enrichment from MyAnimeList via Jikan.
 *
 * Strictly best-effort: every failure resolves to `null`, and `applyEnrichment` only ever fills
 * fields the primary catalog left undefined, so the source of truth never gets overwritten.
 */
export class JikanEnricher {
  private readonly limiter = new SlidingWindowCounter(60_000, RATE_LIMIT_PER_MINUTE);

  constructor(private readonly cfg: JikanEnricherConfig) {}

  get enabled(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.apiUrl);
  }

  async fetchByMalId(malId: number, signal?: AbortSignal): Promise<AnimeEnrichment | null> {
    if (!this.enabled) return null;
    if (!Number.isSafeInteger(malId) || malId <= 0) return null;
    if (!this.limiter.isUnderLimit('jikan')) return null;
    this.limiter.record('jikan');
    try {
      const result = await fetchSafeRemoteBuffer(`${this.cfg.apiUrl}/anime/${malId}`, {
        headers: { accept: 'application/json' },
        timeoutMs: this.cfg.timeoutMs,
        maxBytes: this.cfg.maxResponseBytes,
        allowedContentTypes: ['application/json'],
        ...(signal ? { signal } : {}),
      });
      return parseJikanAnime(JSON.parse(result.buffer.toString('utf8')));
    } catch (error) {
      log.debug({ error, malId }, 'jikan enrichment unavailable');
      return null;
    }
  }
}

export function parseJikanAnime(payload: unknown): AnimeEnrichment | null {
  if (!isRecord(payload)) return null;
  const data = payload['data'];
  if (!isRecord(data)) return null;

  const broadcastDay =
    isRecord(data['broadcast']) && typeof data['broadcast']['day'] === 'string'
      ? WEEKDAYS[data['broadcast']['day'].trim().toLowerCase()]
      : undefined;
  const score =
    typeof data['score'] === 'number' && Number.isFinite(data['score'])
      ? Math.round(data['score'] * 10)
      : undefined;
  const episodeCount =
    typeof data['episodes'] === 'number' && Number.isFinite(data['episodes'])
      ? Math.trunc(data['episodes'])
      : undefined;

  const enrichment: AnimeEnrichment = {
    airingWeekday: broadcastDay,
    score,
    episodeCount,
  };
  return enrichment.airingWeekday === undefined &&
    enrichment.score === undefined &&
    enrichment.episodeCount === undefined
    ? null
    : enrichment;
}

/**
 * Merge enrichment into a series without ever overwriting primary-source data.
 *
 * Returns a new object; the input is left untouched so a failed persist cannot leave a
 * half-enriched series in memory.
 */
export function applyEnrichment(
  series: AnimeSeries,
  enrichment: AnimeEnrichment | null,
): AnimeSeries {
  if (!enrichment) return series;
  return {
    ...series,
    airingWeekday: series.airingWeekday ?? enrichment.airingWeekday,
    score: series.score ?? enrichment.score,
    episodeCount: series.episodeCount ?? enrichment.episodeCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
