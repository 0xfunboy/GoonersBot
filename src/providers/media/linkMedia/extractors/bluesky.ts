import { fetchText } from '../http.js';
import { formatStats } from './twitter.js';
import type { ExtractedMediaItem, LinkExtractor, PostStats } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Bluesky via the public AppView API. Social policy: images only + post text and engagement counts. */
export const blueskyExtractor: LinkExtractor = {
  platform: 'bluesky',
  match(url) {
    return url.hostname === 'bsky.app' && /\/profile\/[^/]+\/post\//.test(url.pathname);
  },
  async extract(url, ctx) {
    const m = url.pathname.match(/\/profile\/([^/]+)\/post\/([^/]+)/);
    const handle = m?.[1];
    const rkey = m?.[2];
    if (!handle || !rkey) return null;

    const atUri = `at://${handle}/app.bsky.feed.post/${rkey}`;
    const api = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=0`;
    const raw = await fetchText(api, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      userAgent: ctx.userAgent,
    });
    const post = (JSON.parse(raw) as any).thread?.post;
    if (!post) return null;

    const images: any[] = post.embed?.images ?? [];
    const items: ExtractedMediaItem[] = [];
    for (const img of images.slice(0, ctx.maxMediaPerUrl)) {
      const full = img.fullsize || img.thumb;
      if (full) items.push({ kind: 'image', url: String(full) });
    }
    if (items.length === 0) return null;

    const stats: PostStats = {};
    if (typeof post.likeCount === 'number') stats.likes = post.likeCount;
    if (typeof post.repostCount === 'number') stats.reposts = post.repostCount;
    if (typeof post.replyCount === 'number') stats.replies = post.replyCount;

    const author = post.author?.displayName || post.author?.handle;
    const lines: string[] = [];
    if (post.record?.text) lines.push(String(post.record.text).trim());
    if (author) lines.push(String(author));
    const statLine = formatStats(stats);
    if (statLine) lines.push(statLine);
    const caption = lines.join('\n').trim().slice(0, 1000);

    return {
      platform: 'bluesky',
      originalUrl: url.toString(),
      canonicalUrl: url.toString(),
      ...(post.cid ? { contentId: String(post.cid) } : {}),
      ...(author ? { author: String(author) } : {}),
      ...(caption ? { caption } : {}),
      stats,
      items,
    };
  },
};
