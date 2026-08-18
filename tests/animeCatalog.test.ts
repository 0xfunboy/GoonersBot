import { describe, expect, it, vi } from 'vitest';
import { AnimeCatalogService } from '../src/anime/catalogService.js';
import { canonicalTitleKey, titleKeys } from '../src/anime/titles.js';
import type { AnimeCatalogProvider, AnimeSeries } from '../src/anime/types.js';
import type { AnimeSeriesDoc } from '../src/storage/repositories/animeCatalog.js';
import type { AnimeConfig } from '../src/config/index.js';
import type { Storage } from '../src/storage/index.js';
import type { WebSearchProvider } from '../src/search/types.js';

const config = (overrides: Partial<AnimeConfig> = {}): AnimeConfig => ({
  enabled: true,
  anilistUrl: 'https://graphql.anilist.co',
  enrichmentEnabled: false,
  jikanUrl: 'https://api.jikan.moe/v4',
  timeoutMs: 5_000,
  maxResponseBytes: 262_144,
  refreshMinutes: 180,
  maxCandidates: 5,
  searchFallbackEnabled: false,
  follows: { enabled: true, pollMinutes: 30, maxPerChat: 50, batchSize: 20 },
  ...overrides,
});

function series(
  overrides: Partial<AnimeSeries> & { sourceId: string; title: string },
): AnimeSeries {
  const aliases = overrides.aliases ?? [];
  return {
    source: 'anilist',
    aliases,
    titleKeys: titleKeys([overrides.title, ...aliases]),
    url: `https://anilist.co/anime/${overrides.sourceId}`,
    status: 'ongoing',
    genres: [],
    studios: [],
    externalIds: {},
    streamingLinks: [],
    ...overrides,
  };
}

/**
 * In-memory stand-in for AnimeCatalogRepo with the same key semantics: `source` + `sourceId` is
 * unique, so an upsert of a known series must update it rather than append a second one.
 */
function fakeCatalogRepo(seed: AnimeSeries[] = [], crawledAt = new Date()) {
  const docs = new Map<string, AnimeSeriesDoc>();
  const put = (entry: AnimeSeries, when: Date): void => {
    const key = `${entry.source}:${entry.sourceId}`;
    const existing = docs.get(key);
    docs.set(key, {
      ...entry,
      crawledAt: when,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? when,
      updatedAt: when,
    });
  };
  for (const entry of seed) put(entry, crawledAt);

  return {
    docs,
    async get(source: string, sourceId: string) {
      return docs.get(`${source}:${sourceId}`) ?? null;
    },
    async findByTitleKey(key: string, limit = 10) {
      return [...docs.values()].filter((doc) => doc.titleKeys.includes(key)).slice(0, limit);
    },
    async findFuzzyCandidates(tokens: readonly string[], limit = 200) {
      const usable = tokens.filter((token) => token.length >= 3);
      if (usable.length === 0) return [];
      return [...docs.values()]
        .filter((doc) => doc.titleKeys.some((key) => usable.some((token) => key.includes(token))))
        .slice(0, limit);
    },
    async upsertMany(entries: readonly AnimeSeries[], now = new Date()) {
      for (const entry of entries) put(entry, now);
    },
    async listAiring(limit = 20) {
      return [...docs.values()].filter((doc) => doc.status === 'ongoing').slice(0, limit);
    },
  };
}

const storageWith = (catalog: ReturnType<typeof fakeCatalogRepo>): Storage =>
  ({ animeCatalog: catalog }) as unknown as Storage;

function fakeProvider(overrides: Partial<AnimeCatalogProvider> = {}): AnimeCatalogProvider {
  return {
    source: 'anilist',
    enabled: true,
    search: vi.fn(async () => []),
    getById: vi.fn(async () => null),
    listAiring: vi.fn(async () => []),
    getManyByIds: vi.fn(async () => []),
    ...overrides,
  } as AnimeCatalogProvider;
}

const TANYA = series({
  sourceId: '21255',
  title: 'Saga of Tanya the Evil',
  aliases: ['Youjo Senki'],
  latestEpisode: 6,
  episodeCount: 12,
});

