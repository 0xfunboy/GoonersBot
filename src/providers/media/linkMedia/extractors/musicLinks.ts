import * as cheerio from 'cheerio';
import { fetchText } from '../http.js';
import type { ExtractedMediaItem, LinkExtractor, LinkMediaPlatform } from '../types.js';

/**
 * Spotify / SoundCloud / Bandcamp: metadata + cover + (where publicly allowed) preview audio only.
 * Never a full rip - no bypass, no pirated audio.
 */
export const musicLinksExtractor: LinkExtractor = {
  platform: 'spotify',
  match(url) {
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    return ['open.spotify.com', 'spotify.link', 'soundcloud.com', 'bandcamp.com'].some(
      (x) => h === x || h.endsWith(`.${x}`),
    );
  },
  async extract(url, ctx) {
    const html = await fetchText(url.toString(), {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 3 * 1024 * 1024,
      userAgent: ctx.userAgent,
    });
    const $ = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content') || $('title').text().trim();
    const image = $('meta[property="og:image"]').attr('content');
    const audio = $('meta[property="og:audio"]').attr('content') || $('audio source').attr('src');

    const host = url.hostname.toLowerCase();
    const items: ExtractedMediaItem[] = [];
    // No audio rip from Spotify; preview audio allowed for SoundCloud/Bandcamp when exposed.
    if (audio && !host.includes('spotify')) items.push({ kind: 'audio', url: audio });
    if (image) items.push({ kind: 'image', url: image });

    if (items.length === 0) return null;

    const platform: LinkMediaPlatform = host.includes('spotify')
      ? 'spotify'
      : host.includes('soundcloud')
        ? 'soundcloud'
        : 'bandcamp';

    return {
      platform,
      originalUrl: url.toString(),
      canonicalUrl: url.toString(),
      ...(title ? { title } : {}),
      items,
    };
  },
};
