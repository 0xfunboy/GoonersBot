import { fetchText } from '../http.js';
import type { LinkExtractor, ExtractedMediaItem, LinkMediaKind } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const redditExtractor: LinkExtractor = {
  platform: 'reddit',
  match(url) {
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    return h === 'reddit.com' || h === 'old.reddit.com' || h === 'redd.it' || h.endsWith('.reddit.com');
  },
  async extract(url, ctx) {
    const jsonUrl = `${url.toString().replace(/\/$/, '')}.json`;
    const raw = await fetchText(jsonUrl, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 3 * 1024 * 1024,
      userAgent: ctx.userAgent,
    });
    const data = JSON.parse(raw) as any;
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;

    const items: ExtractedMediaItem[] = [];
    const permalink = `https://reddit.com${post.permalink}`;
    const media = post.secure_media?.reddit_video || post.media?.reddit_video;
    if (media?.fallback_url) {
      // reddit's fallback_url is video-only (audio is a separate track); let yt-dlp merge them.
      const v: ExtractedMediaItem = { kind: 'video', url: permalink, via: 'ytdlp' };
      if (typeof media.duration === 'number') v.durationSeconds = media.duration;
      items.push(v);
    }

    const dest = post.url_overridden_by_dest;
    if (typeof dest === 'string' && /\.(jpg|jpeg|png|webp|gif|mp4)(\?|$)/i.test(dest)) {
      const kind: LinkMediaKind = /\.gif/i.test(dest) ? 'gif' : /\.mp4/i.test(dest) ? 'video' : 'image';
      items.push({ kind, url: dest });
    }

    const gallery: any[] = post.gallery_data?.items ?? [];
    const meta = post.media_metadata ?? {};
    for (const g of gallery.slice(0, ctx.maxMediaPerUrl)) {
      const m = meta[g.media_id];
      const src = m?.s?.u || m?.s?.gif || m?.s?.mp4;
      if (src) {
        items.push({
          kind: /\.mp4/i.test(String(src)) ? 'video' : 'image',
          url: String(src).replace(/&amp;/g, '&'),
        });
      }
    }

    if (items.length === 0) return null;

    return {
      platform: 'reddit',
      originalUrl: url.toString(),
      canonicalUrl: `https://reddit.com${post.permalink}`,
      contentId: String(post.id),
      ...(post.title ? { title: String(post.title) } : {}),
      ...(post.author ? { author: String(post.author) } : {}),
      items: items.slice(0, ctx.maxMediaPerUrl),
    };
  },
};
