import type { LinkExtractor, LinkMediaPlatform } from '../types.js';

// Hosts whose media is a video stream best fetched by yt-dlp (merges video+audio, ~1800 sites).
const VIDEO_HOSTS = [
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
  'tiktok.com',
  'vimeo.com',
  'player.vimeo.com',
  'streamable.com',
  'twitch.tv',
  'clips.twitch.tv',
  'm.twitch.tv',
  'facebook.com',
  'm.facebook.com',
  'fb.watch',
  'dailymotion.com',
  'dai.ly',
  'kick.com',
];

// Adult / cam video hosts (only fetched when LINK_MEDIA_NSFW_ALLOW=true; gated in the service).
const ADULT_HOSTS = [
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
];

const ALL_HOSTS = [...VIDEO_HOSTS, ...ADULT_HOSTS];

function platformFor(host: string): LinkMediaPlatform {
  if (/youtube\.com$|youtu\.be$/.test(host)) return 'youtube';
  if (/tiktok\.com$/.test(host)) return 'tiktok';
  if (/vimeo\.com$/.test(host)) return 'vimeo';
  if (/streamable\.com$/.test(host)) return 'streamable';
  if (/twitch\.tv$/.test(host)) return 'twitch';
  if (/facebook\.com$|fb\.watch$/.test(host)) return 'facebook';
  return 'generic';
}

/**
 * yt-dlp video extractor. Does not pre-fetch metadata: it signals via:'ytdlp' so the service runs
 * yt-dlp to download (and learn title/duration). Covers YouTube, TikTok, Vimeo, Twitch, Facebook,
 * Dailymotion, Kick, and adult/cam video sites.
 */
export const ytdlpExtractor: LinkExtractor = {
  platform: 'youtube',
  match(url) {
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    return ALL_HOSTS.some((host) => h === host || h.endsWith(`.${host}`));
  },
  async extract(url) {
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    return {
      platform: platformFor(host),
      originalUrl: url.toString(),
      canonicalUrl: url.toString(),
      webpageUrl: url.toString(),
      items: [{ kind: 'video', url: url.toString(), via: 'ytdlp' }],
    };
  },
};
