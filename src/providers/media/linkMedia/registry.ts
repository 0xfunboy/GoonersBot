import type { LinkExtractor, PickExtractorOptions } from './types.js';
import { isKnownYtdlpHost } from './hosts.js';
import { directExtractor } from './extractors/direct.js';
import { createYtdlpExtractor, ytdlpExtractor } from './extractors/ytdlpSites.js';
import { twitterExtractor } from './extractors/twitter.js';
import { redditExtractor } from './extractors/reddit.js';
import { blueskyExtractor } from './extractors/bluesky.js';
import { threadsExtractor } from './extractors/threads.js';
import { imgurExtractor } from './extractors/imgur.js';
import { giphyExtractor } from './extractors/giphy.js';
import { tenorExtractor } from './extractors/tenor.js';
import { musicLinksExtractor } from './extractors/musicLinks.js';
import { genericHtmlExtractor } from './genericHtmlExtractor.js';

// Order matters:
//  1. direct file extensions
//  2. native social extractors (media + context: text, author, likes and reposts)
//  3. native image/gif/music hosts
//  4. yt-dlp for known video/stream/adult sites
//  5. generic OpenGraph fallback (catch-all)
//
// Keeping native extractors first is important: their result can still ask yt-dlp to download a
// video, while retaining context which a bare yt-dlp result cannot provide.
const nativeExtractors: readonly LinkExtractor[] = [
  directExtractor,
  twitterExtractor,
  redditExtractor,
  blueskyExtractor,
  threadsExtractor,
  imgurExtractor,
  giphyExtractor,
  tenorExtractor,
  musicLinksExtractor,
];

export function pickExtractor(url: URL, options: PickExtractorOptions = {}): LinkExtractor {
  const native = nativeExtractors.find((extractor) => extractor.match(url));
  if (native) return native;

  const extraHosts = options.extraYtdlpHosts ?? [];
  const ytdlp = extraHosts.length > 0 ? createYtdlpExtractor(extraHosts) : ytdlpExtractor;
  return ytdlp.match(url) ? ytdlp : genericHtmlExtractor;
}

/**
 * Whether retrying a failed native extractor through yt-dlp is within the explicit host policy.
 * This is a trust decision, not a promise that a particular post is public or downloadable.
 */
export function isSafeYtdlpFallback(url: URL, options: PickExtractorOptions = {}): boolean {
  return isKnownYtdlpHost(url, options.extraYtdlpHosts ?? []);
}
