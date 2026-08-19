import type { AnimeConfig } from '../config/index.js';
import type { Storage } from '../storage/index.js';
import type { AnimeSeriesDoc } from '../storage/repositories/animeCatalog.js';
import type { WebSearchProvider } from '../search/types.js';
import { childLogger } from '../utils/logger.js';
import {
  EXACT_MATCH_SCORE,
  canonicalTitleKey,
  isDecisiveMatch,
  normalizeTitle,
  rankByTitle,
} from './titles.js';
import type { AnimeCatalogProvider, AnimeLookupResult, AnimeMatch, AnimeSeries } from './types.js';
import { applyEnrichment, type JikanEnricher } from './providers/jikan.js';

const log = childLogger('anime-catalog');

/** Canonical AniList host, plus its subdomains. */
const ANILIST_HOST = 'anilist.co';

/** `/anime/<id>` and nothing else; the id must be the first path segment after `anime`. */
const ANILIST_PATH_ID = /^\/anime\/(\d{1,9})(?:\/|$)/;

/**
 * Extract an AniList series id from a search-result URL.
 *
 * Parsing the URL rather than pattern-matching the raw string is what makes a deceptive result
 * such as `https://evil.example/?u=anilist.co/anime/888` or `https://anilist.co.evil.example/...`
 * yield nothing: the host must really be AniList and the id must really be in the path.
 */
export function anilistIdFromUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host !== ANILIST_HOST && !host.endsWith(`.${ANILIST_HOST}`)) return null;
  return ANILIST_PATH_ID.exec(url.pathname)?.[1] ?? null;
}

export interface AnimeCatalogDeps {
  storage: Storage;
  provider: AnimeCatalogProvider;
  enricher?: JikanEnricher | undefined;
  search?: WebSearchProvider | undefined;
}

/**
 * Resolves free-text titles to catalog series and keeps the persisted index fresh.
 *
 * The lookup ladder is strictly cheapest-first - persisted exact key, persisted fuzzy, remote
 * source search, then SearXNG - so a question about a title the bot already knows never depends
 * on an external search engine, and no step ever consults an LLM to compare two strings.
 */
export class AnimeCatalogService {
  /** Set per lookup; consumed by `rank` to break a franchise tie the way the question implies. */
  private preferOngoing = false;

  constructor(
    private readonly cfg: AnimeConfig,
    private readonly deps: AnimeCatalogDeps,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled && this.deps.provider.enabled;
  }

  /**
   * Resolve a title, refreshing the persisted entry when it has gone stale.
   *
   * `preferOngoing` reflects what the user asked, not what the strings look like: "quando esce il
   * prossimo episodio" against a franchise of four entries is not genuinely ambiguous, because
   * only one of them is still airing.
   */
  async lookup(
    query: string,
    signal?: AbortSignal,
    opts: { preferOngoing?: boolean } = {},
  ): Promise<AnimeLookupResult> {
    if (!this.enabled) return { candidates: [], fromCache: false };
    const trimmed = query.trim();
    if (!trimmed) return { candidates: [], fromCache: false };
    this.preferOngoing = opts.preferOngoing ?? false;

    const local = await this.lookupLocal(trimmed);
    // The cache is a partial view of the source, so a lone local candidate looks unambiguous
    // simply because its rivals were never crawled. Two real failures came from trusting it: one
    // of four Tanya entries answered a question about the airing season with the 2017 one, and a
    // leftover "Yani Neko Mini" answered for "Chainsmoker Cat". So only an exact title hit is
    // authoritative offline; anything fuzzier is checked against the source first, and a
    // concluded entry is never trusted for a question about what comes next.
    const localIsExact = (local.match?.score ?? 0) >= EXACT_MATCH_SCORE;
    const localLooksWrong =
      this.preferOngoing && local.match !== undefined && local.match.series.status !== 'ongoing';
    if (local.match && localIsExact && !localLooksWrong) {
      const refreshed = await this.refreshIfStale(local.match.series, signal);
      return {
        match: { ...local.match, series: refreshed },
        candidates: local.candidates,
        fromCache: refreshed === local.match.series,
      };
    }

    const remote = await this.lookupRemote(trimmed, signal);
    if (remote.match || remote.candidates.length > 0) return remote;

    // Only now is an external search engine worth the round-trip.
    const viaSearch = await this.lookupViaWebSearch(trimmed, signal);
    if (viaSearch.match || viaSearch.candidates.length > 0) return viaSearch;

    // Nothing new was learned, so the local result is still the best honest answer - including a
    // concluded match that was set aside above, which beats claiming to know nothing.
    return local;
  }

