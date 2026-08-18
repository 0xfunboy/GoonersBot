import { fetchSafeRemoteBuffer } from '../../utils/safeRemoteFetch.js';
import { childLogger } from '../../utils/logger.js';
import { SlidingWindowCounter } from '../../utils/rateLimit.js';
import { titleKeys } from '../titles.js';
import type {
  AnimeCatalogProvider,
  AnimeFormat,
  AnimeSeries,
  AnimeStatus,
  IsoWeekday,
} from '../types.js';

const log = childLogger('anime-anilist');

/**
 * AniList publishes ~90 requests/minute per client. Staying well under it keeps the catalog
 * usable for everyone rather than earning a 429 for the whole bot.
 */
const RATE_LIMIT_PER_MINUTE = 45;

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  synonyms
  siteUrl
  description(asHtml: false)
  status
  format
  episodes
  genres
  season
  seasonYear
  averageScore
  updatedAt
  coverImage { large }
  nextAiringEpisode { episode airingAt }
  studios(isMain: true) { nodes { name } }
  externalLinks { site url type }
`;

const SEARCH_QUERY = `query ($search: String!, $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {${MEDIA_FIELDS}}
  }
}`;

const BY_IDS_QUERY = `query ($ids: [Int]!, $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(id_in: $ids, type: ANIME) {${MEDIA_FIELDS}}
  }
}`;

const AIRING_QUERY = `query ($perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(status: RELEASING, type: ANIME, sort: POPULARITY_DESC) {${MEDIA_FIELDS}}
  }
}`;

export interface AnilistProviderConfig {
  enabled: boolean;
  apiUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

/** Shape of one `Media` node; every field is optional because AniList omits unknown data. */
interface RawMedia {
  id?: unknown;
  idMal?: unknown;
  title?: { romaji?: unknown; english?: unknown; native?: unknown } | null;
  synonyms?: unknown;
  siteUrl?: unknown;
  description?: unknown;
  status?: unknown;
  format?: unknown;
  episodes?: unknown;
  genres?: unknown;
  season?: unknown;
  seasonYear?: unknown;
  averageScore?: unknown;
  updatedAt?: unknown;
  coverImage?: { large?: unknown } | null;
  nextAiringEpisode?: { episode?: unknown; airingAt?: unknown } | null;
  studios?: { nodes?: unknown } | null;
  externalLinks?: unknown;
}

const STATUS_MAP: Readonly<Record<string, AnimeStatus>> = {
  RELEASING: 'ongoing',
  FINISHED: 'finished',
  NOT_YET_RELEASED: 'not_yet_released',
  CANCELLED: 'cancelled',
  HIATUS: 'hiatus',
};

const FORMAT_MAP: Readonly<Record<string, AnimeFormat>> = {
  TV: 'tv',
  TV_SHORT: 'tv_short',
  MOVIE: 'movie',
  SPECIAL: 'special',
  OVA: 'ova',
  ONA: 'ona',
  MUSIC: 'music',
};

/**
 * Read-only AniList catalog client.
 *
 * Every response goes through the project's SSRF-guarded fetch, is size-bounded, and is parsed
 * defensively: a single malformed media node is dropped instead of failing the whole query.
 */
export class AnilistProvider implements AnimeCatalogProvider {
  readonly source = 'anilist' as const;
  private readonly limiter = new SlidingWindowCounter(60_000, RATE_LIMIT_PER_MINUTE);

  constructor(private readonly cfg: AnilistProviderConfig) {}

  get enabled(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.apiUrl);
  }

  async search(query: string, signal?: AbortSignal): Promise<AnimeSeries[]> {
    const search = query.trim().slice(0, 200);
    if (!search) return [];
    const page = await this.query(SEARCH_QUERY, { search, perPage: 10 }, signal);
    return parseMediaPage(page);
  }

  async getById(sourceId: string, signal?: AbortSignal): Promise<AnimeSeries | null> {
    const [series] = await this.getManyByIds([sourceId], signal);
    return series ?? null;
  }

  async getManyByIds(sourceIds: readonly string[], signal?: AbortSignal): Promise<AnimeSeries[]> {
    const ids = sourceIds
      .map((id) => Number.parseInt(id, 10))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .slice(0, 50);
    if (ids.length === 0) return [];
    const page = await this.query(BY_IDS_QUERY, { ids, perPage: ids.length }, signal);
    return parseMediaPage(page);
  }

  async listAiring(limit: number, signal?: AbortSignal): Promise<AnimeSeries[]> {
    const perPage = Math.max(1, Math.min(50, limit));
    const page = await this.query(AIRING_QUERY, { perPage }, signal);
    return parseMediaPage(page);
  }

  /**
   * One GraphQL round-trip.
   *
   * Returns `null` on any transport, rate-limit or GraphQL-level error: the catalog is an
   * enrichment layer, so a degraded AniList must never propagate an exception into a reply.
   */
  private async query(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.enabled) return null;
    if (!this.limiter.isUnderLimit('anilist')) {
      log.warn('anilist client-side rate limit reached; skipping catalog call');
      return null;
    }
    this.limiter.record('anilist');
    try {
      const result = await fetchSafeRemoteBuffer(this.cfg.apiUrl, {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        timeoutMs: this.cfg.timeoutMs,
        maxBytes: this.cfg.maxResponseBytes,
        allowedContentTypes: ['application/json'],
        ...(signal ? { signal } : {}),
      });
      const parsed: unknown = JSON.parse(result.buffer.toString('utf8'));
      if (!isRecord(parsed)) return null;
      if (Array.isArray(parsed['errors']) && parsed['errors'].length > 0) {
        log.warn({ count: parsed['errors'].length }, 'anilist returned GraphQL errors');
        return null;
      }
      return parsed['data'];
    } catch (error) {
      log.warn({ error }, 'anilist catalog query failed');
      return null;
    }
  }
}

/** Extract every parsable series from a `Page { media }` payload. */
export function parseMediaPage(data: unknown): AnimeSeries[] {
  if (!isRecord(data)) return [];
  const page = data['Page'];
  if (!isRecord(page)) return [];
  const media = page['media'];
  if (!Array.isArray(media)) return [];
  const series: AnimeSeries[] = [];
  for (const node of media) {
    const parsed = parseMedia(node);
    if (parsed) series.push(parsed);
  }
  return series;
}

/**
 * Map one AniList media node onto the domain type.
 *
 * Only `id` is genuinely required. A node with no usable title is dropped, because a series that
 * cannot be named also cannot be matched or displayed.
 */
export function parseMedia(node: unknown): AnimeSeries | null {
  if (!isRecord(node)) return null;
  const id = asInt(node['id']);
  if (id === undefined || id <= 0) return null;

  const raw = node as RawMedia;
  const romaji = asString(raw.title?.romaji);
  const english = asString(raw.title?.english);
  const native = asString(raw.title?.native);
  const title = english ?? romaji ?? native;
  if (!title) return null;

  const synonyms = asStringArray(raw.synonyms).slice(0, 20);
  const aliases = dedupe(
    [romaji, english, native, ...synonyms].filter((value): value is string => Boolean(value)),
  ).filter((value) => value !== title);

  const status = STATUS_MAP[asString(raw.status) ?? ''] ?? 'unknown';
  const episodeCount = asInt(raw.episodes);
  const nextEpisodeNumber = asInt(raw.nextAiringEpisode?.episode);
  const nextAiringAtSeconds = asInt(raw.nextAiringEpisode?.airingAt);
  const nextEpisode =
    nextEpisodeNumber !== undefined && nextAiringAtSeconds !== undefined
      ? { episode: nextEpisodeNumber, airingAt: new Date(nextAiringAtSeconds * 1000) }
      : undefined;

  const series: AnimeSeries = {
    source: 'anilist',
    sourceId: String(id),
    title,
    titleRomaji: romaji,
    titleEnglish: english,
    titleNative: native,
    aliases,
    titleKeys: titleKeys([title, ...aliases]),
    url: asString(raw.siteUrl) ?? `https://anilist.co/anime/${id}`,
    coverUrl: asString(raw.coverImage?.large),
    description: plainDescription(asString(raw.description)),
    status,
    format: FORMAT_MAP[asString(raw.format) ?? ''],
    genres: asStringArray(raw.genres).slice(0, 20),
    episodeCount,
    latestEpisode: latestAiredEpisode(status, episodeCount, nextEpisodeNumber),
    nextEpisode,
    airingWeekday: nextEpisode ? isoWeekday(nextEpisode.airingAt) : undefined,
    seasonYear: asInt(raw.seasonYear),
    season: seasonOf(asString(raw.season)),
    studios: studioNames(raw.studios?.nodes).slice(0, 10),
    score: asInt(raw.averageScore),
    externalIds: { anilist: id, mal: asInt(raw.idMal) },
    streamingLinks: streamingLinks(raw.externalLinks),
    sourceUpdatedAt: epochSecondsToDate(asInt(raw.updatedAt)),
  };
  return series;
}

