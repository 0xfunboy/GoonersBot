import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnilistProvider,
  latestAiredEpisode,
  parseMedia,
  parseMediaPage,
} from '../src/anime/providers/anilist.js';
import { applyEnrichment, parseJikanAnime } from '../src/anime/providers/jikan.js';
import type { AnimeSeries } from '../src/anime/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Sanitized AniList media node, shaped like the real `Media` type but with invented values. */
const TANYA_NODE = {
  id: 21255,
  idMal: 32615,
  title: { romaji: 'Youjo Senki', english: 'Saga of Tanya the Evil', native: '幼女戦記' },
  synonyms: ['Youjo Senki ITA'],
  siteUrl: 'https://anilist.co/anime/21255',
  description: 'A <b>military</b> fantasy.<br>Second line.',
  status: 'RELEASING',
  format: 'TV',
  episodes: 12,
  genres: ['Action', 'Drama'],
  season: 'WINTER',
  seasonYear: 2017,
  averageScore: 78,
  updatedAt: 1_700_000_000,
  coverImage: { large: 'https://img.anili.st/cover.jpg' },
  // 2024-01-04 is a Thursday (ISO weekday 4).
  nextAiringEpisode: { episode: 7, airingAt: 1_704_326_400 },
  studios: { nodes: [{ name: 'NUT' }] },
  externalLinks: [
    { site: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/x', type: 'STREAMING' },
    { site: 'Official Site', url: 'https://example.com/', type: 'INFO' },
    { site: 'Sketchy', url: 'http://insecure.example/', type: 'STREAMING' },
  ],
};

describe('parseMedia', () => {
  it('maps a full media node onto the domain type', () => {
    const series = parseMedia(TANYA_NODE);
    expect(series).not.toBeNull();
    expect(series?.sourceId).toBe('21255');
    expect(series?.title).toBe('Saga of Tanya the Evil');
    expect(series?.titleRomaji).toBe('Youjo Senki');
    expect(series?.status).toBe('ongoing');
    expect(series?.format).toBe('tv');
    expect(series?.episodeCount).toBe(12);
    expect(series?.externalIds).toEqual({ anilist: 21255, mal: 32615 });
    expect(series?.studios).toEqual(['NUT']);
    expect(series?.score).toBe(78);
  });

  it('derives the latest aired episode from the next scheduled one', () => {
    expect(parseMedia(TANYA_NODE)?.latestEpisode).toBe(6);
  });

  it('derives the ISO airing weekday from the next airing timestamp', () => {
    expect(parseMedia(TANYA_NODE)?.airingWeekday).toBe(4);
  });

  it('builds lookup keys covering every known title and alias', () => {
    const keys = parseMedia(TANYA_NODE)?.titleKeys ?? [];
    expect(keys).toContain('saga of tanya the evil');
    expect(keys).toContain('youjo senki');
  });

  it('strips HTML from the description', () => {
    expect(parseMedia(TANYA_NODE)?.description).toBe('A military fantasy. Second line.');
  });

  it('does not carry AniList gateway links into the catalog domain', () => {
    expect(parseMedia(TANYA_NODE)).not.toHaveProperty('streamingLinks');
  });

  it('tolerates a node where every optional field is missing', () => {
    const series = parseMedia({ id: 1, title: { romaji: 'Bare Minimum' } });
    expect(series?.title).toBe('Bare Minimum');
    expect(series?.episodeCount).toBeUndefined();
    expect(series?.latestEpisode).toBeUndefined();
    expect(series?.nextEpisode).toBeUndefined();
    expect(series?.externalIds.mal).toBeUndefined();
    expect(series?.genres).toEqual([]);
    expect(series?.url).toBe('https://anilist.co/anime/1');
  });

  it('rejects nodes with no id or no usable title', () => {
    expect(parseMedia({ title: { romaji: 'No Id' } })).toBeNull();
    expect(parseMedia({ id: 5, title: { romaji: '   ' } })).toBeNull();
    expect(parseMedia(null)).toBeNull();
    expect(parseMedia('not an object')).toBeNull();
  });
});

describe('latestAiredEpisode', () => {
  it('prefers the next-airing anchor over the planned total while releasing', () => {
    expect(latestAiredEpisode('ongoing', 24, 9)).toBe(8);
  });

  it('uses the total once the series has finished', () => {
    expect(latestAiredEpisode('finished', 12, undefined)).toBe(12);
  });

  it('reports zero for an unreleased series', () => {
    expect(latestAiredEpisode('not_yet_released', 12, undefined)).toBe(0);
  });

  it('stays undefined when the source published nothing usable', () => {
    expect(latestAiredEpisode('ongoing', undefined, undefined)).toBeUndefined();
  });
});

describe('parseMediaPage', () => {
  it('drops malformed nodes and keeps the parsable ones', () => {
    const page = parseMediaPage({
      Page: { media: [TANYA_NODE, { id: 0 }, null, { title: { romaji: 'orphan' } }] },
    });
    expect(page).toHaveLength(1);
    expect(page[0]?.sourceId).toBe('21255');
  });

  it('returns nothing for a structurally changed payload', () => {
    expect(parseMediaPage({ Page: { media: 'not an array' } })).toEqual([]);
    expect(parseMediaPage({ unexpected: true })).toEqual([]);
    expect(parseMediaPage(null)).toEqual([]);
  });
});

describe('AnilistProvider', () => {
  const config = {
    enabled: true,
    apiUrl: 'https://graphql.anilist.co',
    timeoutMs: 5_000,
    maxResponseBytes: 256 * 1024,
  };

  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('issues a POST GraphQL query and parses the page', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { Page: { media: [TANYA_NODE] } } }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await new AnilistProvider(config).search('tanya');
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Saga of Tanya the Evil');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('tanya');
    expect(String(init.body)).not.toContain('externalLinks');
  });

  it('degrades to an empty result when the API reports GraphQL errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ errors: [{ message: 'Too Many Requests' }] })),
    );
    expect(await new AnilistProvider(config).search('tanya')).toEqual([]);
  });

  it('degrades to an empty result when the transport fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    expect(await new AnilistProvider(config).search('tanya')).toEqual([]);
  });

  it('never calls the network when disabled or given an empty query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await new AnilistProvider({ ...config, enabled: false }).search('tanya')).toEqual([]);
    expect(await new AnilistProvider(config).search('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores non-numeric ids instead of querying for them', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await new AnilistProvider(config).getManyByIds(['abc', '-3', ''])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('jikan enrichment', () => {
  it('extracts the broadcast weekday, score and episode count', () => {
    expect(
      parseJikanAnime({
        data: { broadcast: { day: 'Thursdays' }, score: 8.2, episodes: 12 },
      }),
    ).toEqual({ airingWeekday: 4, score: 82, episodeCount: 12 });
  });

  it('returns null when nothing usable is present', () => {
    expect(parseJikanAnime({ data: {} })).toBeNull();
    expect(parseJikanAnime({ nope: true })).toBeNull();
    expect(parseJikanAnime(null)).toBeNull();
  });

  it('only fills gaps and never overwrites primary-source data', () => {
    const series = {
      title: 'x',
      airingWeekday: 2,
      score: 90,
      episodeCount: undefined,
    } as unknown as AnimeSeries;
    const merged = applyEnrichment(series, {
      airingWeekday: 5,
      score: 10,
      episodeCount: 24,
    });
    expect(merged.airingWeekday).toBe(2);
    expect(merged.score).toBe(90);
    expect(merged.episodeCount).toBe(24);
  });

  it('is a no-op when there is no enrichment', () => {
    const series = { title: 'x' } as unknown as AnimeSeries;
    expect(applyEnrichment(series, null)).toBe(series);
  });
});