  /** Persisted-catalog-only resolution. Exposed so the follow poller can skip remote calls. */
  async lookupLocal(query: string): Promise<AnimeLookupResult> {
    const canonical = canonicalTitleKey(query);
    if (!canonical) return { candidates: [], fromCache: true };

    const exact = await this.deps.storage.animeCatalog.findByTitleKey(canonical, 10);
    const normalized =
      exact.length > 0
        ? exact
        : await this.deps.storage.animeCatalog.findByTitleKey(normalizeTitle(query), 10);
    if (normalized.length === 1) {
      const only = normalized[0];
      if (only) {
        return {
          match: { series: toSeries(only), score: 1, matchedKey: canonical },
          candidates: [],
          fromCache: true,
        };
      }
    }

    const pool =
      normalized.length > 0
        ? normalized
        : await this.deps.storage.animeCatalog.findFuzzyCandidates(canonical.split(' '), 200);
    return this.rank(query, pool.map(toSeries), true);
  }

  /** Ask the source catalog directly, then persist whatever it returned. */
  private async lookupRemote(query: string, signal?: AbortSignal): Promise<AnimeLookupResult> {
    const results = await this.deps.provider.search(query, signal);
    if (results.length === 0) return { candidates: [], fromCache: false };
    const enriched = await this.enrichAll(results, signal);
    await this.persist(enriched);
    return this.rank(query, enriched, false);
  }

  /**
   * Last-resort discovery: let SearXNG map a colloquial name onto a canonical catalog id.
   *
   * Only an AniList id extracted from a result URL is trusted - result titles and snippets are
   * never treated as catalog data.
   */
  private async lookupViaWebSearch(
    query: string,
    signal?: AbortSignal,
  ): Promise<AnimeLookupResult> {
    const search = this.deps.search;
    if (!this.cfg.searchFallbackEnabled || !search?.enabled) {
      return { candidates: [], fromCache: false };
    }
    const response = await search
      .search(`${query} anime anilist`, { max: 5, ...(signal ? { signal } : {}) })
      .catch((error: unknown) => {
        log.debug({ error }, 'anime search fallback failed');
        return null;
      });
    if (!response) return { candidates: [], fromCache: false };

    const ids: string[] = [];
    for (const result of response.results) {
      const id = anilistIdFromUrl(result.url);
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= 5) break;
    }
    if (ids.length === 0) return { candidates: [], fromCache: false };

    const series = await this.deps.provider.getManyByIds(ids, signal);
    if (series.length === 0) return { candidates: [], fromCache: false };
    const enriched = await this.enrichAll(series, signal);
    await this.persist(enriched);
    log.info({ query, resolved: enriched.length }, 'anime title resolved through search fallback');

