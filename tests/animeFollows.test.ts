import { describe, expect, it, vi } from 'vitest';
import { AnimeFollowService } from '../src/anime/followService.js';
import { AnimeKnowledgeService, parseAnimeIntent } from '../src/anime/knowledgeService.js';
import { runAnimeReleaseJob } from '../src/jobs/animeReleaseJob.js';
import { createAnimeReleaseNotifier } from '../src/jobs/animeReleaseNotifier.js';
import { titleKeys } from '../src/anime/titles.js';
import { NEVER_NOTIFIED, type AnimeFollowDoc } from '../src/storage/repositories/animeFollows.js';
import type { AnimeCatalogService } from '../src/anime/catalogService.js';
import type { AnimeSeries } from '../src/anime/types.js';
import type { AnimeConfig } from '../src/config/index.js';
import type { Storage } from '../src/storage/index.js';

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
  follows: { enabled: true, pollMinutes: 30, maxPerChat: 3, batchSize: 20 },
  ...overrides,
});

function series(sourceId: string, title: string, latestEpisode?: number): AnimeSeries {
  return {
    source: 'anilist',
    sourceId,
    title,
    aliases: [],
    titleKeys: titleKeys([title]),
    url: `https://anilist.co/anime/${sourceId}`,
    status: 'ongoing',
    genres: [],
    studios: [],
    externalIds: {},
    streamingLinks: [],
    ...(latestEpisode !== undefined ? { latestEpisode } : {}),
  };
}

/**
 * In-memory AnimeFollowsRepo with the same concurrency contract: `claimNotifications` only ever
 * hands back a follow whose watermark was strictly below the target, and it moves the watermark
 * in the same step.
 */