/**
 * Highest episode already aired.
 *
 * While a series is releasing, `nextAiringEpisode` is the authoritative anchor - `episodes` is the
 * planned total and would overstate what a viewer can actually watch today.
 */
export function latestAiredEpisode(
  status: AnimeStatus,
  episodeCount: number | undefined,
  nextEpisodeNumber: number | undefined,
): number | undefined {
  if (nextEpisodeNumber !== undefined && nextEpisodeNumber > 0) return nextEpisodeNumber - 1;
  if (status === 'finished' && episodeCount !== undefined) return episodeCount;
  if (status === 'not_yet_released') return 0;
  return undefined;
}

function isoWeekday(date: Date): IsoWeekday | undefined {
  const day = date.getUTCDay();
  if (!Number.isInteger(day)) return undefined;
  return (day === 0 ? 7 : day) as IsoWeekday;
}

function seasonOf(raw: string | undefined): AnimeSeries['season'] {
  switch (raw) {
    case 'WINTER':
      return 'winter';
    case 'SPRING':
      return 'spring';
    case 'SUMMER':
      return 'summer';
    case 'FALL':
      return 'fall';
    default:
      return undefined;
  }
}

function studioNames(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => (isRecord(node) ? asString(node['name']) : undefined))
    .filter((name): name is string => Boolean(name));
}

/** Keep only real streaming destinations; AniList also lists forums, wikis and socials. */
function streamingLinks(raw: unknown): Array<{ site: string; url: string }> {
  if (!Array.isArray(raw)) return [];
  const links: Array<{ site: string; url: string }> = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (asString(entry['type']) !== 'STREAMING') continue;
    const site = asString(entry['site']);
    const url = asString(entry['url']);
    if (!site || !url) continue;
    if (!/^https:\/\//i.test(url)) continue;
    links.push({ site, url });
    if (links.length >= 10) break;
  }
  return links;
}

/** AniList descriptions carry light HTML even with `asHtml: false`. */
function plainDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 1_200) : undefined;
}

function epochSecondsToDate(seconds: number | undefined): Date | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== undefined);
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
