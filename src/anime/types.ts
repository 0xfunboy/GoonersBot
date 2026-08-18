/**
 * Domain types for the anime release catalog.
 *
 * This layer only ever models *metadata about releases* - titles, status, episode counts and
 * airing schedule. It deliberately carries no media, stream or download fields.
 */

export type AnimeCatalogSource = 'anilist';

/**
 * `unknown` is a real state, not a placeholder: when the source publishes no status, claiming
 * "not yet released" would assert that zero episodes exist, which the source never said.
 */
export type AnimeStatus =
  | 'ongoing'
  | 'finished'
  | 'not_yet_released'
  | 'cancelled'
  | 'hiatus'
  | 'unknown';

export type AnimeFormat = 'tv' | 'tv_short' | 'movie' | 'special' | 'ova' | 'ona' | 'music';

/** Airing weekday in ISO-8601 numbering (1 = Monday) so it survives locale changes. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface AnimeAiringEpisode {
  /** Episode number that airs at `airingAt`. */
  episode: number;
  airingAt: Date;
}

/** One series as stored in the catalog and returned to the agent. */
export interface AnimeSeries {
  source: AnimeCatalogSource;
  /** Stable id within `source`; combined with `source` it is the primary key. */
  sourceId: string;
  /** Display title, chosen from the available romaji/english/native titles. */
  title: string;
  titleRomaji?: string | undefined;
  titleEnglish?: string | undefined;
  titleNative?: string | undefined;
  /** Normalized alternate spellings used for lookup; never shown verbatim to users. */
  aliases: string[];
  /** Deterministic lookup keys derived from every known title (see `titles.ts`). */
  titleKeys: string[];
  url: string;
  coverUrl?: string | undefined;
  description?: string | undefined;
  status: AnimeStatus;
  format?: AnimeFormat | undefined;
  genres: string[];
  /** Total episodes when the source knows it; unknown for many currently-airing shows. */
  episodeCount?: number | undefined;
  /** Highest episode number already aired, as far as the source knows. */
  latestEpisode?: number | undefined;
  /** Next episode and its air time, when the series is still airing. */
  nextEpisode?: AnimeAiringEpisode | undefined;
  /** Weekday the series normally airs on, derived from the airing schedule. */
  airingWeekday?: IsoWeekday | undefined;
  seasonYear?: number | undefined;
  season?: 'winter' | 'spring' | 'summer' | 'fall' | undefined;
  studios: string[];
  /** 0-100 community score when available. */
  score?: number | undefined;
  /** Cross-source ids used for optional enrichment; every one of them is optional. */
  externalIds: {
    anilist?: number | undefined;
    mal?: number | undefined;
  };
  /** Where the user can legally watch it, as published by the source. */
  streamingLinks: Array<{ site: string; url: string }>;
  /** Last time the source itself reported a change, when it exposes one. */
  sourceUpdatedAt?: Date | undefined;
}

/** A resolved catalog answer plus how confident the deterministic matcher was. */
export interface AnimeMatch {
  series: AnimeSeries;
  score: number;
  matchedKey: string;
}

export interface AnimeLookupResult {
  /** Set only when the match was decisive. */
  match?: AnimeMatch | undefined;
  /** Ranked alternatives, shown instead of guessing when the match was ambiguous. */
  candidates: AnimeMatch[];
  /** True when the answer came from the persisted catalog without a remote call. */
  fromCache: boolean;
}

/** A source able to answer catalog queries. Implemented by the AniList provider. */
export interface AnimeCatalogProvider {
  readonly source: AnimeCatalogSource;
  readonly enabled: boolean;
  search(query: string, signal?: AbortSignal): Promise<AnimeSeries[]>;
  getById(sourceId: string, signal?: AbortSignal): Promise<AnimeSeries | null>;
  /** Currently-airing series, used for "che anime stanno uscendo" style questions. */
  listAiring(limit: number, signal?: AbortSignal): Promise<AnimeSeries[]>;
  /** Refresh several series in one round-trip; used by the follow poller. */
  getManyByIds(sourceIds: readonly string[], signal?: AbortSignal): Promise<AnimeSeries[]>;
}
