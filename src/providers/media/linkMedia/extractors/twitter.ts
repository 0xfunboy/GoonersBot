import { fetchText } from '../http.js';
import type { ExtractedMediaItem, LinkExtractor, PostStats } from '../types.js';

interface FxTwitterMedia {
  url?: string;
  type?: string;
  thumbnail_url?: string;
}

interface FxTwitterResponse {
  tweet?: {
    text?: string;
    likes?: number;
    retweets?: number;
    replies?: number;
    views?: number;
    author?: { name?: string; screen_name?: string };
    media?: { all?: FxTwitterMedia[] };
  };
}

/**
 * X/Twitter via the public fxtwitter compatibility API (no Python, no auth). Social policy: we send
 * IMAGES only (a video's thumbnail stands in for the clip) plus rich context - the post text, author
 * and engagement counts (likes / reposts / replies / views) - as the caption.
 */
export const twitterExtractor: LinkExtractor = {
  platform: 'twitter',
  match(url) {
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    return (
      ['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com'].includes(h) &&
      /\/status\//.test(url.pathname)
    );
  },
  async extract(url, ctx) {
    const id = url.pathname.match(/\/status\/(\d+)/)?.[1];
    if (!id) return null;

    const api = `https://api.fxtwitter.com/status/${id}`;
    const raw = await fetchText(api, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 1024 * 1024,
      userAgent: ctx.userAgent,
    });
    const tweet = (JSON.parse(raw) as FxTwitterResponse).tweet;
    if (!tweet) return null;

    // Images only: a real photo, otherwise the video/gif thumbnail.
    const media = tweet.media?.all ?? [];
    const items: ExtractedMediaItem[] = [];
    for (const m of media) {
      const src = m.type === 'photo' ? m.url : m.thumbnail_url;
      if (src) items.push({ kind: 'image', url: src });
      if (items.length >= ctx.maxMediaPerUrl) break;
    }

    const stats: PostStats = {};
    if (typeof tweet.likes === 'number') stats.likes = tweet.likes;
    if (typeof tweet.retweets === 'number') stats.reposts = tweet.retweets;
    if (typeof tweet.replies === 'number') stats.replies = tweet.replies;
    if (typeof tweet.views === 'number') stats.views = tweet.views;

    const author = tweet.author?.name;
    const handle = tweet.author?.screen_name;
    const caption = buildTweetCaption(tweet.text, author, handle, stats);

    // If there is no image at all, still surface the text+stats as a context-only result is not
    // possible (nothing to send), so bail and let the brain see the raw link.
    if (items.length === 0) return null;

    return {
      platform: 'twitter',
      originalUrl: url.toString(),
      canonicalUrl: `https://x.com/i/status/${id}`,
      contentId: id,
      ...(author ? { author } : {}),
      ...(caption ? { caption } : {}),
      stats,
      items,
    };
  },
};

function buildTweetCaption(
  text: string | undefined,
  author: string | undefined,
  handle: string | undefined,
  stats: PostStats,
): string | undefined {
  const lines: string[] = [];
  if (text) lines.push(text.trim());
  const who = [author, handle ? `@${handle}` : null].filter(Boolean).join(' ');
  if (who) lines.push(who);
  const statLine = formatStats(stats);
  if (statLine) lines.push(statLine);
  const caption = lines.join('\n').trim();
  return caption ? caption.slice(0, 1000) : undefined;
}

export function formatStats(stats: PostStats): string {
  const parts: string[] = [];
  if (typeof stats.likes === 'number') parts.push(`❤ ${compact(stats.likes)}`);
  if (typeof stats.reposts === 'number') parts.push(`🔁 ${compact(stats.reposts)}`);
  if (typeof stats.replies === 'number') parts.push(`💬 ${compact(stats.replies)}`);
  if (typeof stats.views === 'number') parts.push(`👁 ${compact(stats.views)}`);
  return parts.join('  ');
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}
