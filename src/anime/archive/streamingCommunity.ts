import { isStreamingCommunityHost } from '../../providers/media/linkMedia/hosts.js';
import {
  SafeAnimeArchiveHttpClient,
  type AnimeArchiveHttpClient,
} from './http.js';
import {
  AnimeArchiveError,
  type AnimeArchiveEpisode,
  type AnimeArchiveSearchResult,
  type AnimeArchiveSeries,
  type AnimeMediaCandidate,
  type AnimeSourceAdapter,
  type AnimeUrlClassification,
  type ResolvedAnimeMedia,
} from './types.js';

export const STREAMINGCOMMUNITY_DEFAULT_ORIGIN = 'https://streamingcommunityz.shiksha';
export const STREAMINGCOMMUNITY_PAGE_HOSTS = [
  'streamingcommunity',
  'streamingcommunityz.shiksha',
  'vixcloud.co',
  'vix-content.net',
] as const;
export const STREAMINGCOMMUNITY_MEDIA_HOSTS = ['vixcloud.co', 'vix-content.net'] as const;

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

export function classifyStreamingCommunityUrl(rawUrl: string | URL): AnimeUrlClassification | null {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isStreamingCommunityHost(url.hostname)) return null;

  const match =
    /^(?:\/([a-z]{2}))?\/(?:titles\/(?:(\d+)[^/?#]*)|watch\/(\d+)|iframe\/(\d+))/i.exec(
      url.pathname,
    );
  if (!match) return null;

  const titleId = match[2] || match[3] || match[4];
  if (!titleId) return null;

  const slugMatch = /\/titles\/\d+-([^/?#]+)/i.exec(url.pathname);
  const slug = slugMatch?.[1] || titleId;

  const epParam = url.searchParams.get('e') || url.searchParams.get('episode_id');
  const canonicalSeriesUrl = `https://${url.host}/it/watch/${titleId}`;
  const canonicalUrl = epParam ? `${canonicalSeriesUrl}?e=${epParam}` : canonicalSeriesUrl;

  return {
    source: 'streamingcommunity',
    kind: epParam ? 'episode' : 'series',
    canonicalUrl,
    canonicalSeriesUrl,
    seriesId: titleId,
    slug,
    ...(epParam ? { episodeId: epParam } : {}),
  };
}

export class StreamingCommunityAdapter implements AnimeSourceAdapter {
  readonly source = 'streamingcommunity' as const;

  constructor(private readonly http: AnimeArchiveHttpClient = new SafeAnimeArchiveHttpClient()) {}

  classify(url: string | URL): AnimeUrlClassification | null {
    return classifyStreamingCommunityUrl(url);
  }

  async getSeries(url: string | URL, signal?: AbortSignal): Promise<AnimeArchiveSeries> {
    const classification = this.classify(url);
    if (!classification) {
      throw new AnimeArchiveError('unsupported_url', 'invalid StreamingCommunity URL');
    }
    const host = new URL(classification.canonicalUrl).host;
    const titleId = classification.seriesId;

    // 1. Fetch the watch page to get Inertia data-page
    const watchUrl = `https://${host}/it/watch/${titleId}`;
    const pageResponse = await this.http.fetchText(watchUrl, {
      allowedHosts: STREAMINGCOMMUNITY_PAGE_HOSTS,
      signal,
    });

    const dataPageMatch =
      /data-page="([^"]+)"/i.exec(pageResponse.text) ||
      /data-page='([^']+)'/i.exec(pageResponse.text);
    if (!dataPageMatch?.[1]) {
      throw new AnimeArchiveError(
        'source_layout_changed',
        'StreamingCommunity watch page has no data-page',
      );
    }

    let pageData: {
      props?: {
        title?: {
          id?: number;
          name?: string;
          slug?: string;
          type?: string;
          plot?: string;
          runtime?: number;
          score?: string | number;
          release_date?: string;
          last_air_date?: string;
          seasons_count?: number;
        };
        episode?: {
          id?: number;
          number?: number;
          n?: number;
          name?: string;
          plot?: string;
          duration?: number;
        };
      };
    };
    try {
      pageData = JSON.parse(decodeHtmlEntities(dataPageMatch[1]));
    } catch (err) {
      throw new AnimeArchiveError(
        'source_layout_changed',
        'failed to parse StreamingCommunity data-page JSON',
      );
    }

    const titleObj = pageData?.props?.title;
    if (!titleObj?.name) {
      throw new AnimeArchiveError(
        'source_layout_changed',
        'StreamingCommunity page missing title object',
      );
    }

    const titleName = decodeHtmlEntities(String(titleObj.name).trim());
    const slug = titleObj.slug ? String(titleObj.slug) : classification.slug;
    const plot = titleObj.plot ? decodeHtmlEntities(String(titleObj.plot)) : undefined;
    const year = titleObj.release_date
      ? String(titleObj.release_date).slice(0, 4)
      : titleObj.last_air_date
        ? String(titleObj.last_air_date).slice(0, 4)
        : undefined;
    const score = titleObj.score ? Number(titleObj.score) : undefined;
    const isMovie = titleObj.type === 'movie';

    if (isMovie) {
      const movieEpisode: AnimeArchiveEpisode = {
        source: 'streamingcommunity',
        sourceId: titleId,
        seriesId: titleId,
        seriesSlug: slug,
        seriesTitle: titleName,
        number: '1',
        order: 1,
        title: titleName,
        canonicalUrl: `https://${host}/it/watch/${titleId}`,
        canonicalSeriesUrl: `https://${host}/it/watch/${titleId}`,
      };

      return {
        source: 'streamingcommunity',
        sourceId: titleId,
        slug,
        title: titleName,
        aliases: [titleName, slug.replace(/-/g, ' ')],
        canonicalUrl: `https://${host}/it/watch/${titleId}`,
        description: plot,
        status: 'completed',
        genres: [],
        episodeCount: 1,
        episodes: [movieEpisode],
        year,
        score,
        externalIds: {},
      };
    }

    // TV show: fetch titles page to get loadedSeason episodes
    const titlesUrl = `https://${host}/it/titles/${titleId}-${slug}`;
    let episodes: AnimeArchiveEpisode[] = [];
    try {
      const titlesRes = await this.http.fetchText(titlesUrl, {
        allowedHosts: STREAMINGCOMMUNITY_PAGE_HOSTS,
        signal,
      });
      const titlesMatch =
        /data-page="([^"]+)"/i.exec(titlesRes.text) ||
        /data-page='([^']+)'/i.exec(titlesRes.text);
      if (titlesMatch?.[1]) {
        const titlesData = JSON.parse(decodeHtmlEntities(titlesMatch[1])) as {
          props?: {
            loadedSeason?: {
              episodes?: Array<{
                id?: number;
                number?: number;
                n?: number;
                name?: string;
                plot?: string;
                duration?: number;
              }>;
            };
          };
        };
        const epList = titlesData.props?.loadedSeason?.episodes ?? [];
        episodes = epList.map((ep, idx) => {
          const epNum = ep.number ?? ep.n ?? idx + 1;
          const epName = ep.name
            ? decodeHtmlEntities(String(ep.name).trim())
            : `Episodio ${epNum}`;
          return {
            source: 'streamingcommunity',
            sourceId: String(ep.id ?? idx + 1),
            seriesId: titleId,
            seriesSlug: slug,
            seriesTitle: titleName,
            number: String(epNum),
            order: Number(epNum) || idx + 1,
            title: epName,
            canonicalUrl: `https://${host}/it/watch/${titleId}?e=${ep.id ?? idx + 1}`,
            canonicalSeriesUrl: `https://${host}/it/watch/${titleId}`,
          };
        });
      }
    } catch {
      // Fallback if titles page is unavailable
    }

    if (episodes.length === 0 && pageData.props?.episode) {
      const ep = pageData.props.episode;
      const epNum = ep.number ?? ep.n ?? 1;
      const epName = ep.name
        ? decodeHtmlEntities(String(ep.name).trim())
        : `Episodio ${epNum}`;
      episodes = [
        {
          source: 'streamingcommunity',
          sourceId: String(ep.id ?? 1),
          seriesId: titleId,
          seriesSlug: slug,
          seriesTitle: titleName,
          number: String(epNum),
          order: Number(epNum) || 1,
          title: epName,
          canonicalUrl: `https://${host}/it/watch/${titleId}?e=${ep.id ?? 1}`,
          canonicalSeriesUrl: `https://${host}/it/watch/${titleId}`,
        },
      ];
    }

    return {
      source: 'streamingcommunity',
      sourceId: titleId,
      slug,
      title: titleName,
      aliases: [titleName, slug.replace(/-/g, ' ')],
      canonicalUrl: `https://${host}/it/watch/${titleId}`,
      description: plot,
      status: 'ongoing',
      genres: [],
      episodeCount: titleObj.seasons_count ?? episodes.length,
      episodes,
      year,
      score,
      externalIds: {},
    };
  }

  async getEpisode(url: string | URL, signal?: AbortSignal): Promise<AnimeArchiveEpisode> {
    const classification = this.classify(url);
    const series = await this.getSeries(url, signal);
    if (classification?.episodeId) {
      const match = series.episodes.find(
        (ep) =>
          ep.sourceId === classification.episodeId || ep.number === classification.episodeId,
      );
      if (match) return match;
    }
    const first = series.episodes[0];
    if (!first) {
      throw new AnimeArchiveError('episode_not_found', 'no episodes found for StreamingCommunity series');
    }
    return first;
  }

  async listEpisodes(
    series: AnimeArchiveSeries,
    signal?: AbortSignal,
  ): Promise<AnimeArchiveEpisode[]> {
    const refreshed = await this.getSeries(series.canonicalUrl, signal);
    return refreshed.episodes;
  }

  async resolveMedia(
    episode: AnimeArchiveEpisode,
    signal?: AbortSignal,
  ): Promise<ResolvedAnimeMedia> {
    let host = 'streamingcommunityz.shiksha';
    try {
      host = new URL(episode.canonicalUrl).host;
    } catch {
      // fallback
    }

    const isMovie = episode.sourceId === episode.seriesId;
    const iframeUrl = isMovie
      ? `https://${host}/it/iframe/${episode.seriesId}`
      : `https://${host}/it/iframe/${episode.seriesId}?episode_id=${episode.sourceId}&next_episode=1`;

    // 1. Fetch iframe page to get VixCloud iframe embed URL
    const iframeResponse = await this.http.fetchText(iframeUrl, {
      allowedHosts: STREAMINGCOMMUNITY_PAGE_HOSTS,
      signal,
      referer: episode.canonicalUrl,
    });

    const vixIframeMatch = /<iframe[^>]+src=["']([^"']+)["']/i.exec(iframeResponse.text);
    if (!vixIframeMatch?.[1]) {
      throw new AnimeArchiveError(
        'media_unavailable',
        'StreamingCommunity iframe has no VixCloud embed',
      );
    }
    const vixEmbedUrl = decodeHtmlEntities(vixIframeMatch[1]);

    // 2. Fetch VixCloud embed page to extract playlist URL and params
    const vixResponse = await this.http.fetchText(vixEmbedUrl, {
      allowedHosts: STREAMINGCOMMUNITY_PAGE_HOSTS,
      signal,
      referer: iframeUrl,
    });

    const urlMatch = /url:\s*['"]([^'"]+)['"]/.exec(vixResponse.text);
    const paramsBlockMatch = /params:\s*\{([^}]+)\}/s.exec(vixResponse.text);
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
      const tokenMatch = /['"]token['"]:\s*['"]([^'"]+)['"]/.exec(vixResponse.text);
      if (tokenMatch?.[1]) params.token = tokenMatch[1];
    }
    if (!params.expires) {
      const expiresMatch = /['"]expires['"]:\s*['"]([^'"]+)['"]/.exec(vixResponse.text);
      if (expiresMatch?.[1]) params.expires = expiresMatch[1];
    }

    if (!urlMatch?.[1] || !params.token || !params.expires) {
      throw new AnimeArchiveError(
        'media_unavailable',
        'failed to extract VixCloud HLS parameters from embed',
      );
    }

    const playlistBase = urlMatch[1].replace(/\\\//g, '/');
    const playlistUrl = new URL(playlistBase);
    for (const [k, v] of Object.entries(params)) {
      if (v) playlistUrl.searchParams.set(k, v);
    }

    // Force highest quality 1080p FHD, scz token, and Italian language
    playlistUrl.searchParams.set('h', '1');
    playlistUrl.searchParams.set('scz', '1');
    playlistUrl.searchParams.set('lang', 'it');

    const masterPlaylistUrl = playlistUrl.toString();

    const vixIdMatch =
      /\/(?:embed|playlist)\/(\d+)/i.exec(vixEmbedUrl) ||
      /\/(?:embed|playlist)\/(\d+)/i.exec(playlistBase);
    const vixId = vixIdMatch ? vixIdMatch[1] : '';
    const refererHeader = vixId
      ? `https://vixcloud.co/embed/${vixId}`
      : 'https://vixcloud.co/';

    const candidate: AnimeMediaCandidate = {
      url: masterPlaylistUrl,
      kind: 'stream',
      label: 'StreamingCommunity FHD 1080p',
      mimeType: 'application/x-mpegurl',
      requestHeaders: {
        referer: refererHeader,
      },
    };

    return {
      source: 'streamingcommunity',
      episode,
      candidates: [candidate],
      resolvedAt: new Date(),
    };
  }

  async search(
    query: string,
    limit = 5,
    signal?: AbortSignal,
  ): Promise<AnimeArchiveSearchResult[]> {
    const normalized = query.trim().replace(/\s+/g, ' ');
    if (normalized.length < 2) return [];

    const searchUrl = `${STREAMINGCOMMUNITY_DEFAULT_ORIGIN}/it/search?q=${encodeURIComponent(normalized)}`;
    let responseText = '';
    try {
      const res = await this.http.fetchText(searchUrl, {
        allowedHosts: STREAMINGCOMMUNITY_PAGE_HOSTS,
        signal,
        headers: {
          accept: 'application/json, text/plain, */*',
        },
      });
      responseText = res.text;
    } catch {
      return [];
    }

    try {
      const data = JSON.parse(responseText) as {
        data?: Array<{
          id?: number;
          slug?: string;
          name?: string;
          type?: string;
          score?: string;
          last_air_date?: string;
          seasons_count?: number;
        }>;
      };
      const hits = data.data ?? [];
      return hits.slice(0, Math.min(10, Math.max(1, limit))).map((item) => {
        const id = String(item.id ?? '');
        const title = decodeHtmlEntities(String(item.name ?? '').trim());
        const isMovie = item.type === 'movie';
        return {
          source: 'streamingcommunity',
          sourceId: id,
          slug: item.slug ? String(item.slug) : id,
          title: title || 'StreamingCommunity',
          canonicalUrl: `${STREAMINGCOMMUNITY_DEFAULT_ORIGIN}/it/watch/${id}`,
          status: isMovie ? ('completed' as const) : ('ongoing' as const),
          genres: [],
          episodeCount: isMovie ? 1 : item.seasons_count ?? 1,
          year: item.last_air_date ? String(item.last_air_date).slice(0, 4) : undefined,
        };
      });
    } catch {
      return [];
    }
  }
}