describe('AnimeCatalogService lookup ladder', () => {
  it('answers from the persisted catalog without any remote call', async () => {
    const provider = fakeProvider();
    const catalog = fakeCatalogRepo([TANYA]);
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(catalog),
      provider,
    });

    const result = await service.lookup('tanya the evil');
    expect(result.match?.series.sourceId).toBe('21255');
    expect(result.fromCache).toBe(true);
    expect(provider.search).not.toHaveBeenCalled();
  });

  it('resolves an alias through the persisted index', async () => {
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(fakeCatalogRepo([TANYA])),
      provider: fakeProvider(),
    });
    expect((await service.lookup('youjo senki')).match?.series.sourceId).toBe('21255');
  });

  it('falls back to the source catalog and persists what it learned', async () => {
    const catalog = fakeCatalogRepo();
    const provider = fakeProvider({ search: vi.fn(async () => [TANYA]) });
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(catalog),
      provider,
    });

    const result = await service.lookup('tanya the evil');
    expect(result.match?.series.sourceId).toBe('21255');
    expect(provider.search).toHaveBeenCalledOnce();
    expect(catalog.docs.size).toBe(1);
  });

  it('does not consult the web search engine for a title it already knows', async () => {
    const search = { enabled: true, search: vi.fn() } as unknown as WebSearchProvider;
    const service = new AnimeCatalogService(config({ searchFallbackEnabled: true }), {
      storage: storageWith(fakeCatalogRepo([TANYA])),
      provider: fakeProvider(),
      search,
    });

    await service.lookup('tanya the evil');
    expect(search.search).not.toHaveBeenCalled();
  });

  it('uses SearXNG only as a last resort and trusts only the id in the result URL', async () => {
    const search = {
      enabled: true,
      search: vi.fn(async () => ({
        query: 'x',
        results: [
          { title: 'unrelated', url: 'https://example.com/whatever', content: '' },
          { title: 'Tanya', url: 'https://anilist.co/anime/21255/Youjo-Senki/', content: '' },
        ],
      })),
    } as unknown as WebSearchProvider;
    const getManyByIds = vi.fn(async () => [TANYA]);
    const service = new AnimeCatalogService(config({ searchFallbackEnabled: true }), {
      storage: storageWith(fakeCatalogRepo()),
      provider: fakeProvider({ getManyByIds }),
      search,
    });

    const result = await service.lookup('quella dove la bambina fa la guerra');
    expect(search.search).toHaveBeenCalledOnce();
    expect(getManyByIds).toHaveBeenCalledWith(['21255'], undefined);
    expect(result.match?.series.sourceId).toBe('21255');
  });

  it('reports an unresolvable title instead of inventing a match', async () => {
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(fakeCatalogRepo([TANYA])),
      provider: fakeProvider(),
    });
    const result = await service.lookup('ricetta della carbonara');
    expect(result.match).toBeUndefined();
    expect(result.candidates).toEqual([]);
  });

  it('returns a ranked shortlist rather than guessing when two entries share a title', async () => {
    // A real catalog situation: the 2006 series and the 2014 remake carry the same title.
    const ambiguous = [
      series({ sourceId: '1', title: 'Fate/stay night', seasonYear: 2006 }),
      series({ sourceId: '2', title: 'Fate/stay night', seasonYear: 2014 }),
    ];
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(fakeCatalogRepo(ambiguous)),
      provider: fakeProvider(),
    });

    const result = await service.lookup('fate stay night');
    expect(result.match).toBeUndefined();
    expect(result.candidates.map((candidate) => candidate.series.sourceId)).toEqual(['1', '2']);
  });

  it('still answers decisively when one entry matches the title exactly', async () => {
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(
        fakeCatalogRepo([
          series({ sourceId: '1', title: 'Fate/stay night' }),
          series({ sourceId: '2', title: 'Fate/stay night: Heavens Feel' }),
        ]),
      ),
      provider: fakeProvider(),
    });

    expect((await service.lookup('fate stay night')).match?.series.sourceId).toBe('1');
  });
});

