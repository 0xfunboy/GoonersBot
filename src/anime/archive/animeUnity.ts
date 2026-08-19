import * as cheerio from 'cheerio';
import { hostMatchesAny } from '../../providers/media/linkMedia/hosts.js';
import {
  assertAllowedArchiveUrl,
  expiryFromUrl,
  SafeAnimeArchiveHttpClient,
  type AnimeArchiveHttpClient,
} from './http.js';
import {
  AnimeArchiveError,
  compareAnimeEpisodes,
  episodeOrder,
  type AnimeArchiveEpisode,
  type AnimeArchiveSearchResult,
  type AnimeArchiveSeries,
  type AnimeMediaCandidate,
  type AnimeSourceAdapter,
  type AnimeUrlClassification,
  type ResolvedAnimeMedia,
} from './types.js';

export const ANIMEUNITY_ORIGIN = 'https://www.animeunity.so';
export const ANIMEUNITY_PAGE_HOSTS = ['animeunity.so'] as const;
export const ANIMEUNITY_PLAYER_HOSTS = ['vixcloud.co'] as const;
export const ANIMEUNITY_MEDIA_HOSTS = ['vixcloud.co', 'vix-content.net'] as const;

const ANIMEUNITY_PATH = /^\/anime\/([a-z0-9][a-z0-9_-]*)(?:\/(\d+))?\/?$/i;

interface RecordLike {
  [key: string]: unknown;
}

interface VixStream {
  name?: unknown;
  active?: unknown;
  url?: unknown;
}

export interface ParsedVixCloudPlayer {
  candidates: AnimeMediaCandidate[];
}

export function classifyAnimeUnityUrl(rawUrl: string | URL): AnimeUrlClassification | null {
  let url: URL;
  try {
    url = assertAllowedArchiveUrl(rawUrl, ANIMEUNITY_PAGE_HOSTS);
  } catch {
    return null;
  }
  const match = ANIMEUNITY_PATH.exec(url.pathname);
  if (!match) return null;
  const identifier = match[1];
  if (!identifier) return null;
  const episodeId = match[2];
  const slug = identifier.replace(/^\d+-/, '') || identifier;
  const canonicalSeriesUrl = `${ANIMEUNITY_ORIGIN}/anime/${identifier}`;
  return {
    source: 'animeunity',
    kind: episodeId ? 'episode' : 'series',
    canonicalUrl: episodeId ? `${canonicalSeriesUrl}/${episodeId}` : canonicalSeriesUrl,
    canonicalSeriesUrl,
    seriesId: identifier,
    slug,
    ...(episodeId ? { episodeId } : {}),
  };
}

