import * as cheerio from 'cheerio';
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
  type AnimeSourceAdapter,
  type AnimeUrlClassification,
  type ResolvedAnimeMedia,
} from './types.js';

export const HENTAISATURN_ORIGIN = 'https://www.hentaisaturn.tv';
export const HENTAISATURN_PAGE_HOSTS = ['hentaisaturn.tv'] as const;
export const HENTAISATURN_PLAYER_HOSTS = ['play.hentaisaturn.tv'] as const;
export const HENTAISATURN_MEDIA_HOSTS = ['hcontent.net'] as const;
export const HENTAISATURN_ASSET_HOSTS = ['hentaisaturn.tv'] as const;

const SERIES_PATH = /^\/hentai\/([a-z0-9][a-z0-9_-]*)\/?$/i;
const EPISODE_PATH = /^\/(episode|hentai)\/([a-z0-9][a-z0-9_-]*)\/ep-(\d+(?:\.\d+)?)\/?$/i;

interface RecordLike {
  [key: string]: unknown;
}

interface HentaiSaturnEmbedConfig {
  id: string;
  key: string;
  expires: string;
}

export function classifyHentaiSaturnUrl(rawUrl: string | URL): AnimeUrlClassification | null {
  let url: URL;
  try {
    url = assertAllowedArchiveUrl(rawUrl, HENTAISATURN_PAGE_HOSTS);
  } catch {
    return null;
  }
  const episode = EPISODE_PATH.exec(url.pathname);
  if (episode) {
    const slug = episode[2];
    const number = episode[3];
    if (!slug || !number) return null;
    const canonicalSeriesUrl = `${HENTAISATURN_ORIGIN}/hentai/${slug}`;
    return {
      source: 'hentaisaturn',
      kind: 'episode',
      canonicalUrl: `${HENTAISATURN_ORIGIN}/episode/${slug}/ep-${number}`,
      canonicalSeriesUrl,
      seriesId: slug,
      slug,
      episodeId: `${slug}:ep-${number}`,
      episodeNumber: number,
    };
  }
  const series = SERIES_PATH.exec(url.pathname);
  const slug = series?.[1];
  if (!slug) return null;
  const canonicalSeriesUrl = `${HENTAISATURN_ORIGIN}/hentai/${slug}`;
  return {
    source: 'hentaisaturn',
    kind: 'series',
    canonicalUrl: canonicalSeriesUrl,
    canonicalSeriesUrl,
    seriesId: slug,
    slug,
  };
}

/** Parse one current HentaiSaturn series page using JSON-LD plus its visible episode tiles. */
export function parseHentaiSaturnSeriesPage(
  html: string,
  pageUrl: string | URL,
): AnimeArchiveSeries | null {
  const classification = classifyHentaiSaturnUrl(pageUrl);
  if (!classification) return null;
  const $ = cheerio.load(html);
  const schema = findSchema($, 'TVSeries');
  const title = asString(schema?.['name']) ?? cleanText($('h1').first().text());
  if (!title) return null;
  const aliases = uniqueStrings([
    title,
    ...asStringArray(schema?.['alternateName']),
    classification.slug.replace(/-/g, ' '),
  ]);
  const metadata = readInfoRows($);
  const episodes = parseHentaiSaturnEpisodeLinks(
    $,
    classification.slug,
    title,
    classification.canonicalSeriesUrl,
  );
  const declaredCount = asPositiveInteger(schema?.['numberOfEpisodes']);
  const coverUrl = schemaImage(schema?.['image'], classification.canonicalSeriesUrl);
  const description = asString(schema?.['description']);
  const genres = uniqueStrings(asStringArray(schema?.['genre']));
  const year = yearFromValue(schema?.['datePublished']) ?? yearFromValue(metadata.get('uscita'));
  const studio = metadata.get('studio');

  return {
    source: 'hentaisaturn',
    sourceId: classification.slug,
    slug: classification.slug,
    title,
    aliases,
    canonicalUrl: classification.canonicalSeriesUrl,
    ...(coverUrl ? { coverUrl } : {}),
    ...(description ? { description } : {}),
    status: hentaiSaturnStatus(metadata.get('stato') ?? schema?.['status']),
    genres,
    ...(declaredCount !== undefined || episodes.length > 0
      ? { episodeCount: declaredCount ?? episodes.length }
      : {}),
    episodes,
    ...(year ? { year } : {}),
    ...(studio ? { studio } : {}),
    ...(asFiniteNumber(schemaAggregateScore(schema)) !== undefined
      ? { score: asFiniteNumber(schemaAggregateScore(schema)) }
      : {}),
    externalIds: {},
  };
}

