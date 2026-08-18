import { describe, expect, it, vi } from 'vitest';
import { AmbientRetriever, renderBlock } from '../src/ambient/retriever.js';
import { AnimeAmbientProvider } from '../src/ambient/providers/animeAmbient.js';
import { parseSummary } from '../src/ambient/providers/wikipediaAmbient.js';
import { classifyMessage } from '../src/ambient/classifier.js';
import { titleKeys } from '../src/anime/titles.js';
import type { AmbientConfig } from '../src/config/index.js';
import type { AmbientFact, AmbientProvider } from '../src/ambient/types.js';
import type { AnimeCatalogService } from '../src/anime/catalogService.js';
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

function stubProvider(
  name: string,
  domains: AmbientProvider['domains'],
  facts: AmbientFact[],
  extra: Partial<AmbientProvider> = {},
): AmbientProvider {
  return {
    name,
    domains,
    enabled: true,
    recall: vi.fn(async () => facts),
    ...extra,
  } as AmbientProvider;
}

const fact = (overrides: Partial<AmbientFact> = {}): AmbientFact => ({
  domain: 'anime',
  subject: 'Frieren',
  text: 'Stato: in corso | Ultimo episodio uscito: 12',
  url: 'https://anilist.co/anime/154587',
  confidence: 0.9,
  fromCache: true,
  ...overrides,
});