/** Parse the structured attributes rendered by AnimeUnity's `video-player` Vue island. */
export function parseAnimeUnityPage(
  html: string,
  pageUrl: string | URL,
): AnimeArchiveSeries | null {
  const classification = classifyAnimeUnityUrl(pageUrl);
  if (!classification) return null;
  const $ = cheerio.load(html);
  const player = $('video-player').first();
  const anime = parseJsonRecord(player.attr('anime'));
  if (!anime) return null;

  const sourceId = asString(anime['id']);
  const title =
    asString(anime['title']) ?? asString(anime['title_eng']) ?? asString(anime['title_it']);
  if (!sourceId || !title) return null;
  const slug = asString(anime['slug']) ?? classification.slug;
  const aliases = uniqueStrings([
    title,
    asString(anime['title_eng']),
    asString(anime['title_it']),
    slug.replace(/-/g, ' '),
  ]);
  const episodeValues = parseJsonArray(player.attr('episodes'));
  const episodes = parseAnimeUnityEpisodes(
    episodeValues,
    sourceId,
    slug,
    title,
    classification.canonicalSeriesUrl,
  );
  const declaredCount = asNonNegativeInteger(anime['episodes_count']);
  const episodeCount = declaredCount && declaredCount > 0 ? declaredCount : episodes.length;
  const description = asString(anime['plot']);
  const coverUrl = asHttpUrl(asString(anime['imageurl']), classification.canonicalSeriesUrl);
  const genres = Array.isArray(anime['genres'])
    ? uniqueStrings(
        anime['genres'].map((genre) =>
          isRecord(genre) ? asString(genre['name']) : asString(genre),
        ),
      )
    : [];

  return {
    source: 'animeunity',
    sourceId,
    slug,
    title,
    aliases,
    canonicalUrl: classification.canonicalSeriesUrl,
    ...(coverUrl ? { coverUrl } : {}),
    ...(description ? { description } : {}),
    status: animeUnityStatus(anime['status']),
    genres,
    ...(episodeCount > 0 ? { episodeCount } : {}),
    episodes,
    ...(asString(anime['day']) ? { releaseWeekday: asString(anime['day']) } : {}),
    ...(asString(anime['date']) ? { year: asString(anime['date']) } : {}),
    ...(asString(anime['season']) ? { season: asString(anime['season']) } : {}),
    ...(asString(anime['studio']) ? { studio: asString(anime['studio']) } : {}),
    ...(asFiniteNumber(anime['score']) !== undefined
      ? { score: asFiniteNumber(anime['score']) }
      : {}),
    externalIds: {
      ...(asPositiveInteger(anime['anilist_id']) !== undefined
        ? { anilist: asPositiveInteger(anime['anilist_id']) }
        : {}),
      ...(asPositiveInteger(anime['mal_id']) !== undefined
        ? { mal: asPositiveInteger(anime['mal_id']) }
        : {}),
    },
  };
}

/** Parse the bounded records embedded by AnimeUnity's public `/archivio?title=…` page. */
export function parseAnimeUnitySearchResults(
  html: string,
  limit: number,
): AnimeArchiveSearchResult[] {
  const $ = cheerio.load(html);
  const rawRecords = parseJsonArray($('archivio[records]').first().attr('records'));
  const boundedLimit = Math.min(10, Math.max(1, Math.trunc(limit) || 1));
  const results: AnimeArchiveSearchResult[] = [];
  const seen = new Set<string>();

  for (const entry of rawRecords) {
    if (!isRecord(entry)) continue;
    const id = asPositiveInteger(entry['id']);
    const slug = asString(entry['slug']);
    const title = asString(entry['title']);
    if (!id || !slug || !title) continue;
    const classification = classifyAnimeUnityUrl(`${ANIMEUNITY_ORIGIN}/anime/${id}-${slug}`);
    if (!classification || classification.kind !== 'series' || seen.has(classification.seriesId)) {
      continue;
    }
    seen.add(classification.seriesId);
    const coverUrl = asHttpUrl(asString(entry['imageurl']), classification.canonicalUrl);
    const episodeCount =
      asNonNegativeInteger(entry['real_episodes_count']) ??
      asNonNegativeInteger(entry['episodes_count']);
    const genres = Array.isArray(entry['genres'])
      ? uniqueStrings(
          entry['genres'].map((genre) =>
            isRecord(genre) ? asString(genre['name']) : asString(genre),
          ),
        )
      : [];
    results.push({
      source: 'animeunity',
      sourceId: String(id),
      slug,
      title,
      canonicalUrl: classification.canonicalUrl,
      ...(coverUrl ? { coverUrl } : {}),
      status: animeUnityStatus(entry['status']),
      genres,
      ...(episodeCount !== undefined ? { episodeCount } : {}),
      ...(asString(entry['date']) ? { year: asString(entry['date']) } : {}),
    });
    if (results.length >= boundedLimit) break;
  }

  return results;
}

