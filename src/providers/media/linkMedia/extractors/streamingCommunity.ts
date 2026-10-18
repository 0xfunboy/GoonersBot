import { fetchText } from '../http.js';
import type { ExtractedMediaItem, ExtractedMediaPost, LinkExtractor } from '../types.js';

export const STREAMING_COMMUNITY_HOST_REGEX =
  /(?:^|\.)streamingcommunity[a-z0-9-]*\.[a-z]{2,}$/i;

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

export function normalizeStreamingCommunityUrl(url: URL): URL | null {
  const host = url.hostname.toLowerCase();
  if (!STREAMING_COMMUNITY_HOST_REGEX.test(host)) return null;

  const match =
    /^(?:\/([a-z]{2}))?\/(?:titles\/(?:(\d+)[^/?#]*)|watch\/(\d+)|iframe\/(\d+))/i.exec(
      url.pathname,
    );
  if (!match) return null;

  const locale = match[1] || 'it';
  const titleId = match[2] || match[3] || match[4];
  if (!titleId) return null;

  const normalized = new URL(url.toString());
  normalized.pathname = `/${locale}/watch/${titleId}`;
  return normalized;
}

export const streamingCommunityExtractor: LinkExtractor = {
  platform: 'streamingcommunity',
  match(url: URL): boolean {
    return normalizeStreamingCommunityUrl(url) !== null;
  },
  async extract(url, ctx): Promise<ExtractedMediaPost | null> {
    const watchUrl = normalizeStreamingCommunityUrl(url);
    if (!watchUrl) return null;

    // 1. Fetch the watch page to get Inertia.js props (title, episode info, embedUrl)
    const pageHtml = await fetchText(watchUrl.toString(), {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      userAgent: ctx.userAgent,
      signal: ctx.signal,
      validateUrl: ctx.validateUrl,
    });

    const dataPageMatch =
      /data-page="([^"]+)"/i.exec(pageHtml) || /data-page='([^']+)'/i.exec(pageHtml);
    let titleName = '';
    let plot: string | undefined;
    let embedUrlStr: string | undefined;
    let durationSeconds: number | undefined;

    if (dataPageMatch?.[1]) {
      try {
        const pageData = JSON.parse(decodeHtmlEntities(dataPageMatch[1])) as {
          props?: {
            title?: {
              name?: string;
              type?: string;
              plot?: string;
              runtime?: number;
            };
            episode?: {
              number?: number;
              n?: number;
              name?: string;
              plot?: string;
              duration?: number;
              season?: {
                number?: number;
              };
            };
            embedUrl?: string;
          };
        };
        const props = pageData?.props;
        const titleObj = props?.title;
        const episodeObj = props?.episode;

        if (titleObj?.name) {
          titleName = String(titleObj.name).trim();
          if (episodeObj) {
            const seasonNum = episodeObj.season?.number ?? 1;
            const epNum = episodeObj.number ?? episodeObj.n ?? 1;
            const epName = episodeObj.name ? ` (${episodeObj.name})` : '';
            titleName = `${titleName} - S${seasonNum}E${epNum}${epName}`;
            if (typeof episodeObj.duration === 'number' && episodeObj.duration > 0) {
              durationSeconds = episodeObj.duration * 60;
            }
          }
          if (typeof titleObj.runtime === 'number' && titleObj.runtime > 0 && !durationSeconds) {
            durationSeconds = titleObj.runtime * 60;
          }
        }
        plot = episodeObj?.plot || titleObj?.plot;
        embedUrlStr = props?.embedUrl;
      } catch {
        // Continue to fallback
      }
    }

    if (!embedUrlStr) {
      const match = /\/watch\/(\d+)/i.exec(watchUrl.pathname);
      if (!match) return null;
      const titleId = match[1];
      const epParam = watchUrl.searchParams.get('e') || watchUrl.searchParams.get('episode_id');
      embedUrlStr = epParam
        ? `https://${watchUrl.hostname}/it/iframe/${titleId}?episode_id=${epParam}&next_episode=1`
        : `https://${watchUrl.hostname}/it/iframe/${titleId}`;
    }

    // 2. Fetch the iframe page to get the VixCloud embed iframe source
    const iframeHtml = await fetchText(embedUrlStr, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 1024 * 1024,
      userAgent: ctx.userAgent,
      headers: {
        referer: watchUrl.toString(),
      },
      signal: ctx.signal,
      validateUrl: ctx.validateUrl,
    });

    const vixIframeMatch = /<iframe[^>]+src=["']([^"']+)["']/i.exec(iframeHtml);
    if (!vixIframeMatch?.[1]) return null;
    const vixEmbedUrl = decodeHtmlEntities(vixIframeMatch[1]);

    // 3. Fetch the VixCloud embed page to extract the HLS master playlist URL
    const vixHtml = await fetchText(vixEmbedUrl, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: 1024 * 1024,
      userAgent: ctx.userAgent,
      headers: {
        referer: embedUrlStr,
      },
      signal: ctx.signal,
      validateUrl: ctx.validateUrl,
    });

    const urlMatch = /url:\s*['"]([^'"]+)['"]/.exec(vixHtml);
    const paramsBlockMatch = /params:\s*\{([^}]+)\}/s.exec(vixHtml);
    const params: Record<string, string> = {};
    if (paramsBlockMatch?.[1]) {
      const lineRegex = /['"]?([a-zA-Z0-9_]+)['"]?\s*:\s*['"]([^'"]*)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = lineRegex.exec(paramsBlockMatch[1])) !== null) {
        if (m[1] && m[2]) {
          params[m[1]] = m[2];
        }
      }
    }

    if (!params.token) {
      const tokenMatch = /['"]token['"]:\s*['"]([^'"]+)['"]/.exec(vixHtml);
      if (tokenMatch?.[1]) params.token = tokenMatch[1];
    }
    if (!params.expires) {
      const expiresMatch = /['"]expires['"]:\s*['"]([^'"]+)['"]/.exec(vixHtml);
      if (expiresMatch?.[1]) params.expires = expiresMatch[1];
    }

    if (!urlMatch?.[1] || !params.token || !params.expires) {
      return null;
    }

    const playlistBase = urlMatch[1].replace(/\\\//g, '/');
    const playlistUrl = new URL(playlistBase);
    let embedUrlObj: URL | undefined;
    try {
      embedUrlObj = new URL(vixEmbedUrl);
    } catch {
      // ignore
    }

    for (const [key, value] of Object.entries(params)) {
      if (value) playlistUrl.searchParams.set(key, value);
    }

    if (embedUrlObj?.searchParams.has('canPlayFHD')) {
      playlistUrl.searchParams.set('h', '1');
    }
    if (embedUrlObj?.searchParams.has('scz')) {
      playlistUrl.searchParams.set('scz', '1');
    }
    const lang = embedUrlObj?.searchParams.get('lang') || 'it';
    playlistUrl.searchParams.set('lang', lang);

    const masterPlaylistUrl = playlistUrl.toString();

    const vixIdMatch =
      /\/(?:embed|playlist)\/(\d+)/i.exec(vixEmbedUrl) ||
      /\/(?:embed|playlist)\/(\d+)/i.exec(playlistBase);
    const vixId = vixIdMatch ? vixIdMatch[1] : '';
    const refererHeader = vixId ? `https://vixcloud.co/embed/${vixId}` : 'https://vixcloud.co/';

    const item: ExtractedMediaItem = {
      kind: 'video',
      url: masterPlaylistUrl,
      mime: 'application/x-mpegurl',
      via: 'ytdlp',
      headers: {
        Referer: refererHeader,
      },
      ...(durationSeconds ? { durationSeconds } : {}),
    };

    return {
      platform: 'streamingcommunity',
      originalUrl: url.toString(),
      canonicalUrl: watchUrl.toString(),
      webpageUrl: watchUrl.toString(),
      title: titleName || 'StreamingCommunity',
      ...(plot ? { description: plot } : {}),
      author: 'StreamingCommunity',
      items: [item],
    };
  },
};

