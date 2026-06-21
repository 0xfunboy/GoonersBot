import type { LinkExtractor } from './types.js';
import { directExtractor } from './extractors/direct.js';
import { ytdlpExtractor } from './extractors/ytdlpSites.js';
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
//  2. yt-dlp video/stream/adult sites (download via yt-dlp binary)
//  3. native social extractors (images + context: text, likes, reposts)
//  4. image/gif hosts
//  5. generic OpenGraph fallback (catch-all)
export const linkExtractors: LinkExtractor[] = [
  directExtractor,
  ytdlpExtractor,
  twitterExtractor,
  redditExtractor,
  blueskyExtractor,
  threadsExtractor,
  imgurExtractor,
  giphyExtractor,
  tenorExtractor,
  musicLinksExtractor,
  genericHtmlExtractor,
];

export function pickExtractor(url: URL): LinkExtractor {
  return linkExtractors.find((e) => e.match(url)) ?? genericHtmlExtractor;
}
