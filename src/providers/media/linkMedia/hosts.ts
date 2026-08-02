import { domainToASCII } from 'node:url';

/**
 * Short-form/social pages which are intentionally allowed to reach yt-dlp.
 *
 * Keep this list explicit: yt-dlp has a generic extractor, but passing every arbitrary URL to an
 * external process would turn a media convenience feature into an unrestricted fetch surface.
 */
export const YTDLP_SHORT_VIDEO_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'tiktok.com',
  'instagram.com',
  'instagr.am',
  'facebook.com',
  'fb.watch',
  'redgifs.com',
  'x.com',
  'twitter.com',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
  'reddit.com',
  'redd.it',
  'bsky.app',
  'threads.net',
  'threads.com',
  'snapchat.com',
  'pinterest.com',
  'pin.it',
  'tumblr.com',
  '9gag.com',
  'douyin.com',
  'iesdouyin.com',
  'likee.video',
  'xiaohongshu.com',
  'xhslink.com',
  'ixigua.com',
  'weibo.com',
  'weibo.cn',
] as const;

/** Established video/clip hosts supported by the bundled yt-dlp release. */
export const YTDLP_VIDEO_HOSTS = [
  ...YTDLP_SHORT_VIDEO_HOSTS,
  'vimeo.com',
  'streamable.com',
  'twitch.tv',
  'dailymotion.com',
  'dai.ly',
  'kick.com',
  'rumble.com',
  'odysee.com',
  'bitchute.com',
  'bilibili.com',
  'bilibili.tv',
  'b23.tv',
  'coub.com',
  'linkedin.com',
  'loom.com',
  'medal.tv',
  'vk.com',
  'vkvideo.ru',
  'ok.ru',
  'rutube.ru',
  'tv.naver.com',
  // Imgur's native extractor provides direct media and a title first; yt-dlp is only a fallback.
  'imgur.com',
] as const;

/** Adult/cam video hosts supported by yt-dlp. They are also covered by the shared NSFW gate. */
export const YTDLP_ADULT_HOSTS = [
  'pornhub.com',
  'xvideos.com',
  'xhamster.com',
  'redtube.com',
  'youporn.com',
  'spankbang.com',
  'eporner.com',
  'tube8.com',
  'xnxx.com',
  'motherless.com',
  'chaturbate.com',
  'stripchat.com',
  'cam4.com',
  'bongacams.com',
  'camsoda.com',
  'myfreecams.com',
  'thisvid.com',
  'tnaflix.com',
  'rule34video.com',
] as const;

/** Complete built-in yt-dlp allowlist. Deployments can add trusted hosts explicitly at runtime. */
export const YTDLP_HOSTS: readonly string[] = Object.freeze([
  ...new Set([...YTDLP_VIDEO_HOSTS, ...YTDLP_ADULT_HOSTS]),
]);

/**
 * Shared content-policy gate for all link-media paths, not just yt-dlp. RedGifs is deliberately
 * gated here even though individual posts can be marked SFW: the host is predominantly adult and
 * has no trustworthy pre-download classification endpoint.
 */
export const NSFW_HOSTS: readonly string[] = Object.freeze([
  ...new Set(['redgifs.com', ...YTDLP_ADULT_HOSTS, 'onlyfans.com', 'rule34.xxx', 'e621.net']),
]);

/** Normalize a URL hostname or configured host pattern for boundary-safe comparisons. */
export function normalizeHost(value: string | URL): string {
  const raw = (value instanceof URL ? value.hostname : value)
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/^www\./, '');

  // Config values are hostnames, not URLs, credentials, paths, or host:port pairs.
  if (!raw || /[\s/:@?#]/.test(raw) || raw.includes('[') || raw.includes(']')) return '';
  return domainToASCII(raw).toLowerCase();
}

/** Match an exact host or one of its subdomains without accepting lookalike suffixes. */
export function hostMatches(host: string | URL, candidate: string): boolean {
  const normalized = normalizeHost(host);
  const suffix = normalizeHost(candidate);
  return Boolean(suffix) && (normalized === suffix || normalized.endsWith(`.${suffix}`));
}

export function hostMatchesAny(host: string | URL, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => hostMatches(host, candidate));
}

export function isNsfwHost(host: string | URL): boolean {
  return hostMatchesAny(host, NSFW_HOSTS);
}

/** True only for a built-in media host or a deployment-supplied trusted host. */
export function isKnownYtdlpHost(host: string | URL, extraHosts: readonly string[] = []): boolean {
  return hostMatchesAny(host, YTDLP_HOSTS) || hostMatchesAny(host, extraHosts);
}
