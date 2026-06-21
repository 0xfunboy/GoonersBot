import * as cheerio from 'cheerio';
import { fetchText } from '../http.js';
import type { ExtractedMediaItem, LinkExtractor } from '../types.js';

export const imgurExtractor: LinkExtractor = {
  platform: 'imgur',
  match(url) {
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    return h === 'imgur.com' || h === 'i.imgur.com';
  },
  async extract(url, ctx) {
    if (url.hostname.replace(/^www\./, '') === 'i.imgur.com') {
      const ext = url.pathname.split('.').pop()?.toLowerCase();
      const kind = ext === 'gif' ? 'gif' : ext === 'mp4' ? 'video' : 'image';
      return {
        platform: 'imgur',
        originalUrl: url.toString(),
        canonicalUrl: url.toString(),
        items: [{ kind, url: url.toString(), ...(ext ? { ext } : {}) }],
      };
    }

    const html = await fetchText(url.toString(), {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      userAgent: ctx.userAgent,
    });
    const $ = cheerio.load(html);
    const ogVideo = $('meta[property="og:video"]').attr('content');
    const ogImage = $('meta[property="og:image"]').attr('content');
    const title = $('meta[property="og:title"]').attr('content') || $('title').text().trim();

    const items: ExtractedMediaItem[] = [];
    if (ogVideo) items.push({ kind: 'video', url: ogVideo, ext: 'mp4' });
    else if (ogImage) items.push({ kind: /\.gif/i.test(ogImage) ? 'gif' : 'image', url: ogImage });

    if (items.length === 0) return null;
    return {
      platform: 'imgur',
      originalUrl: url.toString(),
      canonicalUrl: url.toString(),
      ...(title ? { title } : {}),
      items,
    };
  },
};
