import { describe, expect, it, vi } from 'vitest';
import { AmbientRetriever } from '../src/ambient/retriever.js';
import { WikipediaAmbientProvider } from '../src/ambient/providers/wikipediaAmbient.js';
import { runLearnNotifyJob } from '../src/jobs/learnNotifyJob.js';
import type { AmbientConfig } from '../src/config/index.js';
import type { AmbientBudget, AmbientProvider } from '../src/ambient/types.js';
import type { Storage } from '../src/storage/index.js';
import type { AnimeSeries } from '../src/anime/types.js';

const config = (overrides: Partial<AmbientConfig> = {}): AmbientConfig => ({
  enabled: true,
  minDomainScore: 1,
  maxDomains: 2,
  maxFacts: 3,
  maxFactsPerProvider: 2,
  allowNetwork: true,
  networkCooldownSeconds: 90,
  autoengageBonus: 0.1,
  deadlineMs: 2_500,
  wikipedia: {
    enabled: true,
    language: 'it',
    timeoutMs: 5_000,
    maxResponseBytes: 262_144,
    cacheTtlHours: 720,
  },
  ...overrides,
});

/** Captures the budget the retriever actually granted, per domain the provider claims. */
function budgetProbe(domains: AmbientProvider['domains']): {
  provider: AmbientProvider;
  budgets: AmbientBudget[];
} {
  const budgets: AmbientBudget[] = [];
  return {
    budgets,
    provider: {
      name: 'probe',
      domains,
      enabled: true,
      recall: async (request) => {
        budgets.push(request.budget);
        return [];
      },
    },
  };
}

