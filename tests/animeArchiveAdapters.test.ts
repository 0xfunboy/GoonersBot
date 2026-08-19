import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  ANIMEUNITY_ORIGIN,
  AnimeUnityAdapter,
  classifyAnimeUnityUrl,
  parseAnimeUnityPage,
  parseAnimeUnitySearchResults,
  parseVixCloudPlayer,
} from '../src/anime/archive/animeUnity.js';
import {
  assertAllowedArchiveUrl,
  redactSignedUrl,
  type AnimeArchiveHttpClient,
  type AnimeArchiveHttpRequest,
  type AnimeArchiveHttpResponse,
} from '../src/anime/archive/http.js';
import {
  HENTAISATURN_ORIGIN,
  HentaiSaturnAdapter,
  classifyHentaiSaturnUrl,
  decodeHentaiSaturnPlayerField,
  parseHentaiSaturnEpisodePage,
  parseHentaiSaturnSearchResults,
  parseHentaiSaturnSeriesPage,
} from '../src/anime/archive/hentaiSaturn.js';
import { AnimeSourceRegistry } from '../src/anime/archive/registry.js';
import type {
  AnimeArchiveEpisode,
  AnimeArchiveSearchResult,
  AnimeArchiveSeries,
  AnimeArchiveSource,
  AnimeSourceAdapter,
} from '../src/anime/archive/types.js';

const AU_SERIES_URL = `${ANIMEUNITY_ORIGIN}/anime/123-fixture-series`;
const AU_EPISODE_URL = `${AU_SERIES_URL}/9001`;
const AU_PAGE = `<video-player
  anime='{"id":123,"title":"Fixture Series","title_eng":"Fixture Alias","slug":"fixture-series","plot":"Sanitized plot","status":"In Corso","episodes_count":3,"date":"2026","score":"8.25","genres":[{"name":"Action"}]}'
  episodes='[{"id":9003,"number":"10","created_at":"2026-01-10 12:00:00"},{"id":9001,"number":"1.5","created_at":"2026-01-02 12:00:00"},{"id":9002,"number":"2","created_at":"2026-01-03 12:00:00"},{"id":9999,"number":"99","hidden":1}]'>
</video-player>`;

const AU_SEARCH_PAGE = `<archivio records='[
  {"id":123,"title":"Fixture Series","slug":"fixture-series","imageurl":"https://img.example.test/cover.jpg","status":"Terminato","real_episodes_count":12,"date":"2026","genres":[{"name":"Action"},{"name":"Comedy"}]},
  {"id":124,"title":"Second Fixture","slug":"second-fixture","status":"In Corso","episodes_count":2,"genres":[]}
]'></archivio>`;

const VIX_PLAYER = `<script>
window.masterPlaylist = {url: "https://au-u2-01.vix-content.net/master.m3u8", token: "fixture-token", expires: "2000000000", asn: "64500"};
window.streams = [
  {"name":"primary","active":true,"url":"https://vixcloud.co/playlist/fixture?ub=1"},
  {"name":"untrusted","active":false,"url":"https://vixcloud.co.attacker.test/playlist/fixture"}
];
window.downloadUrl = "https://au-d1-02.vix-content.net/video.mp4?token=fixture-token&expires=2000000000";
</script>`;

const HS_SLUG = 'fixture-series-Ab12C';
const HS_SERIES_URL = `${HENTAISATURN_ORIGIN}/hentai/${HS_SLUG}`;
const HS_EPISODE_URL = `${HENTAISATURN_ORIGIN}/episode/${HS_SLUG}/ep-1`;
const HS_WATCH_URL = `${HS_SERIES_URL}/ep-1`;
const HS_SERIES_PAGE = `<script type="application/ld+json">{
  "@type":"TVSeries","name":"Fixture Saturn","alternateName":["Fixture Alias"],
  "description":"Sanitized description","image":"https://cdn.hentaisaturn.tv/poster.jpg",
  "genre":["Fantasy","Comedy"],"datePublished":"2024-01-01","numberOfEpisodes":3,
  "aggregateRating":{"ratingValue":"7.8"}
}</script>
<dl><div class="hs-info-row"><dt>Stato</dt><dd>Terminato</dd></div><div class="hs-info-row"><dt>Studio</dt><dd>Fixture Studio</dd></div></dl>
<a class="ep-tile" href="/episode/${HS_SLUG}/ep-10">10</a>
<a class="ep-tile" href="/episode/${HS_SLUG}/ep-2">2</a>
<a class="ep-tile" href="/episode/${HS_SLUG}/ep-1.5">1.5</a>`;

