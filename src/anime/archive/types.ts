export const ANIME_ARCHIVE_SOURCES = ['animeunity', 'hentaisaturn'] as const;

export type AnimeArchiveSource = (typeof ANIME_ARCHIVE_SOURCES)[number];
export type AnimeArchiveUrlKind = 'series' | 'episode';
export type AnimeArchiveStatus = 'ongoing' | 'completed' | 'unknown';

/** Deterministic classification of a supported public source URL. */
export interface AnimeUrlClassification {
  source: AnimeArchiveSource;
  kind: AnimeArchiveUrlKind;
  /** Canonical public URL with query and fragment removed. */
  canonicalUrl: string;
  canonicalSeriesUrl: string;
  /** Stable source path identifier. It may contain a slug as well as a numeric id. */
  seriesId: string;
  slug: string;
  episodeId?: string | undefined;
  episodeNumber?: string | undefined;
}

export interface AnimeArchiveEpisode {
  source: AnimeArchiveSource;
  /** Stable episode id within the source. */
  sourceId: string;
  seriesId: string;
  seriesSlug: string;
  seriesTitle: string;
  /** Display form retained from the source, including decimal specials such as 7.5. */
  number: string;
  /** Numeric key used for deterministic episode ordering. */
  order: number;
  title: string;
  canonicalUrl: string;
  canonicalSeriesUrl: string;
  releasedAt?: Date | undefined;
}

export interface AnimeArchiveSeries {
  source: AnimeArchiveSource;
  sourceId: string;
  slug: string;
  title: string;
  aliases: string[];
  canonicalUrl: string;
  coverUrl?: string | undefined;
  description?: string | undefined;
  status: AnimeArchiveStatus;
  genres: string[];
  episodeCount?: number | undefined;
  episodes: AnimeArchiveEpisode[];
  releaseWeekday?: string | undefined;
  year?: string | undefined;
  season?: string | undefined;
  studio?: string | undefined;
  score?: number | undefined;
  externalIds: {
    anilist?: number | undefined;
    mal?: number | undefined;
  };
}

/** Lightweight bounded source-search hit; callers fetch full metadata only for the selected hit. */
export interface AnimeArchiveSearchResult {
  source: AnimeArchiveSource;
  sourceId: string;
  slug: string;
  title: string;
  canonicalUrl: string;
  coverUrl?: string | undefined;
  status: AnimeArchiveStatus;
  genres: string[];
  episodeCount?: number | undefined;
  year?: string | undefined;
}

export type AnimeMediaKind = 'download' | 'stream';

/**
 * One ephemeral media candidate. `url` can contain a signed query and must never be logged raw;
 * use `redactSignedUrl()` from `http.ts` for diagnostics.
 */
export interface AnimeMediaCandidate {
  url: string;
  kind: AnimeMediaKind;
  label: string;
  mimeType?: string | undefined;
  active?: boolean | undefined;
  expiresAt?: Date | undefined;
  /** Headers safe to forward to the downloader. They intentionally contain no signed URL. */
  requestHeaders: Readonly<Record<string, string>>;
}

export interface ResolvedAnimeMedia {
  source: AnimeArchiveSource;
  episode: AnimeArchiveEpisode;
  /** Direct download first, then bounded player-provided fallbacks. */
  candidates: AnimeMediaCandidate[];
  posterUrl?: string | undefined;
  resolvedAt: Date;
}

export interface AnimeSourceAdapter {
  readonly source: AnimeArchiveSource;
  classify(url: string | URL): AnimeUrlClassification | null;
  getSeries(url: string | URL, signal?: AbortSignal): Promise<AnimeArchiveSeries>;
  getEpisode(url: string | URL, signal?: AbortSignal): Promise<AnimeArchiveEpisode>;
  /** Re-fetches the series so a bulk job does not rely on a stale episode list. */
  listEpisodes(series: AnimeArchiveSeries, signal?: AbortSignal): Promise<AnimeArchiveEpisode[]>;
  /** Resolves signed player/media URLs just in time on every invocation. */
  resolveMedia(episode: AnimeArchiveEpisode, signal?: AbortSignal): Promise<ResolvedAnimeMedia>;
  /** Optional bounded live lookup for availability offers; it is not a persistent catalog. */
  search?(query: string, limit?: number, signal?: AbortSignal): Promise<AnimeArchiveSearchResult[]>;
}

export type AnimeArchiveErrorCode =
  | 'unsupported_url'
  | 'source_mismatch'
  | 'source_layout_changed'
  | 'episode_not_found'
  | 'media_unavailable';

export class AnimeArchiveError extends Error {
  constructor(
    readonly code: AnimeArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnimeArchiveError';
  }
}

/** Sort key tolerant of decimal specials. Non-numeric labels sort after numbered episodes. */
export function episodeOrder(number: string): number {
  const normalized = number.trim().replace(',', '.');
  const match = /^(\d+(?:\.\d+)?)/.exec(normalized);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

export function compareAnimeEpisodes(a: AnimeArchiveEpisode, b: AnimeArchiveEpisode): number {
  return a.order - b.order || a.number.localeCompare(b.number, undefined, { numeric: true });
}