describe('stable domains are reachable at all', () => {
  it.each([
    ['il nichilismo secondo Nietzsche', 'philosophy'],
    ['la dissonanza cognitiva mi distrugge', 'psychology'],
    ['la termodinamica e l entropia', 'science'],
    ['il medioevo non era così buio', 'history'],
  ])('grants a network budget for %j so its cache can seed', async (message) => {
    const { provider, budgets } = budgetProbe(['philosophy', 'psychology', 'science', 'history']);
    const retriever = new AmbientRetriever(config(), [provider]);

    await retriever.recall({ message, chatId: -100, nsfwAllowed: false });

    // Gating this on `live` volatility made these domains permanently unreachable: nothing else
    // writes ambient_cache, so a local-only budget could never seed it.
    expect(budgets).toEqual(['network']);
  });

  it('still allows a live domain a network budget', async () => {
    const { provider, budgets } = budgetProbe(['anime']);
    await new AmbientRetriever(config(), [provider]).recall({
      message: 'e uscito il nuovo episodio di Frieren',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(budgets).toEqual(['network']);
  });

  it('still spends at most one network budget per chat per cooldown', async () => {
    const { provider, budgets } = budgetProbe(['philosophy']);
    const retriever = new AmbientRetriever(config(), [provider]);
    const input = { message: 'il nichilismo di Nietzsche', chatId: -100, nsfwAllowed: false };

    await retriever.recall(input);
    await retriever.recall(input);

    expect(budgets).toEqual(['network', 'local']);
  });

  it('still honours the network kill switch', async () => {
    const { provider, budgets } = budgetProbe(['philosophy']);
    await new AmbientRetriever(config({ allowNetwork: false }), [provider]).recall({
      message: 'il nichilismo di Nietzsche',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(budgets).toEqual(['local']);
  });

  it('lets the wikipedia provider seed its cache on that budget', async () => {
    const puts: unknown[] = [];
    const storage = {
      ambientCache: {
        get: async () => null,
        put: async (...args: unknown[]) => {
          puts.push(args);
        },
      },
    } as unknown as Storage;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'standard',
              title: 'Nichilismo',
              extract:
                'Il nichilismo è una posizione filosofica secondo cui la vita non ha significato oggettivo.',
              content_urls: { desktop: { page: 'https://it.wikipedia.org/wiki/Nichilismo' } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const provider = new WikipediaAmbientProvider(storage, config().wikipedia);
    const retriever = new AmbientRetriever(config(), [provider], undefined);
    const result = await retriever.recall({
      message: 'parlami di Nichilismo',
      chatId: -100,
      nsfwAllowed: false,
    });

    expect(result.facts.map((f) => f.subject)).toContain('Nichilismo');
    expect(puts.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

describe('overlapping subjects do not produce a second, wrong fact', () => {
  it('skips a bare word once the specific phrase it belongs to has resolved', async () => {
    const looked: string[] = [];
    const storage = {
      ambientCache: {
        get: async () => null,
        put: async () => undefined,
      },
    } as unknown as Storage;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const subject = decodeURIComponent(String(url).split('/').pop() ?? '');
        looked.push(subject);
        return new Response(
          JSON.stringify({
            type: 'standard',
            title: subject,
            extract: `Una voce sufficientemente lunga a proposito di ${subject} per superare la soglia minima.`,
            content_urls: { desktop: { page: `https://it.wikipedia.org/wiki/${subject}` } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const provider = new WikipediaAmbientProvider(storage, config().wikipedia);
    const result = await new AmbientRetriever(config(), [provider]).recall({
      message: 'parlami di Dissonanza cognitiva',
      chatId: -100,
      nsfwAllowed: false,
    });

    // "Dissonanza" alone resolves to musical dissonance; it must not ride along as a second fact.
    expect(result.facts.map((f) => f.subject)).toEqual(['Dissonanza cognitiva']);
    expect(looked).not.toContain('Dissonanza');
    vi.unstubAllGlobals();
  });

  it('falls through to a shorter candidate when the longest one does not resolve', async () => {
    const storage = {
      ambientCache: { get: async () => null, put: async () => undefined },
    } as unknown as Storage;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const subject = decodeURIComponent(String(url).split('/').pop() ?? '');
        // The longest extracted candidate is junk and 404s, exactly like the live source.
        if (subject.includes(' e ') || subject.split(' ').length > 2) {
          return new Response('', { status: 404 });
        }
        return new Response(
          JSON.stringify({
            type: 'standard',
            title: subject,
            extract: `Una voce sufficientemente lunga a proposito di ${subject} per superare la soglia.`,
            content_urls: { desktop: { page: `https://it.wikipedia.org/wiki/${subject}` } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const provider = new WikipediaAmbientProvider(storage, config().wikipedia);
    const result = await new AmbientRetriever(config(), [provider]).recall({
      message: 'il nichilismo di Nietzsche è frainteso',
      chatId: -100,
      nsfwAllowed: false,
    });

    expect(result.facts.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

describe('learn notifier actually reaches its jobs', () => {
  it('asks for a job count, not a 50 millisecond window', async () => {
    // The service signature is (options) now; passing 50 positionally used to bind `withinMs`,
    // so the notifier only saw jobs updated in the last 50ms and never fired at all.
    let received: unknown;
    const storage = {
      jobNotifications: { claim: async () => true, release: async () => undefined },
    } as unknown as Storage;

    await runLearnNotifyJob(
      {
        enabled: true,
        listTerminal: async (options: unknown) => {
          received = options;
          return [];
        },
      } as never,
      storage,
      async () => true,
    );

    expect(received).toEqual({ limit: 50 });
  });

  it('sees a job that finished minutes ago', async () => {
    const storage = {
      jobNotifications: { claim: async () => true, release: async () => undefined },
    } as unknown as Storage;
    const notify = vi.fn(async () => true);

    const result = await runLearnNotifyJob(
      {
        enabled: true,
        listTerminal: async () => [
          {
            id: '11111111-2222-3333-4444-555555555555',
            state: 'ready',
            privateChatId: 12345,
            updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          },
        ],
      } as never,
      storage,
      notify,
    );
    expect(result.notified).toBe(1);
  });
});

describe('a fact the source stopped publishing is cleared, not kept', () => {
  /** Mirrors the repo's write semantics closely enough to observe $set vs $unset. */
  function fakeCollection() {
    const stored: Record<string, unknown> = {};
    return {
      stored,
      apply(update: Record<string, Record<string, unknown>>) {
        for (const [key, value] of Object.entries(update['$set'] ?? {})) stored[key] = value;
        for (const key of Object.keys(update['$unset'] ?? {})) delete stored[key];
      },
    };
  }

  it('drops nextEpisode when a series finishes so no past date is asserted', async () => {
    const { AnimeCatalogRepo } = await import('../src/storage/repositories/animeCatalog.js');
    const col = fakeCollection();
    const captured: Record<string, Record<string, unknown>>[] = [];
    const repo = new AnimeCatalogRepo({
      collection: () => ({
        updateOne: async (_filter: unknown, update: Record<string, Record<string, unknown>>) => {
          captured.push(update);
          col.apply(update);
        },
        createIndex: async () => undefined,
      }),
    } as never);

    const airing: AnimeSeries = {
      source: 'anilist',
      sourceId: '1',
      title: 'Show',
      aliases: [],
      titleKeys: ['show'],
      url: 'https://anilist.co/anime/1',
      status: 'ongoing',
      genres: [],
      studios: [],
      externalIds: {},
      latestEpisode: 27,
      nextEpisode: { episode: 28, airingAt: new Date('2024-01-01T00:00:00Z') },
      airingWeekday: 4,
    };
    col.stored['streamingLinks'] = [
      { site: 'Legacy gateway', url: 'https://gateway.invalid/watch/1' },
    ];
    await repo.upsert({
      ...airing,
      // Simulate an old caller crossing the deploy boundary with the removed field still present.
      streamingLinks: [{ site: 'Legacy gateway', url: 'https://gateway.invalid/watch/1' }],
    } as AnimeSeries);
    expect(col.stored['nextEpisode']).toBeDefined();
    expect(captured[0]?.['$set']).not.toHaveProperty('streamingLinks');
    expect(captured[0]?.['$unset']).toMatchObject({ streamingLinks: '' });
    expect(col.stored['streamingLinks']).toBeUndefined();

    // The same series once it has finished: AniList stops publishing nextAiringEpisode.
    const finished: AnimeSeries = {
      ...airing,
      status: 'finished',
      latestEpisode: 28,
      nextEpisode: undefined,
      airingWeekday: undefined,
    };
    await repo.upsert(finished);

    expect(captured[1]?.['$unset']).toMatchObject({ nextEpisode: '', airingWeekday: '' });
    expect(col.stored['nextEpisode']).toBeUndefined();
    expect(col.stored['airingWeekday']).toBeUndefined();
    expect(col.stored['latestEpisode']).toBe(28);
  });
});
