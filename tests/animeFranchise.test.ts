import { describe, expect, it, vi } from 'vitest';
import { AnimeCatalogService } from '../src/anime/catalogService.js';
import { AnimeKnowledgeService, asksAboutUpcoming } from '../src/anime/knowledgeService.js';
import { titleKeys } from '../src/anime/titles.js';
import type { AnimeCatalogProvider, AnimeSeries } from '../src/anime/types.js';
import type { AnimeFollowService } from '../src/anime/followService.js';
import type { AnimeConfig } from '../src/config/index.js';
import type { Storage } from '../src/storage/index.js';

const config: AnimeConfig = {
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
};

function series(
  sourceId: string,
  title: string,
  status: AnimeSeries['status'],
  extra: Partial<AnimeSeries> = {},
): AnimeSeries {
  return {
    source: 'anilist',
    sourceId,
    title,
    aliases: [],
    titleKeys: titleKeys([title]),
    url: `https://anilist.co/anime/${sourceId}`,
    status,
    genres: [],
    studios: [],
    externalIds: {},
    streamingLinks: [],
    ...extra,
  };
}

/**
 * The real Tanya franchise as AniList returns it: four entries whose titles are near-identical,
 * with only one still airing. Scores measured live were 0.941 / 0.931 / 0.921 / 0.864 - a gap far
 * too small for any string metric to call, which is the whole point of this fixture.
 */
const FRANCHISE: AnimeSeries[] = [
  series('21613', 'Saga of Tanya the Evil', 'finished', { latestEpisode: 12, episodeCount: 12 }),
  series('135865', 'Saga of Tanya the Evil Season 2', 'ongoing', {
    latestEpisode: 6,
    episodeCount: 12,
    nextEpisode: { episode: 7, airingAt: new Date('2026-08-19T12:30:00Z') },
    airingWeekday: 3,
  }),
  series('101633', 'Saga of Tanya the Evil - the Movie -', 'finished', { latestEpisode: 1 }),
  series('106562', 'Saga of Tanya the Evil: Operation Desert Pasta', 'finished', {
    latestEpisode: 1,
  }),
];

const emptyStorage = {
  animeCatalog: {
    get: async () => null,
    findByTitleKey: async () => [],
    findFuzzyCandidates: async () => [],
    upsertMany: async () => undefined,
    listAiring: async () => [],
  },
} as unknown as Storage;

const provider = (results: AnimeSeries[]): AnimeCatalogProvider =>
  ({
    source: 'anilist',
    enabled: true,
    search: vi.fn(async () => results),
    getById: async () => null,
    listAiring: async () => [],
    getManyByIds: async () => [],
  }) as AnimeCatalogProvider;

describe('asksAboutUpcoming', () => {
  it.each([
    'quando esce il prossimo episodio di Tanya the Evil ?',
    'è uscito l ultimo episodio?',
    'quando escono i nuovi episodi',
    'when does the next episode air',
  ])('recognises %j as a question about the release timeline', (question) => {
    expect(asksAboutUpcoming(question)).toBe(true);
  });

  it.each(['di cosa parla Tanya the Evil', 'com era il finale', 'chi è il regista'])(
    'does not read %j as a timeline question',
    (question) => {
      expect(asksAboutUpcoming(question)).toBe(false);
    },
  );
});

