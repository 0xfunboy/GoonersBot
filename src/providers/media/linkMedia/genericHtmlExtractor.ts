import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import { buildSocialCaption, cleanSocialText } from './socialMetadata.js';
import type {
  LinkMediaKind,
  ExtractedMediaPost,
  LinkExtractor,
  LinkExtractorContext,
  PostStats,
} from './types.js';

interface MediaCandidate {
  url: string;
  hintedKind?: LinkMediaKind;
  mime?: string;
}

interface PageSocialMetadata {
  description?: string;
  author?: string;
  authorHandle?: string;
  stats: PostStats;
}

const JSON_LD_MAX_NODES = 2_048;
const JSON_LD_MAX_DEPTH = 32;

function abs(base: URL, value?: string): string | null {
  if (!value?.trim()) return null;
  try {
    const resolved = new URL(value.trim(), base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if (resolved.username || resolved.password) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function normalizedMime(value?: string): string | undefined {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mime || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return undefined;
  return mime;
}

function kindFromMime(mime?: string): LinkMediaKind | null {
  if (!mime) return null;
  if (mime === 'image/gif') return 'gif';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (
    mime === 'application/mp4' ||
    mime === 'application/vnd.apple.mpegurl' ||
    mime === 'application/x-mpegurl' ||
    mime === 'application/mpegurl' ||
    mime === 'application/dash+xml'
  ) {
    return 'video';
  }
  return null;
}

function kindFromUrl(url: string): LinkMediaKind {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = (url.split(/[?#]/, 1)[0] ?? url).toLowerCase();
  }
  if (/\.gif$/.test(pathname)) return 'gif';
  if (/\.(jpg|jpeg|png|webp|avif)$/.test(pathname)) return 'image';
  if (/\.(mp3|m4a|wav|ogg|flac)$/.test(pathname)) return 'audio';
  if (/\.(mp4|webm|mov|m3u8|mpd)$/.test(pathname)) return 'video';
  return 'document';
}

function candidateKind(candidate: MediaCandidate): LinkMediaKind {
  const mimeKind = kindFromMime(candidate.mime);
  if (mimeKind) return mimeKind;

  const urlKind = kindFromUrl(candidate.url);
  // GIF is a useful distinction from a static image even when the semantic source only says image.
  if (candidate.hintedKind === 'image' && urlKind === 'gif') return 'gif';
  return candidate.hintedKind ?? urlKind;
}

function addCandidate(
  candidates: Map<string, MediaCandidate>,
  base: URL,
  rawUrl: string | undefined,
  hintedKind?: LinkMediaKind,
  rawMime?: string,
): void {
  const resolved = abs(base, rawUrl);
  if (!resolved) return;

  const mime = normalizedMime(rawMime);
  const existing = candidates.get(resolved);
  if (existing) {
    existing.hintedKind ??= hintedKind;
    existing.mime ??= mime;
    return;
  }
  candidates.set(resolved, {
    url: resolved,
    ...(hintedKind ? { hintedKind } : {}),
    ...(mime ? { mime } : {}),
  });
}

function jsonLdTypes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase().split(/[/#]/).pop() ?? '');
}

function stringValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string => typeof entry === 'string');
}

function countValue(value: unknown): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function authorMetadata(value: unknown): { author?: string; authorHandle?: string } {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const text = cleanSocialText(candidate, 300);
      if (text && !/^https?:\/\//i.test(text)) return { author: text };
      continue;
    }
    if (!candidate || typeof candidate !== 'object') continue;
    const person = candidate as Record<string, unknown>;
    const author = cleanSocialText(stringValues(person.name)[0], 300);
    const authorHandle = cleanSocialText(stringValues(person.alternateName)[0], 200);
    if (author || authorHandle) {
      return {
        ...(author ? { author } : {}),
        ...(authorHandle ? { authorHandle } : {}),
      };
    }
  }
  return {};
}

function interactionType(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase();
  if (!value || typeof value !== 'object') return '';
  return stringValues((value as Record<string, unknown>)['@type'])
    .join(' ')
    .toLowerCase();
}

function addJsonLdMetadata(
  record: Record<string, unknown>,
  types: readonly string[],
  depth: number,
  metadata: PageSocialMetadata,
): void {
  const isContentNode =
    depth === 0 ||
    types.some((type) =>
      /^(?:article|blogposting|imageobject|newsarticle|socialmediaposting|videoobject|webpage)$/.test(
        type,
      ),
    );
  if (isContentNode) {
    metadata.description ??= cleanSocialText(stringValues(record.description)[0]);
    const author = authorMetadata(record.author);
    metadata.author ??= author.author;
    metadata.authorHandle ??= author.authorHandle;
    const comments = countValue(record.commentCount);
    if (comments !== undefined && metadata.stats.comments === undefined) {
      metadata.stats.comments = comments;
    }
  }

  if (!types.includes('interactioncounter')) return;
  const count = countValue(record.userInteractionCount ?? record.interactionCount);
  if (count === undefined) return;
  const action = interactionType(record.interactionType);
  if (/share|repost|retweet/.test(action)) metadata.stats.reposts ??= count;
  else if (/comment|reply/.test(action)) metadata.stats.comments ??= count;
  else if (/view|watch/.test(action)) metadata.stats.views ??= count;
  else if (/like|favorite|reactaction/.test(action)) metadata.stats.likes ??= count;
}

function addJsonLdCandidates(
  root: unknown,
  base: URL,
  candidates: Map<string, MediaCandidate>,
  metadata: PageSocialMetadata,
): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && visited < JSON_LD_MAX_NODES) {
    const current = stack.pop();
    if (!current) break;
    visited += 1;

    if (Array.isArray(current.value)) {
      if (current.depth >= JSON_LD_MAX_DEPTH) continue;
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;

    const record = current.value as Record<string, unknown>;
    const types = jsonLdTypes(record['@type']);
    addJsonLdMetadata(record, types, current.depth, metadata);
    const hintedKind = types.includes('videoobject')
      ? 'video'
      : types.includes('imageobject')
        ? 'image'
        : undefined;
    if (hintedKind) {
      const mime =
        stringValues(record['encodingFormat'])[0] ?? stringValues(record['fileFormat'])[0];
      for (const contentUrl of stringValues(record['contentUrl'])) {
        addCandidate(candidates, base, contentUrl, hintedKind, mime);
      }
    }

    if (current.depth >= JSON_LD_MAX_DEPTH) continue;
    const children = Object.values(record);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child && typeof child === 'object') {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

export const genericHtmlExtractor: LinkExtractor = {
  platform: 'generic',
  match: () => true,
  async extract(url: URL, ctx: LinkExtractorContext): Promise<ExtractedMediaPost | null> {
    const html = await fetchText(url.toString(), {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 3 * 1024 * 1024,
      userAgent: ctx.userAgent,
      signal: ctx.signal,
      validateUrl: ctx.validateUrl,
      ...(ctx.cookies ? { headers: { cookie: ctx.cookies } } : {}),
    });

    const $ = cheerio.load(html);
    const title =
      $('meta[property="og:title"]').attr('content') || $('title').first().text().trim();
    const rawDescription =
      $('meta[property="og:description"]').first().attr('content') ||
      $('meta[name="twitter:description"], meta[property="twitter:description"]')
        .first()
        .attr('content') ||
      $('meta[name="description"]').first().attr('content');
    const rawAuthor =
      $('meta[name="author"]').first().attr('content') ||
      $('meta[property="article:author"]').first().attr('content');
    const rawCreator = $('meta[name="twitter:creator"], meta[property="twitter:creator"]')
      .first()
      .attr('content');
    const metaDescription = cleanSocialText(rawDescription);
    const metaAuthor = cleanSocialText(rawAuthor, 300);
    const metaCreator = cleanSocialText(rawCreator, 200);
    const metadata: PageSocialMetadata = { stats: {} };
    if (metaDescription) metadata.description = metaDescription;
    if (metaAuthor && !/^https?:\/\//i.test(metaAuthor)) metadata.author = metaAuthor;
    if (metaCreator?.startsWith('@')) metadata.authorHandle = metaCreator;
    else if (!metadata.author && metaCreator) metadata.author = metaCreator;
    const candidates = new Map<string, MediaCandidate>();

    const metaMime = {
      video: $('meta[property="og:video:type"]').first().attr('content'),
      image: $('meta[property="og:image:type"]').first().attr('content'),
      audio: $('meta[property="og:audio:type"]').first().attr('content'),
      twitterStream: $(
        'meta[name="twitter:player:stream:content_type"], meta[property="twitter:player:stream:content_type"]',
      )
        .first()
        .attr('content'),
    };

    const metaRules: Array<{
      selector: string;
      kind: LinkMediaKind;
      mime?: string;
    }> = [
      {
        selector:
          'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]',
        kind: 'video',
        mime: metaMime.video,
      },
      {
        selector: 'meta[name="twitter:player:stream"], meta[property="twitter:player:stream"]',
        kind: 'video',
        mime: metaMime.twitterStream,
      },
      {
        selector:
          'meta[property="og:image"], meta[property="og:image:url"], meta[property="og:image:secure_url"]',
        kind: 'image',
        mime: metaMime.image,
      },
      {
        selector:
          'meta[property="og:audio"], meta[property="og:audio:url"], meta[property="og:audio:secure_url"]',
        kind: 'audio',
        mime: metaMime.audio,
      },
    ];
    for (const rule of metaRules) {
      $(rule.selector).each((_, element) => {
        addCandidate(candidates, url, $(element).attr('content'), rule.kind, rule.mime);
      });
    }

    $('video[src], video source[src]').each((_, element) => {
      addCandidate(candidates, url, $(element).attr('src'), 'video', $(element).attr('type'));
    });
    $('audio[src], audio source[src]').each((_, element) => {
      addCandidate(candidates, url, $(element).attr('src'), 'audio', $(element).attr('type'));
    });
    // Covers typed manifest and <picture> sources without treating arbitrary untyped page URLs as
    // media. Entries already found inside video/audio are simply enriched/deduplicated.
    $('source[src][type]').each((_, element) => {
      addCandidate(candidates, url, $(element).attr('src'), undefined, $(element).attr('type'));
    });

    $('script[type]').each((_, element) => {
      const type = $(element).attr('type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (type !== 'application/ld+json') return;
      const source = $(element)
        .text()
        .trim()
        .replace(/^\uFEFF/, '');
      if (!source) return;
      try {
        addJsonLdCandidates(JSON.parse(source) as unknown, url, candidates, metadata);
      } catch {
        // Invalid analytics/JSON-LD blocks are common and must not hide otherwise valid metadata.
      }
    });

    const canonicalCandidates: Array<string | undefined> = [];
    $('link[rel][href]').each((_, element) => {
      const rel = $(element).attr('rel')?.toLowerCase().split(/\s+/) ?? [];
      if (rel.includes('canonical')) canonicalCandidates.push($(element).attr('href'));
    });
    canonicalCandidates.push($('meta[property="og:url"]').first().attr('content'));
    const canonicalUrl =
      canonicalCandidates.map((candidate) => abs(url, candidate)).find(Boolean) ?? url.toString();

    const items = [...candidates.values()].slice(0, ctx.maxMediaPerUrl).map((candidate, index) => ({
      kind: candidateKind(candidate),
      url: candidate.url,
      ...(candidate.mime ? { mime: candidate.mime } : {}),
      index,
    }));

    if (items.length === 0) return null;

    const stats = Object.keys(metadata.stats).length > 0 ? metadata.stats : undefined;
    const caption = buildSocialCaption({
      ...(title ? { title } : {}),
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(metadata.author ? { author: metadata.author } : {}),
      ...(metadata.authorHandle ? { authorHandle: metadata.authorHandle } : {}),
      ...(stats ? { stats } : {}),
    });

    return {
      platform: 'generic',
      originalUrl: url.toString(),
      canonicalUrl,
      ...(title ? { title } : {}),
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(metadata.author ? { author: metadata.author } : {}),
      ...(metadata.authorHandle ? { authorHandle: metadata.authorHandle } : {}),
      ...(caption ? { caption } : {}),
      ...(stats ? { stats } : {}),
      items,
    };
  },
};