/** Parse the episode JSON-LD without trusting the page to provide a media URL directly. */
export function parseHentaiSaturnEpisodePage(
  html: string,
  pageUrl: string | URL,
): AnimeArchiveEpisode | null {
  const classification = classifyHentaiSaturnUrl(pageUrl);
  if (
    !classification ||
    classification.kind !== 'episode' ||
    !classification.episodeNumber ||
    !classification.episodeId
  ) {
    return null;
  }
  const $ = cheerio.load(html);
  const schema = findSchema($, 'TVEpisode');
  const number = asString(schema?.['episodeNumber']) ?? classification.episodeNumber;
  const partOfSeries = isRecord(schema?.['partOfSeries']) ? schema?.['partOfSeries'] : undefined;
  const seriesTitle =
    asString(partOfSeries?.['name']) ??
    cleanText($('h1').first().text()).replace(/\s*[—-]\s*Episodio.*$/i, '') ??
    classification.slug.replace(/-/g, ' ');
  const releasedAt = parseRemoteDate(schema?.['datePublished']);
  return {
    source: 'hentaisaturn',
    sourceId: classification.episodeId,
    seriesId: classification.seriesId,
    seriesSlug: classification.slug,
    seriesTitle,
    number,
    order: episodeOrder(number),
    title: asString(schema?.['name']) ?? `${seriesTitle} — Episodio ${number}`,
    canonicalUrl: classification.canonicalUrl,
    canonicalSeriesUrl: classification.canonicalSeriesUrl,
    ...(releasedAt ? { releasedAt } : {}),
  };
}

/** Parse the site's small public `/api/search` result without crawling result pages. */
export function parseHentaiSaturnSearchResults(
  raw: string,
  limit: number,
): AnimeArchiveSearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['results'])) return [];
  const results: AnimeArchiveSearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of parsed['results']) {
    if (!isRecord(entry)) continue;
    const title = asString(entry['title']);
    const urlValue = asString(entry['url']);
    if (!title || !urlValue) continue;
    const classification = classifyHentaiSaturnUrl(new URL(urlValue, HENTAISATURN_ORIGIN));
    if (!classification || classification.kind !== 'series' || seen.has(classification.seriesId)) {
      continue;
    }
    seen.add(classification.seriesId);
    const genres = Array.isArray(entry['genres'])
      ? uniqueStrings(
          entry['genres'].map((genre) =>
            isRecord(genre) ? asString(genre['name']) : asString(genre),
          ),
        )
      : [];
    const statusValue = isRecord(entry['status'])
      ? (entry['status']['tone'] ?? entry['status']['label'])
      : entry['status'];
    const coverUrl = schemaImage(entry['poster'], classification.canonicalUrl);
    const episodeCount = asPositiveInteger(entry['episodes']);
    results.push({
      source: 'hentaisaturn',
      sourceId: classification.seriesId,
      slug: classification.slug,
      title,
      canonicalUrl: classification.canonicalUrl,
      ...(coverUrl ? { coverUrl } : {}),
      status: hentaiSaturnStatus(statusValue),
      genres,
      ...(episodeCount !== undefined ? { episodeCount } : {}),
      ...(yearFromValue(entry['year']) ? { year: yearFromValue(entry['year']) } : {}),
    });
    if (results.length >= limit) break;
  }
  return results;
}

export class HentaiSaturnAdapter implements AnimeSourceAdapter {
  readonly source = 'hentaisaturn' as const;

  constructor(private readonly http: AnimeArchiveHttpClient = new SafeAnimeArchiveHttpClient()) {}

  classify(url: string | URL): AnimeUrlClassification | null {
    return classifyHentaiSaturnUrl(url);
  }

  async search(
    query: string,
    limit = 5,
    signal?: AbortSignal,
  ): Promise<AnimeArchiveSearchResult[]> {
    const normalized = query.trim().replace(/\s+/g, ' ');
    if (normalized.length < 2) return [];
    const boundedLimit = Math.min(10, Math.max(1, Math.trunc(limit) || 1));
    const url = new URL('/api/search', HENTAISATURN_ORIGIN);
    url.searchParams.set('q', normalized.slice(0, 120));
    const response = await this.http.fetchText(url, {
      allowedHosts: HENTAISATURN_PAGE_HOSTS,
      signal,
      allowedContentTypes: ['application/json'],
      headers: { accept: 'application/json' },
    });
    return parseHentaiSaturnSearchResults(response.text, boundedLimit);
  }

