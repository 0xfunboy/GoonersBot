import * as cheerio from 'cheerio';
import { fetchText } from '../http.js';
import type { LinkExtractor, ExtractedMediaItem } from '../types.js';

function deepMedia(value: unknown, out: ExtractedMediaItem[] = []): ExtractedMediaItem[] {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const x of value) deepMedia(x, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      const url = v.replace(/\\u0026/g, '&').replace(/\\u002F/g, '/');
      if (/\.mp4|video/i.test(url) || k === 'video_url') out.push({ kind: 'video', url, ext: 'mp4' });
      if (/\.jpg|\.jpeg|\.png|scontent/i.test(url) && /image|display|thumbnail|url/i.test(k)) {
        out.push({ kind: 'image', url });
      }
    } else {
      deepMedia(v, out);
    }
  }
  return out;
}

function parseScriptJson(html: string): unknown[] {
  const out: unknown[] = [];
  const matches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of matches) {
    try {
      out.push(JSON.parse(m[1] ?? '{}'));
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return out;
}

export const instagramExtractor: LinkExtractor = {
  platform: 'instagram',
  match(url) {
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    return h === 'instagram.com' && /^\/(p|reel|tv|stories)\//.test(url.pathname);
  },
  async extract(url, ctx) {
    if (url.pathname.startsWith('/stories/')) return null; // private/login-walled

    const html = await fetchText(url.toString(), {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 5 * 1024 * 1024,
      userAgent: ctx.userAgent,
      ...(ctx.cookies ? { headers: { cookie: ctx.cookies } } : {}),
    });

    const $ = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content') || $('title').text().trim();
    const description = $('meta[property="og:description"]').attr('content');
    const image = $('meta[property="og:image"]').attr('content');

    // Social policy: images only. Collect og:image plus any image URLs in embedded JSON; drop videos.
    const items: ExtractedMediaItem[] = [];
    if (image) items.push({ kind: 'image', url: image });
    for (const j of parseScriptJson(html)) deepMedia(j, items);

    const dedup = new Map<string, ExtractedMediaItem>();
    for (const item of items) {
      if (item.kind === 'image') dedup.set(item.url, item);
    }
    const finalItems = [...dedup.values()].slice(0, ctx.maxMediaPerUrl);
    if (finalItems.length === 0) return null;

    const caption = (description || title || '').trim().slice(0, 1000);

    return {
      platform: 'instagram',
      originalUrl: url.toString(),
      canonicalUrl: url.toString(),
      ...(title ? { title } : {}),
      ...(caption ? { caption } : {}),
      items: finalItems,
    };
  },
};
