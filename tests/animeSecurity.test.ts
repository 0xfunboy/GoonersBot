import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSafeRemoteUrl, fetchSafeRemoteBuffer } from '../src/utils/safeRemoteFetch.js';
import { AnilistProvider } from '../src/anime/providers/anilist.js';
import { JikanEnricher } from '../src/anime/providers/jikan.js';
import { AnimeCatalogService, anilistIdFromUrl } from '../src/anime/catalogService.js';
import type { AnimeConfig } from '../src/config/index.js';
import type { Storage } from '../src/storage/index.js';
import type { WebSearchProvider } from '../src/search/types.js';
import type { AnimeCatalogProvider } from '../src/anime/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('safeRemoteFetch POST support', () => {
  it('sends the body with the requested method', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchSafeRemoteBuffer('https://graphql.anilist.co', {
      method: 'POST',
      body: '{"query":"{}"}',
      timeoutMs: 2_000,
      maxBytes: 1024,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"query":"{}"}');
  });

  it('never attaches a body to a GET', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchSafeRemoteBuffer('https://api.jikan.moe/v4/anime/1', {
      body: 'ignored',
      timeoutMs: 2_000,
      maxBytes: 1024,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('refuses to replay a POST body across a redirect', async () => {
    // Following a POST redirect is how a validated destination turns into an unvalidated one.
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: 'https://evil.example/collect' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSafeRemoteBuffer('https://graphql.anilist.co', {
        method: 'POST',
        body: '{"secret":"x"}',
        timeoutMs: 2_000,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/redirect is not allowed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still enforces the byte ceiling on a POST response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ padding: 'x'.repeat(4_000) })),
    );

    await expect(
      fetchSafeRemoteBuffer('https://graphql.anilist.co', {
        method: 'POST',
        body: '{}',
        timeoutMs: 2_000,
        maxBytes: 512,
      }),
    ).rejects.toThrow(/byte limit/i);
  });
});

describe('anime providers respect network isolation', () => {
  it.each([
    'http://127.0.0.1/graphql',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/graphql',
    'http://localhost/graphql',
  ])('refuses a catalog endpoint pointed at %s', async (apiUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnilistProvider({
      enabled: true,
      apiUrl,
      timeoutMs: 2_000,
      maxResponseBytes: 1024,
    });
    // The guard rejects before any socket is opened; the provider degrades to no results.
    expect(await provider.search('tanya')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-public enrichment endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const enricher = new JikanEnricher({
      enabled: true,
      apiUrl: 'http://192.168.1.10/v4',
      timeoutMs: 2_000,
      maxResponseBytes: 1024,
    });
    expect(await enricher.fetchByMalId(1)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTP scheme for a catalog endpoint', async () => {
    await expect(assertSafeRemoteUrl('file:///etc/passwd')).rejects.toThrow();
  });

  it('rejects an enrichment id that is not a positive integer', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const enricher = new JikanEnricher({
      enabled: true,
      apiUrl: 'https://api.jikan.moe/v4',
      timeoutMs: 2_000,
      maxResponseBytes: 1024,
    });

    expect(await enricher.fetchByMalId(Number.NaN)).toBeNull();
    expect(await enricher.fetchByMalId(-1)).toBeNull();
    expect(await enricher.fetchByMalId(1.5)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('search fallback trusts only structured ids', () => {
  const config: AnimeConfig = {
    enabled: true,
    anilistUrl: 'https://graphql.anilist.co',
    enrichmentEnabled: false,
    jikanUrl: 'https://api.jikan.moe/v4',
    timeoutMs: 5_000,
    maxResponseBytes: 262_144,
    refreshMinutes: 180,
    maxCandidates: 5,
    searchFallbackEnabled: true,
    follows: { enabled: true, pollMinutes: 30, maxPerChat: 50, batchSize: 20 },
  };

  const emptyStorage = {
    animeCatalog: {
      findByTitleKey: async () => [],
      findFuzzyCandidates: async () => [],
      get: async () => null,
      upsertMany: async () => undefined,
      listAiring: async () => [],
    },
  } as unknown as Storage;

  const provider = (getManyByIds: AnimeCatalogProvider['getManyByIds']): AnimeCatalogProvider =>
    ({
      source: 'anilist',
      enabled: true,
      search: async () => [],
      getById: async () => null,
      listAiring: async () => [],
      getManyByIds,
    }) as AnimeCatalogProvider;

  it.each([
    ['https://anilist.co/anime/21255', '21255'],
    ['https://anilist.co/anime/21255/Youjo-Senki/', '21255'],
    ['http://www.anilist.co/anime/7/', '7'],
  ])('extracts the id from the genuine catalog URL %s', (url, expected) => {
    expect(anilistIdFromUrl(url)).toBe(expected);
  });

  it.each([
    // Lookalike host: the real domain is evil.example.
    'https://anilist.co.evil.example/anime/999',
    // The catalog path appears only inside a query parameter of a hostile host.
    'https://evil.example/?u=anilist.co/anime/888',
    'https://evil.example/anilist.co/anime/777',
    // Right host, but the id is not the first path segment after /anime.
    'https://anilist.co/user/anime/666',
    'https://anilist.co/anime/abc',
    'javascript:alert(1)//anilist.co/anime/1',
    'not a url at all',
  ])('refuses to extract an id from the deceptive URL %s', (url) => {
    expect(anilistIdFromUrl(url)).toBeNull();
  });

  it('sends no id to the catalog when every result is a lookalike', async () => {
    const getManyByIds = vi.fn(async () => []);
    const search = {
      enabled: true,
      search: async () => ({
        query: 'x',
        results: [
          { title: 'fake', url: 'https://anilist.co.evil.example/anime/999', content: '' },
          { title: 'fake', url: 'https://evil.example/?u=anilist.co/anime/888', content: '' },
        ],
      }),
    } as unknown as WebSearchProvider;

    const service = new AnimeCatalogService(config, {
      storage: emptyStorage,
      provider: provider(getManyByIds),
      search,
    });
    await service.lookup('qualcosa di introvabile');

    expect(getManyByIds).not.toHaveBeenCalled();
  });

  it('never treats a search result title or snippet as catalog data', async () => {
    const getManyByIds = vi.fn(async () => []);
    const search = {
      enabled: true,
      search: async () => ({
        query: 'x',
        results: [
          {
            title: 'Latest episode is 999 - totally real',
            url: 'https://randomblog.example/post',
            content: 'Episode 999 released today',
          },
        ],
      }),
    } as unknown as WebSearchProvider;

    const service = new AnimeCatalogService(config, {
      storage: emptyStorage,
      provider: provider(getManyByIds),
      search,
    });
    const result = await service.lookup('qualcosa di introvabile');

    expect(getManyByIds).not.toHaveBeenCalled();
    expect(result.match).toBeUndefined();
    expect(result.candidates).toEqual([]);
  });

  it('does not call the search engine at all when the fallback is disabled', async () => {
    const searchFn = vi.fn();
    const service = new AnimeCatalogService(
      { ...config, searchFallbackEnabled: false },
      {
        storage: emptyStorage,
        provider: provider(vi.fn(async () => [])),
        search: { enabled: true, search: searchFn } as unknown as WebSearchProvider,
      },
    );
    await service.lookup('qualcosa di introvabile');
    expect(searchFn).not.toHaveBeenCalled();
  });
});