/** Parse direct download plus bounded VixCloud playlist/server fallbacks. */
export function parseVixCloudPlayer(html: string, playerUrl: string | URL): ParsedVixCloudPlayer {
  const player = assertAllowedArchiveUrl(playerUrl, ANIMEUNITY_PLAYER_HOSTS);
  const safeReferer = new URL('/', player).toString();
  const masterBlock = assignmentBlock(html, 'masterPlaylist');
  const masterUrl = extractObjectString(masterBlock, 'url');
  const masterParams = new Map<string, string>();
  for (const key of ['token', 'expires', 'asn']) {
    const value = extractObjectString(masterBlock, key);
    if (value) masterParams.set(key, value);
  }

  const rawCandidates: Array<{
    url: string;
    kind: 'download' | 'stream';
    label: string;
    active?: boolean | undefined;
  }> = [];
  const direct = extractAssignmentString(html, 'downloadUrl');
  if (direct) rawCandidates.push({ url: direct, kind: 'download', label: 'download' });
  if (masterUrl) {
    rawCandidates.push({
      url: addMissingParams(masterUrl, masterParams),
      kind: 'stream',
      label: 'master',
      active: true,
    });
  }

  const streamsValue = extractArrayAssignment(html, 'streams');
  if (Array.isArray(streamsValue)) {
    for (const entry of streamsValue as VixStream[]) {
      if (!isRecord(entry)) continue;
      const url = asString(entry['url']);
      if (!url) continue;
      rawCandidates.push({
        url: addMissingParams(url, masterParams),
        kind: 'stream',
        label: asString(entry['name']) ?? 'stream',
        active: entry['active'] === true,
      });
    }
  }

  const seen = new Set<string>();
  const candidates: AnimeMediaCandidate[] = [];
  for (const candidate of rawCandidates) {
    let url: URL;
    try {
      url = assertAllowedArchiveUrl(candidate.url, ANIMEUNITY_MEDIA_HOSTS);
    } catch {
      continue;
    }
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      url: key,
      kind: candidate.kind,
      label: candidate.label,
      ...(mimeTypeForUrl(url) ? { mimeType: mimeTypeForUrl(url) } : {}),
      ...(candidate.active !== undefined ? { active: candidate.active } : {}),
      ...(expiryFromUrl(url) ? { expiresAt: expiryFromUrl(url) } : {}),
      requestHeaders: { referer: safeReferer },
    });
  }
  return { candidates };
}

export class AnimeUnityAdapter implements AnimeSourceAdapter {
  readonly source = 'animeunity' as const;

  constructor(private readonly http: AnimeArchiveHttpClient = new SafeAnimeArchiveHttpClient()) {}

  classify(url: string | URL): AnimeUrlClassification | null {
    return classifyAnimeUnityUrl(url);
  }

  async search(
    query: string,
    limit = 5,
    signal?: AbortSignal,
  ): Promise<AnimeArchiveSearchResult[]> {
    const normalized = query.trim().replace(/\s+/g, ' ');
    if (normalized.length < 2) return [];
    const boundedLimit = Math.min(10, Math.max(1, Math.trunc(limit) || 1));
    const url = new URL('/archivio', ANIMEUNITY_ORIGIN);
    url.searchParams.set('title', normalized.slice(0, 120));
    const response = await this.http.fetchText(url, {
      allowedHosts: ANIMEUNITY_PAGE_HOSTS,
      signal,
      allowedContentTypes: ['text/html', 'application/xhtml+xml'],
    });
    return parseAnimeUnitySearchResults(response.text, boundedLimit);
  }

  async getSeries(url: string | URL, signal?: AbortSignal): Promise<AnimeArchiveSeries> {
    const classification = requireAnimeUnityUrl(url);
    const response = await this.http.fetchText(classification.canonicalSeriesUrl, {
      allowedHosts: ANIMEUNITY_PAGE_HOSTS,
      signal,
    });
    const series = parseAnimeUnityPage(response.text, classification.canonicalSeriesUrl);
    if (!series) {
      throw new AnimeArchiveError(
        'source_layout_changed',
        'AnimeUnity series metadata is unavailable',
      );
    }
    return series;
  }