describe('AmbientRetriever', () => {
  it('stays completely silent on ordinary chatter', async () => {
    const provider = stubProvider('p', ['anime'], [fact()]);
    const retriever = new AmbientRetriever(config(), [provider]);

    const result = await retriever.recall({
      message: 'ahahah raga muoio',
      chatId: -100,
      nsfwAllowed: false,
    });

    expect(result.block).toBe('');
    expect(result.facts).toEqual([]);
    expect(provider.recall).not.toHaveBeenCalled();
  });

  it('recalls facts when a domain is detected', async () => {
    const provider = stubProvider('p', ['anime'], [fact()]);
    const retriever = new AmbientRetriever(config(), [provider]);

    const result = await retriever.recall({
      message: 'ieri ho visto un episodio pazzesco di Frieren',
      chatId: -100,
      nsfwAllowed: false,
    });

    expect(result.facts).toHaveLength(1);
    expect(result.block).toContain('Frieren');
    expect(result.sources).toEqual(['https://anilist.co/anime/154587']);
  });

  it('only consults providers that cover the detected domain', async () => {
    const anime = stubProvider('anime', ['anime'], [fact()]);
    const music = stubProvider('music', ['music'], [fact({ domain: 'music' })]);
    const retriever = new AmbientRetriever(config(), [anime, music]);

    await retriever.recall({
      message: 'che episodio assurdo di questo anime',
      chatId: -100,
      nsfwAllowed: false,
    });

    expect(anime.recall).toHaveBeenCalled();
    expect(music.recall).not.toHaveBeenCalled();
  });

  it('keeps replying when one provider throws', async () => {
    const broken = stubProvider('broken', ['anime'], [], {
      recall: vi.fn(async () => {
        throw new Error('provider exploded');
      }),
    });
    const healthy = stubProvider('healthy', ['anime'], [fact()]);
    const retriever = new AmbientRetriever(config(), [broken, healthy]);

    const result = await retriever.recall({
      message: 'un episodio di Frieren',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(result.facts).toHaveLength(1);
  });

  it('caps the total number of facts', async () => {
    const many = stubProvider(
      'many',
      ['anime'],
      [
        fact({ subject: 'A', confidence: 0.9 }),
        fact({ subject: 'B', confidence: 0.8 }),
        fact({ subject: 'C', confidence: 0.7 }),
        fact({ subject: 'D', confidence: 0.6 }),
      ],
    );
    const retriever = new AmbientRetriever(config({ maxFacts: 2 }), [many]);

    const result = await retriever.recall({
      message: 'un episodio di anime',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(result.facts.map((f) => f.subject)).toEqual(['A', 'B']);
  });

  it('does nothing when disabled', async () => {
    const provider = stubProvider('p', ['anime'], [fact()]);
    const retriever = new AmbientRetriever(config({ enabled: false }), [provider]);

    const result = await retriever.recall({
      message: 'un episodio di Frieren',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(result.block).toBe('');
    expect(provider.recall).not.toHaveBeenCalled();
  });
});

describe('adult gating', () => {
  it('drops adult facts when the chat has NSFW off', async () => {
    const provider = stubProvider(
      'p',
      ['anime'],
      [fact({ subject: 'Innocente' }), fact({ subject: 'Adulto', adult: true })],
    );
    const retriever = new AmbientRetriever(config(), [provider]);

    const result = await retriever.recall({
      message: 'che hentai nuovi sono usciti',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(result.facts.map((f) => f.subject)).toEqual(['Innocente']);
  });

  it('keeps adult facts when the chat allows them', async () => {
    const provider = stubProvider('p', ['anime'], [fact({ subject: 'Adulto', adult: true })]);
    const retriever = new AmbientRetriever(config(), [provider]);

    const result = await retriever.recall({
      message: 'che hentai nuovi sono usciti',
      chatId: -100,
      nsfwAllowed: true,
    });
    expect(result.facts.map((f) => f.subject)).toEqual(['Adulto']);
  });
});

describe('network budget', () => {
  const captureBudget = (): { provider: AmbientProvider; budgets: string[] } => {
    const budgets: string[] = [];
    const provider = stubProvider('p', ['anime', 'philosophy'], [], {
      recall: vi.fn(async (request) => {
        budgets.push(request.budget);
        return [];
      }),
    });
    return { provider, budgets };
  };

  it('grants a network budget at most once per chat per cooldown', async () => {
    const { provider, budgets } = captureBudget();
    const retriever = new AmbientRetriever(config(), [provider]);
    const input = {
      message: 'e uscito il nuovo episodio di Frieren',
      chatId: -100,
      nsfwAllowed: false,
    };

    await retriever.recall(input);
    await retriever.recall(input);

    expect(budgets).toEqual(['network', 'local']);
  });

  it('never grants a network budget for a stable domain', async () => {
    const { provider, budgets } = captureBudget();
    const retriever = new AmbientRetriever(config(), [provider]);

    await retriever.recall({
      message: 'il nichilismo secondo Nietzsche',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(budgets).toEqual(['local']);
  });

  it('stays local when network access is switched off', async () => {
    const { provider, budgets } = captureBudget();
    const retriever = new AmbientRetriever(config({ allowNetwork: false }), [provider]);

    await retriever.recall({
      message: 'e uscito il nuovo episodio di Frieren',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(budgets).toEqual(['local']);
  });

  it('tracks the cooldown per chat, not globally', async () => {
    const { provider, budgets } = captureBudget();
    const retriever = new AmbientRetriever(config(), [provider]);
    const message = 'e uscito il nuovo episodio di Frieren';

    await retriever.recall({ message, chatId: -100, nsfwAllowed: false });
    await retriever.recall({ message, chatId: -200, nsfwAllowed: false });

    expect(budgets).toEqual(['network', 'network']);
  });
});

describe('renderBlock', () => {
  it('frames facts as optional background, never as an instruction to bring them up', () => {
    const block = renderBlock([fact()]);
    expect(block).toMatch(/never force the topic/i);
    expect(block).toContain('[anime] Frieren');
  });

  it('is empty with no facts', () => {
    expect(renderBlock([])).toBe('');
  });
});

describe('AnimeAmbientProvider', () => {
  const series: AnimeSeries = {
    source: 'anilist',
    sourceId: '154587',
    title: 'Frieren',
    aliases: [],
    titleKeys: titleKeys(['Frieren']),
    url: 'https://anilist.co/anime/154587',
    status: 'ongoing',
    genres: ['Adventure'],
    studios: [],
    externalIds: {},
    streamingLinks: [],
    latestEpisode: 12,
  };

  const catalog = (overrides: Partial<AnimeCatalogService> = {}): AnimeCatalogService =>
    ({
      enabled: true,
      lookupLocal: vi.fn(async () => ({ candidates: [], fromCache: true })),
      lookup: vi.fn(async () => ({ candidates: [], fromCache: false })),
      ...overrides,
    }) as unknown as AnimeCatalogService;

  const request = (budget: 'local' | 'network', message: string) => ({
    message,
    classification: classifyMessage(message),
    budget,
    chatId: -100,
    nsfwAllowed: true,
    limit: 2,
  });

  it('never leaves the database on a local budget', async () => {
    const service = catalog({
      lookupLocal: vi.fn(async () => ({
        match: { series, score: 1, matchedKey: 'frieren' },
        candidates: [],
        fromCache: true,
      })),
    });
    const provider = new AnimeAmbientProvider(service);

    const facts = await provider.recall(request('local', 'ieri ho visto un episodio di Frieren'));

    expect(facts).toHaveLength(1);
    expect(facts[0]?.subject).toBe('Frieren');
    expect(facts[0]?.entityId).toBe('anilist:154587');
    expect(service.lookup).not.toHaveBeenCalled();
  });

  it('uses the full lookup only when granted a network budget', async () => {
    const service = catalog({
      lookup: vi.fn(async () => ({
        match: { series, score: 1, matchedKey: 'frieren' },
        candidates: [],
        fromCache: false,
      })),
    });
    const provider = new AnimeAmbientProvider(service);

    await provider.recall(request('network', 'e uscito il nuovo episodio di Frieren'));
    expect(service.lookup).toHaveBeenCalled();
  });

  it('marks an adult title so the retriever can gate it', async () => {
    const service = catalog({
      lookupLocal: vi.fn(async () => ({
        match: {
          series: { ...series, genres: ['Hentai'] },
          score: 1,
          matchedKey: 'frieren',
        },
        candidates: [],
        fromCache: true,
      })),
    });
    const facts = await new AnimeAmbientProvider(service).recall(
      request('local', 'quel doujin di Frieren'),
    );
    expect(facts[0]?.adult).toBe(true);
  });

  it('returns nothing for an unknown series instead of guessing', async () => {
    const facts = await new AnimeAmbientProvider(catalog()).recall(
      request('local', 'un episodio di Qualcosa Che Non Esiste'),
    );
    expect(facts).toEqual([]);
  });
});

describe('wikipedia summary parsing', () => {
  const payload = {
    type: 'standard',
    title: 'Nichilismo',
    extract:
      'Il nichilismo è una posizione filosofica secondo cui la vita non ha un significato oggettivo intrinseco.',
    content_urls: { desktop: { page: 'https://it.wikipedia.org/wiki/Nichilismo' } },
  };

  it('extracts title, summary and canonical URL', () => {
    expect(parseSummary(payload)).toEqual({
      title: 'Nichilismo',
      extract: payload.extract,
      url: 'https://it.wikipedia.org/wiki/Nichilismo',
    });
  });

  it('refuses a disambiguation page rather than quoting one meaning', () => {
    expect(parseSummary({ ...payload, type: 'disambiguation' })).toBeNull();
  });

  it('refuses a stub extract that would assert nothing useful', () => {
    expect(parseSummary({ ...payload, extract: 'Breve.' })).toBeNull();
  });

  it('refuses a payload with no https canonical URL', () => {
    expect(parseSummary({ ...payload, content_urls: {} })).toBeNull();
    expect(
      parseSummary({ ...payload, content_urls: { desktop: { page: 'http://insecure' } } }),
    ).toBeNull();
  });

  it('refuses structurally unexpected payloads', () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary('nope')).toBeNull();
    expect(parseSummary({})).toBeNull();
  });
});
