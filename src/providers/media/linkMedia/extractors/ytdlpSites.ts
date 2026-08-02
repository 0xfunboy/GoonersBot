import { hostMatches, isKnownYtdlpHost, normalizeHost } from '../hosts.js';
import type { LinkExtractor, LinkMediaPlatform } from '../types.js';

const PLATFORM_HOSTS: ReadonlyArray<
  readonly [platform: LinkMediaPlatform, hosts: readonly string[]]
> = [
  ['youtube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com']],
  ['instagram', ['instagram.com', 'instagr.am']],
  ['tiktok', ['tiktok.com']],
  ['facebook', ['facebook.com', 'fb.watch']],
  ['redgifs', ['redgifs.com']],
  ['twitter', ['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com']],
  ['reddit', ['reddit.com', 'redd.it']],
  ['bluesky', ['bsky.app']],
  ['threads', ['threads.net', 'threads.com']],
  ['snapchat', ['snapchat.com']],
  ['pinterest', ['pinterest.com', 'pin.it']],
  ['tumblr', ['tumblr.com']],
  ['vimeo', ['vimeo.com']],
  ['streamable', ['streamable.com']],
  ['twitch', ['twitch.tv']],
  ['dailymotion', ['dailymotion.com', 'dai.ly']],
  ['kick', ['kick.com']],
  ['rumble', ['rumble.com']],
  ['bilibili', ['bilibili.com', 'bilibili.tv', 'b23.tv']],
  ['douyin', ['douyin.com', 'iesdouyin.com']],
  ['likee', ['likee.video']],
  ['linkedin', ['linkedin.com']],
  ['loom', ['loom.com']],
  ['medal', ['medal.tv']],
  ['coub', ['coub.com']],
  ['vk', ['vk.com', 'vkvideo.ru']],
  ['odysee', ['odysee.com']],
  ['imgur', ['imgur.com']],
];

export function ytdlpPlatformFor(host: string | URL): LinkMediaPlatform {
  const normalized = normalizeHost(host);
  for (const [platform, hosts] of PLATFORM_HOSTS) {
    if (hosts.some((candidate) => hostMatches(normalized, candidate))) return platform;
  }
  return 'generic';
}

export function ytdlpModeFor(url: URL): 'single' | 'bounded_playlist' {
  const host = normalizeHost(url);
  const path = url.pathname.toLowerCase();
  if (hostMatches(host, 'instagram.com') || hostMatches(host, 'instagr.am')) {
    return /\/(?:[^/]+\/)?p\/[^/]+/.test(path) ? 'bounded_playlist' : 'single';
  }
  if (hostMatches(host, 'tiktok.com')) {
    return /\/@[^/]+\/photo\/[^/]+/.test(path) || /^(?:vm|vt)\.tiktok\.com$/.test(host)
      ? 'bounded_playlist'
      : 'single';
  }
  if (hostMatches(host, 'facebook.com')) {
    return /\/(?:posts|photos|share\/p)\//.test(path) || path.endsWith('/permalink.php')
      ? 'bounded_playlist'
      : 'single';
  }
  if (hostMatches(host, 'youtube.com')) {
    return path === '/playlist' ? 'bounded_playlist' : 'single';
  }
  return 'single';
}

/**
 * Build a yt-dlp page extractor with an optional deployment-owned host allowlist. The default
 * singleton below remains useful for built-in hosts and for explicit native-extractor fallback.
 */
export function createYtdlpExtractor(extraHosts: readonly string[] = []): LinkExtractor {
  return {
    // This is only a registry hint. The extracted post is labelled with the URL's real platform.
    platform: 'generic',
    match(url) {
      return isKnownYtdlpHost(url, extraHosts);
    },
    async extract(url) {
      const sourceUrl = url.toString();
      return {
        platform: ytdlpPlatformFor(url),
        originalUrl: sourceUrl,
        canonicalUrl: sourceUrl,
        webpageUrl: sourceUrl,
        items: [
          {
            kind: 'video',
            url: sourceUrl,
            via: 'ytdlp',
            ytdlpMode: ytdlpModeFor(url),
          },
        ],
      };
    },
  };
}

/**
 * yt-dlp video extractor. It intentionally does not pre-fetch metadata: via:'ytdlp' tells the
 * service to perform a bounded download and learn title/duration from yt-dlp's info JSON.
 */
export const ytdlpExtractor: LinkExtractor = createYtdlpExtractor();