const HS_EPISODE_PAGE = `<script type="application/ld+json">{
  "@type":"TVEpisode","name":"Fixture Saturn Episode 1","episodeNumber":1,
  "datePublished":"2024-01-02","partOfSeries":{"@type":"TVSeries","name":"Fixture Saturn"}
}</script><a class="ept-btn--play" href="/hentai/${HS_SLUG}/ep-1">Play</a>`;

const HS_SEARCH_RESPONSE = JSON.stringify({
  query: 'fixture',
  results: [
    {
      title: 'Fixture Saturn',
      url: `/hentai/${HS_SLUG}`,
      poster: 'https://cdn.hentaisaturn.tv/search.jpg',
      year: '2024',
      episodes: 3,
      genres: [{ name: 'Fantasy' }],
      status: { label: 'Terminato', tone: 'completed' },
    },
  ],
});

class FixtureHttpClient implements AnimeArchiveHttpClient {
  readonly calls: Array<{ url: string; request: AnimeArchiveHttpRequest }> = [];

  constructor(
    private readonly responder: (
      url: URL,
      request: AnimeArchiveHttpRequest,
    ) => string | AnimeArchiveHttpResponse,
  ) {}

  async fetchText(
    rawUrl: string | URL,
    request: AnimeArchiveHttpRequest,
  ): Promise<AnimeArchiveHttpResponse> {
    const url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
    this.calls.push({ url: url.toString(), request });
    const response = this.responder(url, request);
    return typeof response === 'string'
      ? { text: response, finalUrl: url.toString(), contentType: 'text/html' }
      : response;
  }
}

describe('anime archive URL boundaries', () => {
  it('classifies AnimeUnity series and episodes while rejecting lookalikes and path suffixes', () => {
    expect(classifyAnimeUnityUrl(`${AU_EPISODE_URL}?ignored=1#fragment`)).toMatchObject({
      source: 'animeunity',
      kind: 'episode',
      episodeId: '9001',
      canonicalUrl: AU_EPISODE_URL,
    });
    expect(classifyAnimeUnityUrl(AU_SERIES_URL)).toMatchObject({ kind: 'series' });
    expect(classifyAnimeUnityUrl(`${AU_EPISODE_URL}/extra`)).toBeNull();
    expect(
      classifyAnimeUnityUrl('https://www.animeunity.so.attacker.test/anime/123-fixture-series'),
    ).toBeNull();
  });

  it('normalizes both HentaiSaturn episode surfaces without widening the host boundary', () => {
    expect(classifyHentaiSaturnUrl(HS_EPISODE_URL)).toMatchObject({
      kind: 'episode',
      episodeNumber: '1',
      canonicalUrl: HS_EPISODE_URL,
    });
    expect(classifyHentaiSaturnUrl(HS_WATCH_URL)).toMatchObject({
      kind: 'episode',
      canonicalUrl: HS_EPISODE_URL,
    });
    expect(classifyHentaiSaturnUrl(HS_SERIES_URL)).toMatchObject({ kind: 'series' });
    expect(
      classifyHentaiSaturnUrl(`https://www.hentaisaturn.tv.attacker.test/hentai/${HS_SLUG}`),
    ).toBeNull();
  });
});