    // Re-ranking against the original wording would defeat the point of this step: the fallback
    // exists precisely for queries that do not lexically resemble the title ("quella dove la
    // bambina fa la guerra"). The search engine already did the disambiguation, so a single
    // resolved id is the answer; several ids stay a shortlist.
    const [only] = enriched;
    if (enriched.length === 1 && only) {
      return {
        match: { series: only, score: 1, matchedKey: canonicalTitleKey(only.title) },
        candidates: [],
        fromCache: false,
      };
    }
    return {
      candidates: enriched
        .slice(0, this.cfg.maxCandidates)
        .map((entry) => ({ series: entry, score: 0, matchedKey: canonicalTitleKey(entry.title) })),
      fromCache: false,
    };
  }

  /** Currently-airing series; prefers the persisted index and refreshes it when thin or stale. */
  async listAiring(limit: number, signal?: AbortSignal): Promise<AnimeSeries[]> {
    if (!this.enabled) return [];
    const bounded = Math.max(1, Math.min(25, limit));
    const cached = await this.deps.storage.animeCatalog.listAiring(bounded);
    const freshEnough = cached.filter((doc) => !this.isStale(doc)).map(toSeries);
    if (freshEnough.length >= bounded) return freshEnough.slice(0, bounded);

    const remote = await this.deps.provider.listAiring(bounded, signal);
    if (remote.length === 0) return freshEnough;
    await this.persist(remote);
    return remote.slice(0, bounded);
  }

  /** Fetch the authoritative current state of one series and persist it. */
  async refresh(
    source: AnimeSeries['source'],
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<AnimeSeries | null> {
    if (!this.enabled || source !== this.deps.provider.source) return null;
    const series = await this.deps.provider.getById(sourceId, signal);
    if (!series) return null;
    const [enriched] = await this.enrichAll([series], signal);
    if (!enriched) return null;
    await this.persist([enriched]);
    return enriched;
  }

  /** Read a series straight from the persisted catalog, without any remote call. */
  async getPersisted(source: AnimeSeries['source'], sourceId: string): Promise<AnimeSeries | null> {
    const doc = await this.deps.storage.animeCatalog.get(source, sourceId);
    return doc ? toSeries(doc) : null;
  }

  /** Idempotent write-through; repeated refreshes update in place instead of duplicating. */
  private async persist(series: readonly AnimeSeries[]): Promise<void> {
    if (series.length === 0) return;
    try {
      await this.deps.storage.animeCatalog.upsertMany(series);
    } catch (error) {
      // A catalog that cannot be cached still answers; only the next lookup pays for it again.
      log.warn({ error, count: series.length }, 'anime catalog persist failed');
    }
  }

  private async refreshIfStale(series: AnimeSeries, signal?: AbortSignal): Promise<AnimeSeries> {
    const doc = await this.deps.storage.animeCatalog.get(series.source, series.sourceId);
    if (doc && !this.isStale(doc)) return series;
    const refreshed = await this.refresh(series.source, series.sourceId, signal);
    return refreshed ?? series;
  }

  private isStale(doc: AnimeSeriesDoc): boolean {
    const crawledAt = doc.crawledAt?.getTime?.();
    if (!crawledAt || !Number.isFinite(crawledAt)) return true;
    return Date.now() - crawledAt > this.cfg.refreshMinutes * 60_000;
  }

  private async enrichAll(
    series: readonly AnimeSeries[],
    signal?: AbortSignal,
  ): Promise<AnimeSeries[]> {
    const enricher = this.deps.enricher;
    if (!enricher?.enabled) return [...series];
    const out: AnimeSeries[] = [];
    for (const entry of series) {
      // Only pay for enrichment when the primary source actually left a gap.
      const needsEnrichment =
        entry.airingWeekday === undefined ||
        entry.score === undefined ||
        entry.episodeCount === undefined;
      const malId = entry.externalIds.mal;
      if (!needsEnrichment || malId === undefined) {
        out.push(entry);
        continue;
      }
      const enrichment = await enricher.fetchByMalId(malId, signal).catch(() => null);
      out.push(applyEnrichment(entry, enrichment));
    }
    return out;
  }

  private rank(
    query: string,
    series: readonly AnimeSeries[],
    fromCache: boolean,
  ): AnimeLookupResult {
    const ranked = rankByTitle(
      query,
      series.map((entry) => ({ titles: [entry.title, ...entry.aliases], entry })),
      { limit: this.cfg.maxCandidates },
    );
    const candidates: AnimeMatch[] = ranked.map((row) => ({
      series: row.item.entry,
      score: row.score,
      matchedKey: row.matchedKey,
    }));
    // A franchise ties on title similarity by construction ("Saga of Tanya the Evil" vs the same
    // name plus "Season 2"), so pure string distance can never separate them. When the question
    // is about what airs next and exactly one candidate is actually airing, that is the answer -
    // an explicit rule rather than a score nudge, so it either applies or it does not.
    const airing = candidates.filter((candidate) => candidate.series.status === 'ongoing');
    if (this.preferOngoing && airing.length === 1 && airing[0]) {
      return { match: airing[0], candidates, fromCache };
    }

    const decisive = isDecisiveMatch(ranked);
    const top = candidates[0];
    return {
      match: decisive && top ? top : undefined,
      candidates,
      fromCache,
    };
  }
}

/** Strip persistence-only fields so callers never leak `_id`/`revision` into an answer. */
function toSeries(doc: AnimeSeriesDoc): AnimeSeries {
  return {
    source: doc.source,
    sourceId: doc.sourceId,
    title: doc.title,
    titleRomaji: doc.titleRomaji,
    titleEnglish: doc.titleEnglish,
    titleNative: doc.titleNative,
    aliases: doc.aliases ?? [],
    titleKeys: doc.titleKeys ?? [],
    url: doc.url,
    coverUrl: doc.coverUrl,
    description: doc.description,
    status: doc.status,
    format: doc.format,
    genres: doc.genres ?? [],
    episodeCount: doc.episodeCount,
    latestEpisode: doc.latestEpisode,
    nextEpisode: doc.nextEpisode,
    airingWeekday: doc.airingWeekday,
    seasonYear: doc.seasonYear,
    season: doc.season,
    studios: doc.studios ?? [],
    score: doc.score,
    externalIds: doc.externalIds ?? {},
    sourceUpdatedAt: doc.sourceUpdatedAt,
  };
}
