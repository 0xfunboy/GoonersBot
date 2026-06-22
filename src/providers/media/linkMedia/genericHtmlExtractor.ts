import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { LinkMediaKind, ExtractedMediaPost, LinkExtractor, LinkExtractorContext } from './types.js';

function abs(base: URL, value?: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function kindFromUrl(url: string): LinkMediaKind {
  const clean = (url.split('?')[0] ?? url).toLowerCase();
  if (/\.gif$/.test(clean)) return 'gif';
  if (/\.(jpg|jpeg|png|webp|avif)$/.test(clean)) return 'image';
  if (/\.(mp3|m4a|wav|ogg|flac)$/.test(clean)) return 'audio';
  if (/\.(mp4|webm|mov|m3u8|mpd)$/.test(clean)) return 'video';
  return 'document';
}

export const genericHtmlExtractor: LinkExtractor = {
  platform: 'generic',
  match: () => true,
  async extract(url: URL, ctx: LinkExtractorContext): Promise<ExtractedMediaPost | null> {
    const html = await fetchText(url.toString(), {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 3 * 1024 * 1024,
      userAgent: ctx.userAgent,
      ...(ctx.cookies ? { headers: { cookie: ctx.cookies } } : {}),
    });

    const $ = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content') || $('title').first().text().trim();
    const candidates = new Set<string>();

    for (const sel of [
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video:secure_url"]',
      'meta[property="og:image"]',
      'meta[property="og:audio"]',
      'video source[src]',
      'video[src]',
      'audio source[src]',
      'audio[src]',
      'source[type="application/x-mpegURL"][src]',
      'source[type="application/dash+xml"][src]',
    ]) {
      $(sel).each((_, el) => {
        const v = $(el).attr('content') || $(el).attr('src');
        const u = abs(url, v);
        if (u) candidates.add(u);
      });
    }

    const items = [...candidates].slice(0, ctx.maxMediaPerUrl).map((u, index) => ({
      kind: kindFromUrl(u),
      url: u,
      index,
    }));

    if (items.length === 0) return null;

    return {
      platform: 'generic',
      originalUrl: url.toString(),
      canonicalUrl: url.toString(),
      ...(title ? { title } : {}),
      items,
    };
  },
};