describe('AnimeUnity adapter', () => {
  it('parses metadata and sorts decimal episode numbers numerically', () => {
    const series = parseAnimeUnityPage(AU_PAGE, AU_SERIES_URL);
    expect(series).toMatchObject({
      sourceId: '123',
      title: 'Fixture Series',
      aliases: ['Fixture Series', 'Fixture Alias'],
      status: 'ongoing',
      episodeCount: 3,
      year: '2026',
      score: 8.25,
      genres: ['Action'],
    });
    expect(series?.episodes.map((episode) => episode.number)).toEqual(['1.5', '2', '10']);
    expect(series?.episodes.map((episode) => episode.order)).toEqual([1.5, 2, 10]);
  });

  it('parses the bounded public archive search fixture', () => {
    expect(parseAnimeUnitySearchResults(AU_SEARCH_PAGE, 1)).toEqual([
      expect.objectContaining({
        source: 'animeunity',
        sourceId: '123',
        slug: 'fixture-series',
        title: 'Fixture Series',
        canonicalUrl: AU_SERIES_URL,
        status: 'completed',
        episodeCount: 12,
        year: '2026',
        genres: ['Action', 'Comedy'],
      }),
    ]);
  });

  it('uses the public GET archive surface and bounds the source limit', async () => {
    const http = new FixtureHttpClient(() => AU_SEARCH_PAGE);
    const results = await new AnimeUnityAdapter(http).search('  fixture   series  ', 50);

    expect(results).toHaveLength(2);
    expect(http.calls).toHaveLength(1);
    const request = new URL(http.calls[0]?.url ?? 'https://invalid.test');
    expect(request.pathname).toBe('/archivio');
    expect(request.searchParams.get('title')).toBe('fixture series');
    expect(http.calls[0]?.request.allowedHosts).toEqual(['animeunity.so']);
  });

  it('extracts direct download and player streams while discarding an attacker host', () => {
    const parsed = parseVixCloudPlayer(VIX_PLAYER, 'https://vixcloud.co/embed/fixture');
    expect(parsed.candidates.map((candidate) => candidate.label)).toEqual([
      'download',
      'master',
      'primary',
    ]);
    expect(parsed.candidates[0]).toMatchObject({
      kind: 'download',
      mimeType: 'video/mp4',
      requestHeaders: { referer: 'https://vixcloud.co/' },
    });
    expect(new URL(parsed.candidates[1]?.url ?? '').searchParams.get('token')).toBe(
      'fixture-token',
    );
    expect(new URL(parsed.candidates[2]?.url ?? '').searchParams.get('expires')).toBe('2000000000');
  });

  it('resolves the embed endpoint and signed VixCloud URLs just in time', async () => {
    const http = new FixtureHttpClient((url) => {
      if (url.pathname === '/embed-url/9001') {
        return 'https://vixcloud.co/embed/fixture?token=sanitized';
      }
      if (url.hostname === 'vixcloud.co') return VIX_PLAYER;
      throw new Error(`unexpected fixture URL: ${url.origin}${url.pathname}`);
    });
    const adapter = new AnimeUnityAdapter(http);
    const episode = parseAnimeUnityPage(AU_PAGE, AU_EPISODE_URL)?.episodes[0];
    expect(episode).toBeDefined();

    await adapter.resolveMedia(episode as AnimeArchiveEpisode);
    await adapter.resolveMedia(episode as AnimeArchiveEpisode);

    expect(
      http.calls.filter((call) => new URL(call.url).pathname === '/embed-url/9001'),
    ).toHaveLength(2);
    expect(http.calls[0]?.request.headers).toMatchObject({
      'x-requested-with': 'XMLHttpRequest',
    });
  });
});

describe('HentaiSaturn adapter', () => {
  it('parses series metadata and orders current episode tiles numerically', () => {
    const series = parseHentaiSaturnSeriesPage(HS_SERIES_PAGE, HS_SERIES_URL);
    expect(series).toMatchObject({
      sourceId: HS_SLUG,
      title: 'Fixture Saturn',
      status: 'completed',
      episodeCount: 3,
      genres: ['Fantasy', 'Comedy'],
      year: '2024',
      studio: 'Fixture Studio',
      score: 7.8,
    });
    expect(series?.episodes.map((episode) => episode.number)).toEqual(['1.5', '2', '10']);
  });

  it('parses the public episode JSON-LD and search API response', () => {
    expect(parseHentaiSaturnEpisodePage(HS_EPISODE_PAGE, HS_EPISODE_URL)).toMatchObject({
      sourceId: `${HS_SLUG}:ep-1`,
      seriesTitle: 'Fixture Saturn',
      number: '1',
      order: 1,
    });
    expect(parseHentaiSaturnSearchResults(HS_SEARCH_RESPONSE, 5)).toEqual([
      expect.objectContaining({
        source: 'hentaisaturn',
        sourceId: HS_SLUG,
        title: 'Fixture Saturn',
        canonicalUrl: HS_SERIES_URL,
        status: 'completed',
        episodeCount: 3,
      }),
    ]);
  });

  it('decodes the player field and follows landing, watch, embed and playlist hops', async () => {
    const key = 'fixtureKey42';
    const media = 'https://server.hcontent.net/fixture.mp4?expires=2000000000&sig=sanitized';
    const poster = 'https://cdn.hentaisaturn.tv/fixture.jpg';
    const playlist = JSON.stringify({ d: xorBase64(media, key), p: xorBase64(poster, key) });
    expect(decodeHentaiSaturnPlayerField(xorBase64(media, key), key)).toBe(media);

    const http = new FixtureHttpClient((url) => {
      if (url.hostname === 'www.hentaisaturn.tv' && url.pathname.startsWith('/episode/')) {
        return HS_EPISODE_PAGE;
      }
      if (url.hostname === 'www.hentaisaturn.tv' && url.pathname.startsWith('/hentai/')) {
        return '<iframe id="watch-iframe" src="https://play.hentaisaturn.tv/embed/4195?sig=sanitized"></iframe>';
      }
      if (url.pathname === '/embed/4195/playlist') {
        return { text: playlist, finalUrl: url.toString(), contentType: 'application/json' };
      }
      if (url.pathname === '/embed/4195') {
        return '<script>window.__E={i:4195,k:"fixtureKey42",e:2000000000};</script>';
      }
      throw new Error(`unexpected fixture URL: ${url.origin}${url.pathname}`);
    });
    const adapter = new HentaiSaturnAdapter(http);
    const episode = await adapter.getEpisode(HS_EPISODE_URL);
    const resolved = await adapter.resolveMedia(episode);

    expect(resolved.candidates).toEqual([
      expect.objectContaining({
        url: media,
        kind: 'download',
        mimeType: 'video/mp4',
        requestHeaders: { referer: 'https://play.hentaisaturn.tv/' },
      }),
    ]);
    expect(resolved.posterUrl).toBe(poster);
    expect(http.calls.map((call) => new URL(call.url).pathname)).toEqual([
      `/episode/${HS_SLUG}/ep-1`,
      `/episode/${HS_SLUG}/ep-1`,
      `/hentai/${HS_SLUG}/ep-1`,
      '/embed/4195',
      '/embed/4195/playlist',
    ]);
  });
});

