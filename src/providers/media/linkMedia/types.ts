export type LinkMediaKind = 'video' | 'image' | 'gif' | 'audio' | 'document';

export type LinkMediaPlatform =
  | 'direct'
  | 'youtube'
  | 'instagram'
  | 'tiktok'
  | 'facebook'
  | 'twitter'
  | 'reddit'
  | 'bluesky'
  | 'threads'
  | 'imgur'
  | 'giphy'
  | 'tenor'
  | 'vimeo'
  | 'streamable'
  | 'twitch'
  | 'redgifs'
  | 'snapchat'
  | 'pinterest'
  | 'tumblr'
  | 'dailymotion'
  | 'kick'
  | 'rumble'
  | 'bilibili'
  | 'douyin'
  | 'likee'
  | 'linkedin'
  | 'loom'
  | 'medal'
  | 'coub'
  | 'vk'
  | 'odysee'
  | 'spotify'
  | 'soundcloud'
  | 'bandcamp'
  | 'generic';

export interface ExtractedMediaItem {
  kind: LinkMediaKind;
  /** for via:'http' the direct media URL; for via:'ytdlp' the page URL yt-dlp should resolve */
  url: string;
  ext?: string;
  mime?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  byteSize?: number;
  thumbnailUrl?: string;
  index?: number;
  /** headers required to download this specific item (e.g. referer/cookie) */
  headers?: Record<string, string>;
  /** download engine: plain HTTP (default) or the yt-dlp binary (video streams, adult/cam sites) */
  via?: 'http' | 'ytdlp';
  /** A bounded playlist is one social post containing multiple downloadable video entries. */
  ytdlpMode?: 'single' | 'bounded_playlist';
}

/** Engagement metrics for social posts (shown as context, not as media). */
export interface PostStats {
  likes?: number;
  reposts?: number;
  replies?: number;
  views?: number;
}

export interface ExtractedMediaPost {
  platform: LinkMediaPlatform;
  originalUrl: string;
  canonicalUrl: string;
  contentId?: string;
  title?: string;
  author?: string;
  /** rich, ready-to-show context line (post text + handle); preferred over title for the caption */
  caption?: string;
  stats?: PostStats;
  webpageUrl?: string;
  items: ExtractedMediaItem[];
}

export interface LinkExtractorContext {
  timeoutMs: number;
  userAgent: string;
  signal?: AbortSignal;
  proxy?: string | undefined;
  cookies?: string | undefined;
  maxMediaPerUrl: number;
  /** Deployment content policy, applied by generic HTTP extraction to every redirect. */
  validateUrl?: ((url: URL) => void | Promise<void>) | undefined;
}

export interface LinkExtractor {
  platform: LinkMediaPlatform;
  match(url: URL): boolean;
  extract(url: URL, ctx: LinkExtractorContext): Promise<ExtractedMediaPost | null>;
}

/** Trusted yt-dlp hosts added by a deployment on top of the built-in curated allowlist. */
export interface PickExtractorOptions {
  extraYtdlpHosts?: readonly string[];
}
