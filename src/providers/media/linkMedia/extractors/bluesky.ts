import { fetchText } from '../http.js';
import { buildSocialCaption } from '../socialMetadata.js';
import type { ExtractedMediaItem, LinkExtractor, PostStats } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Bluesky via the public AppView API, retaining post text, author and engagement counts. */
export const blueskyExtractor: LinkExtractor = {
  platform: 'bluesky',
  match(url) {
    return url.hostname === 'bsky.app' && /\/profile\/[^/]+\/post\//.test(url.pathname);
  },
  async extract(url, ctx) {
    const m = url.pathname.match(/\/profile\/([^/]+)\/post\/([^/]+)/);
    const profileHandle = m?.[1];
    const rkey = m?.[2];
    if (!profileHandle || !rkey) return null;

    const atUri = `at://${profileHandle}/app.bsky.feed.post/${rkey}`;
    const api = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=0`;
    const raw = await fetchText(api, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      userAgent: ctx.userAgent,
      signal: ctx.signal,
      validateUrl: ctx.validateUrl,
    });
    const post = (JSON.parse(raw) as any).thread?.post;
    if (!post) return null;

    const images: any[] = post.embed?.images ?? post.embed?.media?.images ?? [];
    const items: ExtractedMediaItem[] = [];
    for (const img of images.slice(0, ctx.maxMediaPerUrl)) {
      const full = img.fullsize || img.thumb;
      if (full) items.push({ kind: 'image', url: String(full) });
    }
    if (items.length === 0 && (post.embed?.playlist || post.embed?.media?.playlist)) {
      // Keep nested HLS access inside the guarded yt-dlp path rather than fetching the CDN manifest
      // directly. The public bsky.app post URL is in the curated yt-dlp policy.
      items.push({ kind: 'video', url: url.toString(), via: 'ytdlp' });
    }
    if (items.length === 0) return null;

    const stats: PostStats = {};
    if (typeof post.likeCount === 'number') stats.likes = post.likeCount;
    if (typeof post.repostCount === 'number') stats.reposts = post.repostCount;
    if (typeof post.replyCount === 'number') stats.replies = post.replyCount;

    const author = post.author?.displayName || post.author?.handle;
    const authorHandle = post.author?.handle;
    const description = post.record?.text ? String(post.record.text).trim() : undefined;
    const caption = buildSocialCaption({
      description,
      author: author ? String(author) : undefined,
      authorHandle: authorHandle ? String(authorHandle) : undefined,
      stats,
    });

    return {
      platform: 'bluesky',
      originalUrl: url.toString(),
      canonicalUrl: url.toString(),
      ...(post.cid ? { contentId: String(post.cid) } : {}),
      ...(description ? { description } : {}),
      ...(author ? { author: String(author) } : {}),
      ...(authorHandle ? { authorHandle: String(authorHandle) } : {}),
      ...(caption ? { caption } : {}),
      stats,
      items,
    };
  },
};