  async getSeries(url: string | URL, signal?: AbortSignal): Promise<AnimeArchiveSeries> {
    const classification = requireHentaiSaturnUrl(url);
    const response = await this.http.fetchText(classification.canonicalSeriesUrl, {
      allowedHosts: HENTAISATURN_PAGE_HOSTS,
      signal,
    });
    const series = parseHentaiSaturnSeriesPage(response.text, classification.canonicalSeriesUrl);
    if (!series) {
      throw new AnimeArchiveError(
        'source_layout_changed',
        'HentaiSaturn series metadata is unavailable',
      );
    }
    return series;
  }

  async getEpisode(url: string | URL, signal?: AbortSignal): Promise<AnimeArchiveEpisode> {
    const classification = requireHentaiSaturnEpisode(url);
    const response = await this.http.fetchText(classification.canonicalUrl, {
      allowedHosts: HENTAISATURN_PAGE_HOSTS,
      signal,
    });
    const episode = parseHentaiSaturnEpisodePage(response.text, classification.canonicalUrl);
    if (!episode) {
      throw new AnimeArchiveError(
        'source_layout_changed',
        'HentaiSaturn episode metadata is unavailable',
      );
    }
    return episode;
  }

  async listEpisodes(
    series: AnimeArchiveSeries,
    signal?: AbortSignal,
  ): Promise<AnimeArchiveEpisode[]> {
    if (series.source !== this.source) {
      throw new AnimeArchiveError('source_mismatch', 'series does not belong to HentaiSaturn');
    }
    return (await this.getSeries(series.canonicalUrl, signal)).episodes;
  }

  async resolveMedia(
    episode: AnimeArchiveEpisode,
    signal?: AbortSignal,
  ): Promise<ResolvedAnimeMedia> {
    if (episode.source !== this.source) {
      throw new AnimeArchiveError('source_mismatch', 'episode does not belong to HentaiSaturn');
    }
    const classification = requireHentaiSaturnEpisode(episode.canonicalUrl);
    if (classification.episodeId !== episode.sourceId) {
      throw new AnimeArchiveError(
        'source_mismatch',
        'HentaiSaturn episode id does not match its URL',
      );
    }

    const landing = await this.http.fetchText(classification.canonicalUrl, {
      allowedHosts: HENTAISATURN_PAGE_HOSTS,
      signal,
    });
    const watchUrl = findWatchPageUrl(landing.text, classification);
    const watch = await this.http.fetchText(watchUrl, {
      allowedHosts: HENTAISATURN_PAGE_HOSTS,
      signal,
      referer: classification.canonicalUrl,
    });
    const embedUrl = findPlayerEmbedUrl(watch.text, watchUrl);
    if (!embedUrl) {
      throw new AnimeArchiveError('media_unavailable', 'HentaiSaturn player iframe is unavailable');
    }
    const embed = assertAllowedArchiveUrl(embedUrl, HENTAISATURN_PLAYER_HOSTS);
    const embedResponse = await this.http.fetchText(embed, {
      allowedHosts: HENTAISATURN_PLAYER_HOSTS,
      signal,
      referer: watchUrl,
    });
    const config = parseEmbedConfig(embedResponse.text);
    if (!config || !embed.pathname.endsWith(`/embed/${config.id}`)) {
      throw new AnimeArchiveError('media_unavailable', 'HentaiSaturn player config is invalid');
    }

    const playlistUrl = new URL(`/embed/${config.id}/playlist`, embed);
    playlistUrl.searchParams.set('token', config.key);
    playlistUrl.searchParams.set('expires', config.expires);
    const playlistResponse = await this.http.fetchText(playlistUrl, {
      allowedHosts: HENTAISATURN_PLAYER_HOSTS,
      signal,
      referer: embed.toString(),
      allowedContentTypes: ['application/json'],
      headers: { accept: 'application/json' },
    });
    const playlist = parseJsonRecord(playlistResponse.text);
    if (!playlist) {
      throw new AnimeArchiveError('media_unavailable', 'HentaiSaturn playlist is invalid');
    }
    const mediaValue = decodePlayerField(playlist['d'], config.key);
    if (!mediaValue || mediaValue.startsWith('youtube/')) {
      throw new AnimeArchiveError('media_unavailable', 'HentaiSaturn exposed no direct media');
    }
    const mediaUrl = assertAllowedArchiveUrl(mediaValue, HENTAISATURN_MEDIA_HOSTS);
    const posterValue = decodePlayerField(playlist['p'], config.key);
    const posterUrl = optionalAllowedUrl(posterValue, HENTAISATURN_ASSET_HOSTS);
    const configExpiry = dateFromEpoch(config.expires);
    const mediaExpiry = expiryFromUrl(mediaUrl) ?? configExpiry;
    return {
      source: this.source,
      episode,
      candidates: [
        {
          url: mediaUrl.toString(),
          kind: /\.m3u8$/i.test(mediaUrl.pathname) ? 'stream' : 'download',
          label: 'primary',
          ...(mimeTypeForUrl(mediaUrl) ? { mimeType: mimeTypeForUrl(mediaUrl) } : {}),
          ...(mediaExpiry ? { expiresAt: mediaExpiry } : {}),
          requestHeaders: { referer: new URL('/', embed).toString() },
        },
      ],
      ...(posterUrl ? { posterUrl } : {}),
      resolvedAt: new Date(),
    };
  }
}