describe('anime source registry and safe URL helpers', () => {
  it('consults both sources, tolerates one failure and returns the successful source', async () => {
    const auSearch = vi.fn().mockRejectedValue(new Error('fixture outage'));
    const hsResult = searchResult('hentaisaturn', 'hs-1', 'Fixture Saturn');
    const hsSearch = vi.fn().mockResolvedValue([hsResult]);
    const registry = new AnimeSourceRegistry([
      stubAdapter('animeunity', auSearch),
      stubAdapter('hentaisaturn', hsSearch),
    ]);

    await expect(registry.search('fixture', 5)).resolves.toEqual([hsResult]);
    expect(auSearch).toHaveBeenCalledOnce();
    expect(hsSearch).toHaveBeenCalledOnce();
  });

  it('interleaves successful source results and dispatches classified URLs', async () => {
    const au = stubAdapter(
      'animeunity',
      vi
        .fn()
        .mockResolvedValue([
          searchResult('animeunity', 'au-1', 'AU One'),
          searchResult('animeunity', 'au-2', 'AU Two'),
        ]),
      classifyAnimeUnityUrl,
    );
    const hs = stubAdapter(
      'hentaisaturn',
      vi.fn().mockResolvedValue([searchResult('hentaisaturn', 'hs-1', 'HS One')]),
      classifyHentaiSaturnUrl,
    );
    const registry = new AnimeSourceRegistry([au, hs]);

    expect((await registry.search('fixture', 3)).map((result) => result.sourceId)).toEqual([
      'au-1',
      'hs-1',
      'au-2',
    ]);
    expect(registry.resolve(AU_EPISODE_URL)).toMatchObject({
      adapter: au,
      classification: { source: 'animeunity', kind: 'episode' },
    });
  });

  it('checks host suffixes on label boundaries and redacts complete signed queries', () => {
    expect(() =>
      assertAllowedArchiveUrl('https://vixcloud.co.attacker.test/embed/1', ['vixcloud.co']),
    ).toThrow(/host is not allowed/);
    expect(
      redactSignedUrl('https://media.example.test/video.mp4?token=secret&expires=2000000000#x'),
    ).toBe('https://media.example.test/video.mp4?[redacted]');
  });
});

function xorBase64(value: string, key: string): string {
  const bytes = Buffer.from(value, 'utf8');
  const keyBytes = Buffer.from(key, 'utf8');
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    const keyByte = keyBytes[index % keyBytes.length];
    if (byte === undefined || keyByte === undefined) throw new Error('invalid fixture key');
    bytes[index] = byte ^ keyByte;
  }
  return bytes.toString('base64');
}

function searchResult(
  source: AnimeArchiveSource,
  sourceId: string,
  title: string,
): AnimeArchiveSearchResult {
  return {
    source,
    sourceId,
    slug: sourceId,
    title,
    canonicalUrl:
      source === 'animeunity'
        ? `${ANIMEUNITY_ORIGIN}/anime/1-${sourceId}`
        : `${HENTAISATURN_ORIGIN}/hentai/${sourceId}`,
    status: 'unknown',
    genres: [],
  };
}

function stubAdapter(
  source: AnimeArchiveSource,
  search: AnimeSourceAdapter['search'],
  classify: AnimeSourceAdapter['classify'] = () => null,
): AnimeSourceAdapter {
  return {
    source,
    classify,
    search,
    getSeries: async () => Promise.reject(new Error('unused fixture method')),
    getEpisode: async () => Promise.reject(new Error('unused fixture method')),
    listEpisodes: async (_series: AnimeArchiveSeries) =>
      Promise.reject(new Error('unused fixture method')),
    resolveMedia: async (_episode: AnimeArchiveEpisode) =>
      Promise.reject(new Error('unused fixture method')),
  };
}