  async getEpisode(url: string | URL, signal?: AbortSignal): Promise<AnimeArchiveEpisode> {
    const classification = requireAnimeUnityEpisode(url);
    const response = await this.http.fetchText(classification.canonicalUrl, {
      allowedHosts: ANIMEUNITY_PAGE_HOSTS,
      signal,
    });
    const series = parseAnimeUnityPage(response.text, classification.canonicalUrl);
    if (!series) {
      throw new AnimeArchiveError(
        'source_layout_changed',
        'AnimeUnity episode metadata is unavailable',
      );
    }
    const episode = series.episodes.find((entry) => entry.sourceId === classification.episodeId);
    if (!episode) {
      throw new AnimeArchiveError('episode_not_found', 'AnimeUnity episode was not enumerated');
    }
    return episode;
  }

  async listEpisodes(
    series: AnimeArchiveSeries,
    signal?: AbortSignal,
  ): Promise<AnimeArchiveEpisode[]> {
    if (series.source !== this.source) {
      throw new AnimeArchiveError('source_mismatch', 'series does not belong to AnimeUnity');
    }
    return (await this.getSeries(series.canonicalUrl, signal)).episodes;
  }

  async resolveMedia(
    episode: AnimeArchiveEpisode,
    signal?: AbortSignal,
  ): Promise<ResolvedAnimeMedia> {
    if (episode.source !== this.source) {
      throw new AnimeArchiveError('source_mismatch', 'episode does not belong to AnimeUnity');
    }
    const classification = requireAnimeUnityEpisode(episode.canonicalUrl);
    if (classification.episodeId !== episode.sourceId) {
      throw new AnimeArchiveError(
        'source_mismatch',
        'AnimeUnity episode id does not match its URL',
      );
    }

    // This endpoint is deliberately called for every resolution. Its signed result is ephemeral.
    const endpoint = new URL(
      `/embed-url/${encodeURIComponent(episode.sourceId)}`,
      ANIMEUNITY_ORIGIN,
    );
    const embedResponse = await this.http.fetchText(endpoint, {
      allowedHosts: ANIMEUNITY_PAGE_HOSTS,
      signal,
      referer: classification.canonicalUrl,
      headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json,text/plain' },
    });
    const embedUrl = extractEmbedUrl(embedResponse.text);
    if (!embedUrl) {
      throw new AnimeArchiveError('media_unavailable', 'AnimeUnity did not return an embed URL');
    }
    const validatedEmbed = assertAllowedArchiveUrl(embedUrl, ANIMEUNITY_PLAYER_HOSTS);
    const playerResponse = await this.http.fetchText(validatedEmbed, {
      allowedHosts: ANIMEUNITY_PLAYER_HOSTS,
      signal,
      referer: classification.canonicalUrl,
    });
    const parsed = parseVixCloudPlayer(playerResponse.text, validatedEmbed);
    if (parsed.candidates.length === 0) {
      throw new AnimeArchiveError('media_unavailable', 'VixCloud exposed no supported media');
    }
    return {
      source: this.source,
      episode,
      candidates: parsed.candidates,
      resolvedAt: new Date(),
    };
  }
}

function parseAnimeUnityEpisodes(
  raw: unknown[],
  seriesId: string,
  seriesSlug: string,
  seriesTitle: string,
  canonicalSeriesUrl: string,
): AnimeArchiveEpisode[] {
  const episodes: AnimeArchiveEpisode[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (Number(entry['hidden']) === 1 || Number(entry['public']) === 0) continue;
    const sourceId = asString(entry['id']);
    const number = asString(entry['number']);
    if (!sourceId || !/^\d+$/.test(sourceId) || !number || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const releasedAt = parseRemoteDate(entry['created_at'] ?? entry['updated_at']);
    episodes.push({
      source: 'animeunity',
      sourceId,
      seriesId,
      seriesSlug,
      seriesTitle,
      number,
      order: episodeOrder(number),
      title: `${seriesTitle} — Episodio ${number}`,
      canonicalUrl: `${canonicalSeriesUrl}/${sourceId}`,
      canonicalSeriesUrl,
      ...(releasedAt ? { releasedAt } : {}),
    });
  }
  return episodes.sort(compareAnimeEpisodes);
}

function requireAnimeUnityUrl(url: string | URL): AnimeUrlClassification {
  const classification = classifyAnimeUnityUrl(url);
  if (!classification) {
    throw new AnimeArchiveError('unsupported_url', 'unsupported AnimeUnity URL');
  }
  return classification;
}

function requireAnimeUnityEpisode(url: string | URL): AnimeUrlClassification {
  const classification = requireAnimeUnityUrl(url);
  if (classification.kind !== 'episode' || !classification.episodeId) {
    throw new AnimeArchiveError('unsupported_url', 'AnimeUnity episode URL required');
  }
  return classification;
}

function extractEmbedUrl(raw: string): string | null {
  const value = raw.trim();
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    // AnimeUnity currently labels the response JSON while returning a bare URL string.
  }
  return findUrlValue(parsed);
}

function findUrlValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
    return /^https?:\/\//i.test(trimmed) ? trimmed : null;
  }
  if (!isRecord(value)) return null;
  for (const key of ['url', 'embed_url', 'embedUrl', 'link', 'data']) {
    const nested = findUrlValue(value[key]);
    if (nested) return nested;
  }
  return null;
}

function assignmentBlock(html: string, name: string): string {
  const startMatch = new RegExp(`window\\.${name}\\s*=`).exec(html);
  if (!startMatch) return '';
  const start = startMatch.index + startMatch[0].length;
  const tail = html.slice(start);
  const ends = [tail.indexOf('</script>'), tail.search(/\bwindow\.[A-Za-z_$][\w$]*\s*=/)]
    .filter((value) => value >= 0)
    .sort((a, b) => a - b);
  return tail.slice(0, ends[0] ?? tail.length);
}

function extractAssignmentString(html: string, name: string): string | null {
  const match = new RegExp(`window\\.${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`).exec(html);
  return match?.[2] ? decodeJsString(match[2]) : null;
}

function extractArrayAssignment(html: string, name: string): unknown {
  const match = new RegExp(`window\\.${name}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`).exec(html);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return null;
  }
}

function extractObjectString(block: string, key: string): string | null {
  const match = new RegExp(`['"]?${key}['"]?\\s*:\\s*(['"])([\\s\\S]*?)\\1`).exec(block);
  return match?.[2] ? decodeJsString(match[2]) : null;
}

function decodeJsString(value: string): string {
  return value
    .replace(/\\\//g, '/')
    .replace(/\\u([\da-f]{4})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/\\x([\da-f]{2})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/\\(['"\\])/g, '$1');
}

function addMissingParams(rawUrl: string, params: ReadonlyMap<string, string>): string {
  try {
    const url = new URL(rawUrl);
    for (const [key, value] of params) {
      if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function mimeTypeForUrl(url: URL): string | undefined {
  if (/\.m3u8$/i.test(url.pathname) || /\/playlist\//i.test(url.pathname)) {
    return 'application/x-mpegurl';
  }
  if (/\.mp4$/i.test(url.pathname)) return 'video/mp4';
  if (/\.webm$/i.test(url.pathname)) return 'video/webm';
  return undefined;
}

function animeUnityStatus(value: unknown): 'ongoing' | 'completed' | 'unknown' {
  const status = asString(value)?.toLocaleLowerCase('it-IT') ?? '';
  if (/in corso|ongoing|airing/.test(status)) return 'ongoing';
  if (/terminat|complet|finit|finished/.test(status)) return 'completed';
  return 'unknown';
}

function parseJsonRecord(value: string | undefined): RecordLike | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value: string | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(asString(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text) continue;
    const key = text.toLocaleLowerCase('it-IT');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function asHttpUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseRemoteDate(value: unknown): Date | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Used by tests/integration code when checking a player-provided URL before handing it off. */
export function isAnimeUnityMediaHost(url: string | URL): boolean {
  try {
    const parsed = url instanceof URL ? url : new URL(url);
    return hostMatchesAny(parsed, ANIMEUNITY_MEDIA_HOSTS);
  } catch {
    return false;
  }
}