function parseHentaiSaturnEpisodeLinks(
  $: ReturnType<typeof cheerio.load>,
  seriesSlug: string,
  seriesTitle: string,
  canonicalSeriesUrl: string,
): AnimeArchiveEpisode[] {
  const episodes: AnimeArchiveEpisode[] = [];
  const seen = new Set<string>();
  $('a.ep-tile[href], a[href*="/episode/"]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const classification = classifyHentaiSaturnUrl(new URL(href, HENTAISATURN_ORIGIN));
    if (
      !classification ||
      classification.kind !== 'episode' ||
      classification.seriesId !== seriesSlug ||
      !classification.episodeId ||
      !classification.episodeNumber ||
      seen.has(classification.episodeId)
    ) {
      return;
    }
    seen.add(classification.episodeId);
    episodes.push({
      source: 'hentaisaturn',
      sourceId: classification.episodeId,
      seriesId: seriesSlug,
      seriesSlug,
      seriesTitle,
      number: classification.episodeNumber,
      order: episodeOrder(classification.episodeNumber),
      title: `${seriesTitle} — Episodio ${classification.episodeNumber}`,
      canonicalUrl: classification.canonicalUrl,
      canonicalSeriesUrl,
    });
  });
  return episodes.sort(compareAnimeEpisodes);
}

function findWatchPageUrl(html: string, classification: AnimeUrlClassification): string {
  const $ = cheerio.load(html);
  const href = $('.ept-btn--play[href]').first().attr('href');
  const fallback = `${classification.canonicalSeriesUrl}/ep-${classification.episodeNumber}`;
  const candidate = href ? new URL(href, HENTAISATURN_ORIGIN).toString() : fallback;
  let parsed: AnimeUrlClassification | null = null;
  try {
    const url = assertAllowedArchiveUrl(candidate, HENTAISATURN_PAGE_HOSTS);
    if (!url.pathname.startsWith('/hentai/')) {
      throw new Error('not a HentaiSaturn watch path');
    }
    parsed = classifyHentaiSaturnUrl(url);
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    parsed.kind !== 'episode' ||
    parsed.seriesId !== classification.seriesId ||
    parsed.episodeNumber !== classification.episodeNumber
  ) {
    throw new AnimeArchiveError('media_unavailable', 'HentaiSaturn watch URL is invalid');
  }
  return candidate;
}

function findPlayerEmbedUrl(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  const values = $('#watch-iframe[src], iframe[src]')
    .map((_index, element) => $(element).attr('src'))
    .get();
  for (const value of values) {
    if (!value) continue;
    try {
      const url = assertAllowedArchiveUrl(new URL(value, baseUrl), HENTAISATURN_PLAYER_HOSTS);
      if (/^\/embed\/\d+$/.test(url.pathname)) return url.toString();
    } catch {
      // Advertising and unrelated iframes are intentionally ignored.
    }
  }
  return null;
}

function parseEmbedConfig(html: string): HentaiSaturnEmbedConfig | null {
  const match = /window\.__E\s*=\s*\{([\s\S]*?)\}/.exec(html);
  const block = match?.[1];
  if (!block) return null;
  const id = propertyValue(block, 'i', /\d+/);
  const key = propertyValue(block, 'k', /[A-Za-z0-9._~-]{8,256}/);
  const expires = propertyValue(block, 'e', /\d{9,13}/);
  return id && key && expires ? { id, key, expires } : null;
}

function propertyValue(block: string, key: string, allowed: RegExp): string | null {
  const match = new RegExp(`(?:^|[,\\s])['"]?${key}['"]?\\s*:\\s*['"]?([^,'"}\\s]+)`).exec(block);
  const value = match?.[1];
  return value && new RegExp(`^(?:${allowed.source})$`).test(value) ? value : null;
}