describe('a franchise question resolves to the entry that is actually airing', () => {
  it('picks Season 2 when asked what comes next, despite S1 scoring higher on the title', async () => {
    const catalog = new AnimeCatalogService(config, {
      storage: emptyStorage,
      provider: provider(FRANCHISE),
    });

    const result = await catalog.lookup('Tanya the Evil', undefined, { preferOngoing: true });

    expect(result.match?.series.sourceId).toBe('135865');
    expect(result.match?.series.nextEpisode?.episode).toBe(7);
  });

  it('stays a shortlist when the question is not about the timeline', async () => {
    const catalog = new AnimeCatalogService(config, {
      storage: emptyStorage,
      provider: provider(FRANCHISE),
    });

    const result = await catalog.lookup('Tanya the Evil');

    // Four near-identical titles genuinely are ambiguous when nothing disambiguates them.
    expect(result.match).toBeUndefined();
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it('does not fire the rule when several entries are airing at once', async () => {
    // Identical titles, so nothing else can break the tie either - which is exactly the state
    // where guessing would be worse than showing both.
    const twoAiring = [
      series('1', 'Show', 'ongoing', { latestEpisode: 3 }),
      series('2', 'Show', 'ongoing', { latestEpisode: 1 }),
    ];
    const catalog = new AnimeCatalogService(config, {
      storage: emptyStorage,
      provider: provider(twoAiring),
    });

    const result = await catalog.lookup('Show', undefined, { preferOngoing: true });
    // The rule is "exactly one is airing"; with two, guessing would be worse than asking.
    expect(result.match).toBeUndefined();
  });
});

describe('a partially cached franchise does not short-circuit the right answer', () => {
  /** Cache holding a subset, which is the state a first lookup leaves behind. */
  function partialStorage(seed: AnimeSeries[]): Storage {
    const docs = new Map(
      seed.map((e) => [
        `${e.source}:${e.sourceId}`,
        { ...e, crawledAt: new Date(), revision: 1, createdAt: new Date(), updatedAt: new Date() },
      ]),
    );
    return {
      animeCatalog: {
        get: async (so: string, id: string) => docs.get(`${so}:${id}`) ?? null,
        findByTitleKey: async (k: string) =>
          [...docs.values()].filter((d) => d.titleKeys.includes(k)),
        findFuzzyCandidates: async (tokens: string[]) => {
          const usable = tokens.filter((t) => t.length >= 3);
          return [...docs.values()].filter((d) =>
            d.titleKeys.some((k: string) => usable.some((t) => k.includes(t))),
          );
        },
        upsertMany: async (list: AnimeSeries[]) => {
          for (const e of list) {
            docs.set(`${e.source}:${e.sourceId}`, {
              ...e,
              crawledAt: new Date(),
              revision: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        },
        listAiring: async () => [],
      },
    } as unknown as Storage;
  }

  it('goes remote when the only cached entry is concluded and the question is about what is next', async () => {
    // Exactly the production state: one entry cached, so it looks unambiguous and wins outright.
    const onlyS1 = FRANCHISE.filter((s) => s.sourceId === '21613');
    const catalog = new AnimeCatalogService(config, {
      storage: partialStorage(onlyS1),
      provider: provider(FRANCHISE),
    });

    const result = await catalog.lookup('Tanya the Evil', undefined, { preferOngoing: true });

    expect(result.match?.series.sourceId).toBe('135865');
    expect(result.match?.series.nextEpisode?.episode).toBe(7);
  });

  it('keeps trusting a cached concluded entry when the question is not about the timeline', async () => {
    const onlyS1 = FRANCHISE.filter((s) => s.sourceId === '21613');
    const search = vi.fn(async () => FRANCHISE);
    const catalog = new AnimeCatalogService(config, {
      storage: partialStorage(onlyS1),
      provider: { ...provider(FRANCHISE), search } as AnimeCatalogProvider,
    });

    const result = await catalog.lookup('Tanya the Evil');

    expect(result.match?.series.sourceId).toBe('21613');
    expect(search).not.toHaveBeenCalled();
  });

  it('falls back to the concluded local match when the source is unreachable', async () => {
    const onlyS1 = FRANCHISE.filter((s) => s.sourceId === '21613');
    const catalog = new AnimeCatalogService(config, {
      storage: partialStorage(onlyS1),
      provider: provider([]),
    });

    // Setting the local match aside must not turn into "never heard of it".
    const result = await catalog.lookup('Tanya the Evil', undefined, { preferOngoing: true });
    expect(result.match?.series.sourceId).toBe('21613');
  });
});

describe('an ambiguous answer is information, not a tool failure', () => {
  const knowledge = (results: AnimeSeries[]) =>
    new AnimeKnowledgeService(
      config,
      new AnimeCatalogService(config, { storage: emptyStorage, provider: provider(results) }),
      {} as AnimeFollowService,
    );

  it('answers the exact production question with the airing entry', async () => {
    const answer = await knowledge(FRANCHISE).handle({
      intent: 'lookup',
      title: 'Tanya the Evil',
      question: 'quando esce il prossimo episodio di Tanya the Evil ?',
      chatId: -100,
      userHandle: '@u',
    });

    expect(answer.resolved).toBe(true);
    expect(answer.summary).toContain('Season 2');
    expect(answer.summary).toContain('Ultimo episodio uscito: 6');
    expect(answer.summary).toContain('Prossimo episodio: 7');
    expect(answer.sources).toEqual(['https://anilist.co/anime/135865']);
  });

  it('reports a shortlist as resolved and carries its sources', async () => {
    const answer = await knowledge(FRANCHISE).handle({
      intent: 'lookup',
      title: 'Tanya the Evil',
      question: 'parlami di Tanya the Evil',
      chatId: -100,
      userHandle: '@u',
    });

    // Reporting this as unresolved made the agent discard real data and print its own
    // verification failure to the user instead.
    expect(answer.resolved).toBe(true);
    expect(answer.candidates.length).toBeGreaterThan(1);
    expect(answer.sources.length).toBeGreaterThan(1);
    expect(answer.summary).not.toMatch(/ambiguo/i);
  });

  it('still reports a genuinely unknown title as unresolved', async () => {
    const answer = await knowledge([]).handle({
      intent: 'lookup',
      title: 'Serie Che Non Esiste Affatto',
      question: 'quando esce il prossimo episodio',
      chatId: -100,
      userHandle: '@u',
    });

    expect(answer.resolved).toBe(false);
    expect(answer.sources).toEqual([]);
  });
});