describe('AnimeCatalogService persistence', () => {
  it('is idempotent: refreshing a series updates it instead of duplicating it', async () => {
    const catalog = fakeCatalogRepo();
    const provider = fakeProvider({ search: vi.fn(async () => [TANYA]) });
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(catalog),
      provider,
    });

    await service.lookup('tanya the evil');
    await catalog.upsertMany([{ ...TANYA, latestEpisode: 7 }]);
    await catalog.upsertMany([{ ...TANYA, latestEpisode: 8 }]);

    expect(catalog.docs.size).toBe(1);
    const doc = catalog.docs.get('anilist:21255');
    expect(doc?.latestEpisode).toBe(8);
    expect(doc?.revision).toBe(3);
  });

  it('preserves createdAt across refreshes', async () => {
    const catalog = fakeCatalogRepo([TANYA], new Date('2024-01-01T00:00:00Z'));
    const created = catalog.docs.get('anilist:21255')?.createdAt;
    await catalog.upsertMany([TANYA], new Date('2024-06-01T00:00:00Z'));
    expect(catalog.docs.get('anilist:21255')?.createdAt).toEqual(created);
  });

  it('re-fetches a stale entry before answering', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 60 * 1000);
    const catalog = fakeCatalogRepo([TANYA], stale);
    const getById = vi.fn(async () => ({ ...TANYA, latestEpisode: 9 }));
    const service = new AnimeCatalogService(config({ refreshMinutes: 60 }), {
      storage: storageWith(catalog),
      provider: fakeProvider({ getById }),
    });

    const result = await service.lookup('tanya the evil');
    expect(getById).toHaveBeenCalledOnce();
    expect(result.match?.series.latestEpisode).toBe(9);
  });

  it('keeps serving the cached entry when the refresh fails', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 60 * 1000);
    const service = new AnimeCatalogService(config({ refreshMinutes: 60 }), {
      storage: storageWith(fakeCatalogRepo([TANYA], stale)),
      provider: fakeProvider({ getById: vi.fn(async () => null) }),
    });

    expect((await service.lookup('tanya the evil')).match?.series.latestEpisode).toBe(6);
  });

  it('still answers when persisting throws', async () => {
    const catalog = fakeCatalogRepo();
    catalog.upsertMany = vi.fn(async () => {
      throw new Error('mongo down');
    });
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(catalog),
      provider: fakeProvider({ search: vi.fn(async () => [TANYA]) }),
    });

    expect((await service.lookup('tanya the evil')).match?.series.sourceId).toBe('21255');
  });
});

describe('AnimeCatalogService guards', () => {
  it('does nothing when the feature is disabled', async () => {
    const provider = fakeProvider();
    const service = new AnimeCatalogService(config({ enabled: false }), {
      storage: storageWith(fakeCatalogRepo([TANYA])),
      provider,
    });
    expect(await service.lookup('tanya')).toEqual({ candidates: [], fromCache: false });
    expect(provider.search).not.toHaveBeenCalled();
  });

  it('treats an empty query as unanswerable without touching the network', async () => {
    const provider = fakeProvider();
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(fakeCatalogRepo()),
      provider,
    });
    expect((await service.lookup('   ')).match).toBeUndefined();
    expect(provider.search).not.toHaveBeenCalled();
  });

  it('prefers fresh cached airing entries over a remote round-trip', async () => {
    const airing = [
      series({ sourceId: '1', title: 'One' }),
      series({ sourceId: '2', title: 'Two' }),
    ];
    const listAiring = vi.fn(async () => []);
    const service = new AnimeCatalogService(config(), {
      storage: storageWith(fakeCatalogRepo(airing)),
      provider: fakeProvider({ listAiring }),
    });

    expect(await service.listAiring(2)).toHaveLength(2);
    expect(listAiring).not.toHaveBeenCalled();
  });
});

describe('catalog title keys', () => {
  it('indexes exactly the keys the lookup ladder searches for', () => {
    expect(TANYA.titleKeys).toContain(
      canonicalTitleKey('Tanya the Evil'.replace('Tanya', 'Saga of Tanya')),
    );
    expect(TANYA.titleKeys).toContain('youjo senki');
  });
});