function fakeFollowsRepo(seed: AnimeFollowDoc[] = []) {
  let docs = [...seed];
  const key = (doc: { chatId: number; source: string; sourceId: string }): string =>
    `${doc.chatId}:${doc.source}:${doc.sourceId}`;

  return {
    docs: () => docs,
    async countForChat(chatId: number) {
      return docs.filter((doc) => doc.chatId === chatId).length;
    },
    async listForChat(chatId: number) {
      return docs.filter((doc) => doc.chatId === chatId);
    },
    async get(chatId: number, source: string, sourceId: string) {
      return docs.find((doc) => key(doc) === `${chatId}:${source}:${sourceId}`) ?? null;
    },
    async follow(
      input: Omit<AnimeFollowDoc, 'createdAt' | 'lastNotifiedEpisode'> & { seedEpisode?: number },
    ) {
      const existing = docs.find((doc) => key(doc) === key(input));
      if (existing) {
        existing.title = input.title;
        return { created: false };
      }
      docs.push({
        chatId: input.chatId,
        threadId: input.threadId,
        source: input.source,
        sourceId: input.sourceId,
        title: input.title,
        createdByHandle: input.createdByHandle,
        createdAt: new Date(),
        lastNotifiedEpisode: input.seedEpisode ?? NEVER_NOTIFIED,
      });
      return { created: true };
    },
    async unfollow(chatId: number, source: string, sourceId: string) {
      const before = docs.length;
      docs = docs.filter((doc) => key(doc) !== `${chatId}:${source}:${sourceId}`);
      return docs.length < before;
    },
    async listSeriesToPoll(limit: number) {
      const seen = new Set<string>();
      const out: Array<{ source: 'anilist'; sourceId: string }> = [];
      for (const doc of docs) {
        const id = `${doc.source}:${doc.sourceId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ source: doc.source, sourceId: doc.sourceId });
        if (out.length >= limit) break;
      }
      return out;
    },
    async markChecked(source: string, sourceId: string, now = new Date()) {
      for (const doc of docs) {
        if (doc.source === source && doc.sourceId === sourceId) doc.lastCheckedAt = now;
      }
    },
    async claimNotifications(source: string, sourceId: string, episode: number) {
      const claimed: AnimeFollowDoc[] = [];
      for (const doc of docs) {
        if (doc.source !== source || doc.sourceId !== sourceId) continue;
        if (doc.lastNotifiedEpisode >= episode) continue;
        claimed.push({ ...doc });
        doc.lastNotifiedEpisode = episode;
      }
      return claimed;
    },
    async releaseClaim(chatId: number, source: string, sourceId: string, previous: number) {
      const doc = docs.find((entry) => key(entry) === `${chatId}:${source}:${sourceId}`);
      if (doc) doc.lastNotifiedEpisode = previous;
    },
  };
}

const storageWith = (follows: ReturnType<typeof fakeFollowsRepo>): Storage =>
  ({ animeFollows: follows }) as unknown as Storage;

function fakeCatalog(overrides: Partial<AnimeCatalogService> = {}): AnimeCatalogService {
  return {
    enabled: true,
    lookup: vi.fn(async () => ({ candidates: [], fromCache: true })),
    getPersisted: vi.fn(async () => null),
    refresh: vi.fn(async () => null),
    listAiring: vi.fn(async () => []),
    ...overrides,
  } as unknown as AnimeCatalogService;
}

const FRIEREN = series('154587', 'Frieren', 8);

describe('AnimeFollowService', () => {
  const resolving = (match: AnimeSeries): AnimeCatalogService =>
    fakeCatalog({
      lookup: vi.fn(async () => ({
        match: { series: match, score: 1, matchedKey: 'x' },
        candidates: [],
        fromCache: true,
      })),
    });

  it('creates a follow seeded at what has already aired', async () => {
    const follows = fakeFollowsRepo();
    const service = new AnimeFollowService(config(), storageWith(follows), resolving(FRIEREN));

    const outcome = await service.follow('frieren', { chatId: -100, userHandle: '@u' });
    expect(outcome).toMatchObject({ ok: true, created: true });
    // Seeding at episode 8 is what stops the very next poll announcing episodes 1-8 as "new".
    expect(follows.docs()[0]?.lastNotifiedEpisode).toBe(8);
  });

  it('is idempotent: following twice never creates a duplicate', async () => {
    const follows = fakeFollowsRepo();
    const service = new AnimeFollowService(config(), storageWith(follows), resolving(FRIEREN));

    await service.follow('frieren', { chatId: -100, userHandle: '@u' });
    const second = await service.follow('frieren', { chatId: -100, userHandle: '@u' });

    expect(second).toMatchObject({ ok: true, created: false });
    expect(follows.docs()).toHaveLength(1);
  });

  it('preserves the notification watermark when re-followed', async () => {
    const follows = fakeFollowsRepo();
    const service = new AnimeFollowService(config(), storageWith(follows), resolving(FRIEREN));
    await service.follow('frieren', { chatId: -100, userHandle: '@u' });
    await follows.claimNotifications('anilist', '154587', 12);

    await service.follow('frieren', { chatId: -100, userHandle: '@u' });
    expect(follows.docs()[0]?.lastNotifiedEpisode).toBe(12);
  });

  it('records the forum thread so notifications land where the follow was created', async () => {
    const follows = fakeFollowsRepo();
    const service = new AnimeFollowService(config(), storageWith(follows), resolving(FRIEREN));
    await service.follow('frieren', { chatId: -100, threadId: 42, userHandle: '@u' });
    expect(follows.docs()[0]?.threadId).toBe(42);
  });

  it('enforces the per-chat follow limit', async () => {
    const follows = fakeFollowsRepo([
      {
        chatId: -100,
        source: 'anilist',
        sourceId: 'a',
        title: 'A',
        createdByHandle: '@u',
        createdAt: new Date(),
        lastNotifiedEpisode: 1,
      },
      {
        chatId: -100,
        source: 'anilist',
        sourceId: 'b',
        title: 'B',
        createdByHandle: '@u',
        createdAt: new Date(),
        lastNotifiedEpisode: 1,
      },
      {
        chatId: -100,
        source: 'anilist',
        sourceId: 'c',
        title: 'C',
        createdByHandle: '@u',
        createdAt: new Date(),
        lastNotifiedEpisode: 1,
      },
    ]);
    const service = new AnimeFollowService(config(), storageWith(follows), resolving(FRIEREN));

    expect(await service.follow('frieren', { chatId: -100, userHandle: '@u' })).toMatchObject({
      ok: false,
      reason: 'limit_reached',
    });
  });

  it('refuses to follow an unresolvable title', async () => {
    const service = new AnimeFollowService(config(), storageWith(fakeFollowsRepo()), fakeCatalog());
    expect(await service.follow('boh', { chatId: -100, userHandle: '@u' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it("unfollows by matching the chat's own follows without a remote lookup", async () => {
    const follows = fakeFollowsRepo([
      {
        chatId: -100,
        source: 'anilist',
        sourceId: '154587',
        title: 'Frieren',
        createdByHandle: '@u',
        createdAt: new Date(),
        lastNotifiedEpisode: 8,
      },
    ]);
    const catalog = fakeCatalog({ getPersisted: vi.fn(async () => FRIEREN) });
    const service = new AnimeFollowService(config(), storageWith(follows), catalog);

    expect(await service.unfollow('frieren', -100)).toMatchObject({ ok: true });
    expect(follows.docs()).toHaveLength(0);
    expect(catalog.lookup).not.toHaveBeenCalled();
  });

  it('reports a series the chat was not following', async () => {
    const service = new AnimeFollowService(
      config(),
      storageWith(fakeFollowsRepo()),
      resolving(FRIEREN),
    );
    expect(await service.unfollow('frieren', -100)).toMatchObject({
      ok: false,
      reason: 'not_following',
    });
  });

  it('does nothing when follows are disabled', async () => {
    const follows = fakeFollowsRepo();
    const service = new AnimeFollowService(
      config({ follows: { enabled: false, pollMinutes: 30, maxPerChat: 3, batchSize: 20 } }),
      storageWith(follows),
      resolving(FRIEREN),
    );
    expect(await service.follow('frieren', { chatId: -100, userHandle: '@u' })).toMatchObject({
      ok: false,
      reason: 'disabled',
    });
    expect(follows.docs()).toHaveLength(0);
  });
});

describe('runAnimeReleaseJob', () => {
  const followDoc = (chatId: number, lastNotifiedEpisode: number): AnimeFollowDoc => ({
    chatId,
    source: 'anilist',
    sourceId: '154587',
    title: 'Frieren',
    createdByHandle: '@u',
    createdAt: new Date(),
    lastNotifiedEpisode,
  });

  it('notifies every subscribed chat exactly once for a new episode', async () => {
    const follows = fakeFollowsRepo([followDoc(-100, 8), followDoc(-200, 8)]);
    const catalog = fakeCatalog({ refresh: vi.fn(async () => series('154587', 'Frieren', 9)) });
    const notify = vi.fn(async () => true);

    const result = await runAnimeReleaseJob(config(), storageWith(follows), catalog, notify);

    expect(result).toMatchObject({ polled: 1, newEpisodes: 1, notified: 2 });
    expect(notify.mock.calls.map(([n]) => n.chatId).sort((a, b) => a - b)).toEqual([-200, -100]);
  });

  it('does not re-announce the same episode on the next tick', async () => {
    const follows = fakeFollowsRepo([followDoc(-100, 8)]);
    const catalog = fakeCatalog({ refresh: vi.fn(async () => series('154587', 'Frieren', 9)) });
    const notify = vi.fn(async () => true);

    await runAnimeReleaseJob(config(), storageWith(follows), catalog, notify);
    const second = await runAnimeReleaseJob(config(), storageWith(follows), catalog, notify);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(second.notified).toBe(0);
  });

  it('keeps the claimed watermark when optional requester lookup fails after factual delivery', async () => {
    const follows = fakeFollowsRepo([followDoc(-100, 8)]);
    const releaseClaim = vi.spyOn(follows, 'releaseClaim');
    const catalog = fakeCatalog({ refresh: vi.fn(async () => series('154587', 'Frieren', 9)) });
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 901 });
    const getByHandle = vi.fn().mockRejectedValue(new Error('users lookup unavailable'));
    const prepareNaturalEpisodeOffer = vi.fn();
    const notifier = createAnimeReleaseNotifier({
      api: {
        sendMessage,
        deleteMessage: vi.fn(),
      } as never,
      users: { getByHandle } as never,
      animeArchive: {
        enabled: true,
        prepareNaturalEpisodeOffer,
        invalidateOffer: vi.fn(),
        replaceConfirmationMessage: vi.fn(),
      } as never,
      log: { warn: vi.fn(), debug: vi.fn() } as never,
    });
    const storage = storageWith(follows);

    const first = await runAnimeReleaseJob(config(), storage, catalog, notifier);
    const second = await runAnimeReleaseJob(config(), storage, catalog, notifier);

    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(getByHandle).toHaveBeenCalledOnce();
    expect(prepareNaturalEpisodeOffer).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(follows.docs()[0]?.lastNotifiedEpisode).toBe(9);
  });

  it('survives a scheduler restart without duplicating a notification', async () => {
    // A restart is exactly this: brand-new job invocation, same persisted watermark.
    const follows = fakeFollowsRepo([followDoc(-100, 8)]);
    const catalog = fakeCatalog({ refresh: vi.fn(async () => series('154587', 'Frieren', 9)) });
    const notify = vi.fn(async () => true);

    await runAnimeReleaseJob(config(), storageWith(follows), catalog, notify);
    const restarted = fakeFollowsRepo(follows.docs());
    await runAnimeReleaseJob(config(), storageWith(restarted), catalog, notify);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when delivery fails so the next tick retries', async () => {
    const follows = fakeFollowsRepo([followDoc(-100, 8)]);
    const catalog = fakeCatalog({ refresh: vi.fn(async () => series('154587', 'Frieren', 9)) });

    const failing = vi.fn(async () => false);
    await runAnimeReleaseJob(config(), storageWith(follows), catalog, failing);
    expect(follows.docs()[0]?.lastNotifiedEpisode).toBe(8);

    const succeeding = vi.fn(async () => true);
    const retry = await runAnimeReleaseJob(config(), storageWith(follows), catalog, succeeding);
    expect(retry.notified).toBe(1);
  });

  it('releases the claim when the notifier throws', async () => {
    const follows = fakeFollowsRepo([followDoc(-100, 8)]);
    const catalog = fakeCatalog({ refresh: vi.fn(async () => series('154587', 'Frieren', 9)) });

    await runAnimeReleaseJob(config(), storageWith(follows), catalog, async () => {
      throw new Error('telegram 429');
    });
    expect(follows.docs()[0]?.lastNotifiedEpisode).toBe(8);
  });

  it('marks a series checked even when the refresh fails, so it cannot starve the batch', async () => {
    const follows = fakeFollowsRepo([followDoc(-100, 8)]);
    const catalog = fakeCatalog({
      refresh: vi.fn(async () => {
        throw new Error('anilist down');
      }),
    });
    const notify = vi.fn(async () => true);

    const result = await runAnimeReleaseJob(config(), storageWith(follows), catalog, notify);
    expect(result).toMatchObject({ polled: 1, newEpisodes: 0, notified: 0 });
    expect(follows.docs()[0]?.lastCheckedAt).toBeInstanceOf(Date);
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores a series whose latest episode is unknown', async () => {
    const follows = fakeFollowsRepo([followDoc(-100, 8)]);
    const catalog = fakeCatalog({ refresh: vi.fn(async () => series('154587', 'Frieren')) });
    const notify = vi.fn(async () => true);

    await runAnimeReleaseJob(config(), storageWith(follows), catalog, notify);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does nothing when follows are disabled', async () => {
    const catalog = fakeCatalog({ refresh: vi.fn() });
    const result = await runAnimeReleaseJob(
      config({ follows: { enabled: false, pollMinutes: 30, maxPerChat: 3, batchSize: 20 } }),
      storageWith(fakeFollowsRepo([followDoc(-100, 8)])),
      catalog,
      vi.fn(async () => true),
    );
    expect(result).toEqual({ polled: 0, newEpisodes: 0, notified: 0 });
    expect(catalog.refresh).not.toHaveBeenCalled();
  });
});

describe('AnimeKnowledgeService intents', () => {
  const knowledge = (catalog: AnimeCatalogService, follows: AnimeFollowService) =>
    new AnimeKnowledgeService(config(), catalog, follows);

  it('rejects an unsupported intent name instead of guessing one', () => {
    expect(parseAnimeIntent('lookup')).toBe('lookup');
    expect(parseAnimeIntent('  FOLLOW ')).toBe('follow');
    expect(parseAnimeIntent('download_episode')).toBeNull();
    expect(parseAnimeIntent(42)).toBeNull();
  });

  it('answers a release question from real catalog data', async () => {
    const catalog = fakeCatalog({
      lookup: vi.fn(async () => ({
        match: { series: series('154587', 'Frieren', 9), score: 1, matchedKey: 'frieren' },
        candidates: [],
        fromCache: true,
      })),
    });
    const service = knowledge(catalog, {} as AnimeFollowService);

    const answer = await service.handle({
      intent: 'lookup',
      title: 'Frieren',
      chatId: -100,
      userHandle: '@u',
    });
    expect(answer.resolved).toBe(true);
    expect(answer.summary).toContain('Ultimo episodio uscito: 9');
    expect(answer.sources).toEqual(['https://anilist.co/anime/154587']);
  });

  it('surfaces the shortlist instead of asserting an ambiguous match', async () => {
    const catalog = fakeCatalog({
      lookup: vi.fn(async () => ({
        candidates: [
          { series: series('1', 'Fate/stay night'), score: 1, matchedKey: 'k' },
          { series: series('2', 'Fate/stay night'), score: 1, matchedKey: 'k' },
        ],
        fromCache: true,
      })),
    });
    const answer = await knowledge(catalog, {} as AnimeFollowService).handle({
      intent: 'lookup',
      title: 'fate stay night',
      chatId: -100,
      userHandle: '@u',
    });

    // Previously asserted `resolved: false`, which was the bug: the agent treated a real
    // shortlist as a tool failure, discarded it, and printed its own verification error to the
    // user. A shortlist backed by catalog URLs is a verifiable answer.
    expect(answer.resolved).toBe(true);
    expect(answer.candidates).toHaveLength(2);
    expect(answer.sources).toHaveLength(2);
    expect(answer.summary).toContain('Fate/stay night');
  });

  it('reports a missing title rather than searching for nothing', async () => {
    const catalog = fakeCatalog();
    const answer = await knowledge(catalog, {} as AnimeFollowService).handle({
      intent: 'lookup',
      chatId: -100,
      userHandle: '@u',
    });
    expect(answer.resolved).toBe(false);
    expect(catalog.lookup).not.toHaveBeenCalled();
  });
});