/** The public player XORs base64 bytes with its per-embed key; this is obfuscation, not DRM. */
export function decodeHentaiSaturnPlayerField(encoded: string, key: string): string | null {
  if (!encoded || !key || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || !/[A-Za-z0-9]/.test(encoded)) {
    return null;
  }
  try {
    const bytes = Buffer.from(encoded, 'base64');
    const keyBytes = Buffer.from(key, 'utf8');
    if (bytes.length === 0 || keyBytes.length === 0) return null;
    for (let index = 0; index < bytes.length; index += 1) {
      const keyByte = keyBytes[index % keyBytes.length];
      const byte = bytes[index];
      if (keyByte === undefined || byte === undefined) return null;
      bytes[index] = byte ^ keyByte;
    }
    const decoded = bytes.toString('utf8').trim();
    return decoded && !decoded.includes('\u0000') ? decoded : null;
  } catch {
    return null;
  }
}

function decodePlayerField(value: unknown, key: string): string | null {
  return typeof value === 'string' ? decodeHentaiSaturnPlayerField(value, key) : null;
}

function findSchema($: ReturnType<typeof cheerio.load>, expectedType: string): RecordLike | null {
  let found: RecordLike | null = null;
  $('script[type="application/ld+json"]').each((_index, element) => {
    if (found) return;
    const raw = $(element).html();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      found = findSchemaInValue(parsed, expectedType);
    } catch {
      // Ignore unrelated or malformed JSON-LD blocks.
    }
  });
  return found;
}

function findSchemaInValue(value: unknown, expectedType: string): RecordLike | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findSchemaInValue(entry, expectedType);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (value['@type'] === expectedType) return value;
  return findSchemaInValue(value['@graph'], expectedType);
}

function readInfoRows($: ReturnType<typeof cheerio.load>): Map<string, string> {
  const rows = new Map<string, string>();
  $('.hs-info-row').each((_index, element) => {
    const label = cleanText($(element).find('dt').first().text()).toLocaleLowerCase('it-IT');
    const value = cleanText($(element).find('dd').first().text());
    if (label && value) rows.set(label, value);
  });
  return rows;
}

function requireHentaiSaturnUrl(url: string | URL): AnimeUrlClassification {
  const classification = classifyHentaiSaturnUrl(url);
  if (!classification) {
    throw new AnimeArchiveError('unsupported_url', 'unsupported HentaiSaturn URL');
  }
  return classification;
}

function requireHentaiSaturnEpisode(url: string | URL): AnimeUrlClassification {
  const classification = requireHentaiSaturnUrl(url);
  if (
    classification.kind !== 'episode' ||
    !classification.episodeId ||
    !classification.episodeNumber
  ) {
    throw new AnimeArchiveError('unsupported_url', 'HentaiSaturn episode URL required');
  }
  return classification;
}

function parseJsonRecord(value: string): RecordLike | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return text && text !== '??' ? text : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter((entry): entry is string => !!entry);
  const single = asString(value);
  return single ? [single] : [];
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(asString(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hentaiSaturnStatus(value: unknown): 'ongoing' | 'completed' | 'unknown' {
  const status = asString(value)?.toLocaleLowerCase('it-IT') ?? '';
  if (/ongoing|in corso/.test(status)) return 'ongoing';
  if (/completed|finished|finito|terminat/.test(status)) return 'completed';
  return 'unknown';
}

function yearFromValue(value: unknown): string | undefined {
  const match = /\b(19|20)\d{2}\b/.exec(asString(value) ?? '');
  return match?.[0];
}

function schemaImage(value: unknown, base: string): string | undefined {
  const raw =
    asString(value) ??
    (isRecord(value) ? (asString(value['url']) ?? asString(value['contentUrl'])) : undefined);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, base);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function schemaAggregateScore(schema: RecordLike | null): unknown {
  const aggregate =
    schema && isRecord(schema['aggregateRating']) ? schema['aggregateRating'] : null;
  return aggregate?.['ratingValue'];
}

function parseRemoteDate(value: unknown): Date | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function optionalAllowedUrl(
  value: string | null,
  allowedHosts: readonly string[],
): string | undefined {
  if (!value) return undefined;
  try {
    return assertAllowedArchiveUrl(value, allowedHosts).toString();
  } catch {
    return undefined;
  }
}

function dateFromEpoch(value: string): Date | undefined {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function mimeTypeForUrl(url: URL): string | undefined {
  if (/\.m3u8$/i.test(url.pathname)) return 'application/x-mpegurl';
  if (/\.mp4$/i.test(url.pathname)) return 'video/mp4';
  if (/\.webm$/i.test(url.pathname)) return 'video/webm';
  return undefined;
}
