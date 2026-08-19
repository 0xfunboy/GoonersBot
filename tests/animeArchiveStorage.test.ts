import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import {
  AnimeArchiveJobsRepo,
  AnimeArchiveOffersRepo,
  AnimeArchiveRepo,
  ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN,
  animeArchiveJobIdempotencyKey,
  animeArchiveOfferDedupeKey,
  classifyAnimeArchiveAcceptedOfferRecovery,
  classifyAnimeArchiveOfferTransition,
  mergeAnimeArchiveSeriesSnapshot,
  recoverAnimeArchiveEpisodes,
  resumeAnimeArchiveEpisodes,
  sortAnimeArchiveEpisodes,
  summarizeAnimeArchiveEpisodes,
  type AnimeArchiveJobDoc,
  type AnimeArchiveJobEpisode,
  type AnimeArchiveOfferDoc,
  type AnimeArchiveTarget,
  type CreateAnimeArchiveJobInput,
} from '../src/storage/repositories/animeArchive.js';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const LATER = new Date('2026-08-19T12:10:00.000Z');

const target: AnimeArchiveTarget = {
  kind: 'series',
  series: {
    id: 'frieren',
    canonicalUrl: 'https://www.animeunity.so/anime/1-frieren',
    title: 'Frieren',
  },
};

function offer(overrides: Partial<AnimeArchiveOfferDoc> = {}): AnimeArchiveOfferDoc {
  return {
    id: 'ao_test',
    dedupeKey: 'offer:fixture',
    source: 'animeunity',
    target,
    chatId: -100,
    threadId: 42,
    replyToMessageId: 7,
    confirmationMessageId: 8,
    requesterTelegramId: 123,
    requiresAdmin: true,
    state: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: LATER,
    acceptedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

const actor = {
  actorTelegramId: 123,
  chatId: -100,
  threadId: 42,
  isAdmin: true,
};

describe('anime archive offer transitions', () => {
  it('distinguishes every harmless callback rejection', () => {
    expect(classifyAnimeArchiveOfferTransition(null, actor, NOW)).toBe('not_found');
    expect(
      classifyAnimeArchiveOfferTransition(offer({ requesterTelegramId: 999 }), actor, NOW),
    ).toBe('wrong_actor');
    expect(classifyAnimeArchiveOfferTransition(offer({ threadId: 99 }), actor, NOW)).toBe(
      'wrong_chat',
    );
    expect(classifyAnimeArchiveOfferTransition(offer({ state: 'accepted' }), actor, NOW)).toBe(
      'already_consumed',
    );
    expect(
      classifyAnimeArchiveOfferTransition(
        offer({ expiresAt: new Date(NOW.getTime() - 1) }),
        actor,
        NOW,
      ),
    ).toBe('expired');
    expect(classifyAnimeArchiveOfferTransition(offer(), { ...actor, isAdmin: false }, NOW)).toBe(
      'admin_required',
    );
  });

  it('re-checks admin for SI but lets the owner say NO after a demotion', () => {
    const demoted = { ...actor, isAdmin: false };
    expect(classifyAnimeArchiveOfferTransition(offer(), demoted, NOW, 'accept')).toBe(
      'admin_required',
    );
    expect(classifyAnimeArchiveOfferTransition(offer(), demoted, NOW, 'cancel')).toBeNull();
  });

  it('validates accepted-offer recovery without reopening the pending transition', () => {
    expect(
      classifyAnimeArchiveAcceptedOfferRecovery(offer({ state: 'accepted' }), actor, NOW),
    ).toBeNull();
    expect(
      classifyAnimeArchiveAcceptedOfferRecovery(
        offer({ state: 'accepted' }),
        { ...actor, actorTelegramId: 999 },
        NOW,
      ),
    ).toBe('wrong_actor');
    expect(classifyAnimeArchiveAcceptedOfferRecovery(offer(), actor, NOW)).toBe('already_consumed');
  });

  it('uses compare-and-set semantics so replay cannot consume twice', async () => {
    const memory = new InMemoryOffersCollection();
    const repo = new AnimeArchiveOffersRepo(fakeDb('anime_archive_offers', memory), () => 'ao_1');
    await repo.create(
      {
        source: 'animeunity',
        target,
        chatId: actor.chatId,
        threadId: actor.threadId,
        requesterTelegramId: actor.actorTelegramId,
        requiresAdmin: true,
        expiresAt: LATER,
      },
      NOW,
    );

    expect(await repo.accept('ao_1', actor, NOW)).toMatchObject({ ok: true });
    expect(await repo.accept('ao_1', actor, NOW)).toEqual({
      ok: false,
      reason: 'already_consumed',
    });
  });

  it('atomically allows NO from the owner without admin state', async () => {
    const memory = new InMemoryOffersCollection();
    const repo = new AnimeArchiveOffersRepo(fakeDb('anime_archive_offers', memory), () => 'ao_2');
    await repo.create(
      {
        source: 'animeunity',
        target,
        chatId: actor.chatId,
        threadId: actor.threadId,
        requesterTelegramId: actor.actorTelegramId,
        requiresAdmin: true,
        expiresAt: LATER,
      },
      NOW,
    );

    expect(await repo.cancel('ao_2', { ...actor, isAdmin: false }, NOW)).toMatchObject({
      ok: true,
      offer: { state: 'cancelled' },
    });
  });

  it('reuses one equivalent pending nonce and lets the latest Telegram prompt replace attachment', async () => {
    const memory = new InMemoryOffersCollection();
    let sequence = 0;
    const repo = new AnimeArchiveOffersRepo(fakeDb('anime_archive_offers', memory), () => {
      sequence += 1;
      return `ao_dedupe_${sequence}`;
    });
    const input = {
      source: 'animeunity' as const,
      target,
      chatId: actor.chatId,
      threadId: actor.threadId,
      requesterTelegramId: actor.actorTelegramId,
      requiresAdmin: true,
      expiresAt: LATER,
    };

    const first = await repo.create(input, NOW);
    const firstAttachment = await repo.replaceConfirmationMessage(first.id, 501, NOW);
    const second = await repo.create(
      { ...input, replyToMessageId: 99, expiresAt: new Date(LATER.getTime() + 60_000) },
      new Date(NOW.getTime() + 1_000),
    );
    const attached = await repo.replaceConfirmationMessage(second.id, 502, NOW);

    expect(second.id).toBe(first.id);
    expect(second.dedupeKey).toBe(animeArchiveOfferDedupeKey(input));
    expect(second.replyToMessageId).toBe(99);
    expect(firstAttachment).toMatchObject({
      replacedMessageId: null,
      offer: { confirmationMessageId: 501 },
    });
    expect(attached).toMatchObject({
      replacedMessageId: 501,
      offer: { confirmationMessageId: 502 },
    });
    expect(memory.docs).toHaveLength(1);
  });

  it('reports the exact loser of concurrent prompt replacements', async () => {
    const memory = new InMemoryOffersCollection();
    const repo = new AnimeArchiveOffersRepo(
      fakeDb('anime_archive_offers', memory),
      () => 'ao_race',
    );
    const created = await repo.create(
      {
        source: 'animeunity',
        target,
        chatId: actor.chatId,
        threadId: actor.threadId,
        requesterTelegramId: actor.actorTelegramId,
        requiresAdmin: true,
        expiresAt: LATER,
      },
      NOW,
    );
    await repo.attachConfirmationMessage(created.id, 500, NOW);

    const [one, two] = await Promise.all([
      repo.replaceConfirmationMessage(created.id, 501, NOW),
      repo.replaceConfirmationMessage(created.id, 502, NOW),
    ]);

    expect(one?.replacedMessageId).toBe(500);
    expect(two?.replacedMessageId).toBe(501);
    expect((await repo.get(created.id))?.confirmationMessageId).toBe(502);
  });

  it('invalidates only an undelivered offer and preserves a concurrently attached prompt', async () => {
    const memory = new InMemoryOffersCollection();
    let sequence = 0;
    const repo = new AnimeArchiveOffersRepo(fakeDb('anime_archive_offers', memory), () => {
      sequence += 1;
      return `ao_invalidate_${sequence}`;
    });
    const input = {
      source: 'animeunity' as const,
      target,
      chatId: actor.chatId,
      threadId: actor.threadId,
      requesterTelegramId: actor.actorTelegramId,
      requiresAdmin: true,
      expiresAt: LATER,
    };
    const invisible = await repo.create(input, NOW);
    expect(await repo.invalidatePending(invisible.id, NOW)).toMatchObject({
      state: 'cancelled',
    });

    const visible = await repo.create(input, NOW);
    await repo.attachConfirmationMessage(visible.id, 700, NOW);
    expect(await repo.invalidatePending(visible.id, NOW)).toBeNull();
    expect(await repo.get(visible.id)).toMatchObject({
      state: 'pending',
      confirmationMessageId: 700,
    });
  });
});

function createJobInput(
  overrides: Partial<CreateAnimeArchiveJobInput> = {},
): CreateAnimeArchiveJobInput {
  return {
    scope: 'series',
    source: 'animeunity',
    series: target.series,
    destination: { chatId: -100, threadId: 42, replyToMessageId: 7 },
    requesterTelegramId: 123,
    episodes: [
      { id: 'ep-10', number: 10, canonicalUrl: 'https://example.test/ep-10' },
      { id: 'ep-2', number: 2, canonicalUrl: 'https://example.test/ep-2' },
      { id: 'ep-1', number: 1, canonicalUrl: 'https://example.test/ep-1' },
    ],
    ...overrides,
  };
}

function episode(
  id: string,
  number: number,
  status: AnimeArchiveJobEpisode['status'],
  overrides: Partial<AnimeArchiveJobEpisode> = {},
): AnimeArchiveJobEpisode {
  return {
    id,
    number,
    canonicalUrl: `https://example.test/${id}`,
    order: number - 1,
    status,
    attempts: 1,
    totalAttempts: 1,
    receipt: status === 'done' ? { chatId: -100, messageId: number } : null,
    failureReason: status === 'failed' ? 'source layout changed' : null,
    startedAt: NOW,
    completedAt: status === 'done' || status === 'failed' ? NOW : null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('anime archive durable jobs', () => {
  it('sorts episodes numerically and rejects duplicate source ids', () => {
    expect(sortAnimeArchiveEpisodes(createJobInput().episodes).map((row) => row.number)).toEqual([
      1, 2, 10,
    ]);
    expect(() =>
      sortAnimeArchiveEpisodes([
        { id: 'same', number: 1, canonicalUrl: 'https://example.test/1' },
        { id: 'same', number: 2, canonicalUrl: 'https://example.test/2' },
      ]),
    ).toThrow(/Duplicate/);
  });

  it('prefers the stable target key over an offer id', () => {
    const one = animeArchiveJobIdempotencyKey(
      createJobInput({ offerId: 'offer-one', idempotencyKey: 'animeunity:frieren:all' }),
    );
    const two = animeArchiveJobIdempotencyKey(
      createJobInput({ offerId: 'offer-two', idempotencyKey: 'animeunity:frieren:all' }),
    );
    expect(one).toBe(two);
    expect(one).toMatch(/^caller:/);
  });

  it('deduplicates different offers for the same stable target at the repository boundary', async () => {
    const memory = new InMemoryJobsCollection();
    let sequence = 0;
    const repo = new AnimeArchiveJobsRepo(fakeDb('anime_archive_jobs', memory), () => {
      sequence += 1;
      return `aj_${sequence}`;
    });
    const first = await repo.create(
      createJobInput({
        offerId: 'offer-one',
        idempotencyKey: 'animeunity:frieren:all',
        quotaBypass: true,
      }),
      NOW,
    );
    const replay = await repo.create(
      createJobInput({
        offerId: 'offer-two',
        idempotencyKey: 'animeunity:frieren:all',
      }),
      NOW,
    );

    expect(first.created).toBe(true);
    expect(first.job.quotaBypass).toBe(true);
    expect(first.job.episodes.map((row) => row.number)).toEqual([1, 2, 10]);
    expect(replay).toMatchObject({ created: false, job: { id: first.job.id } });
    expect(memory.docs).toHaveLength(1);
  });

  it('persists quota bypass as false unless explicitly granted', async () => {
    const memory = new InMemoryJobsCollection();
    const repo = new AnimeArchiveJobsRepo(fakeDb('anime_archive_jobs', memory), () => 'aj_1');
    const result = await repo.create(createJobInput(), NOW);
    expect(result.job.quotaBypass).toBe(false);
  });

  it('atomically merges a newer series snapshot and resumes only non-done rows', async () => {
    const memory = new InMemoryJobsCollection();
    const repo = new AnimeArchiveJobsRepo(fakeDb('anime_archive_jobs', memory), () => 'aj_merge');
    const input = createJobInput({
      idempotencyKey: 'series:frieren',
      episodes: [
        { id: 'ep-1', number: 1, canonicalUrl: 'https://example.test/ep-1' },
        { id: 'ep-2', number: 2, canonicalUrl: 'https://example.test/ep-2' },
      ],
    });
    await repo.createOrMergeSeriesSnapshot(input, NOW);
    const durable = memory.docs[0] as AnimeArchiveJobDoc;
    durable.episodes[0] = episode('ep-1', 1, 'done', {
      receipt: { chatId: -100, messageId: 901, fileId: 'done-file' },
    });
    durable.episodes[1] = episode('ep-2', 2, 'failed', { attempts: 3, totalAttempts: 3 });
    durable.state = 'partial';
    durable.summary = summarizeAnimeArchiveEpisodes(durable.episodes);
    durable.finishedAt = NOW;
    const completedBefore = structuredClone(durable.episodes[0]);

    const merged = await repo.createOrMergeSeriesSnapshot(
      {
        ...input,
        offerId: 'offer-new',
        episodes: [
          ...input.episodes,
          { id: 'ep-3', number: 3, canonicalUrl: 'https://example.test/ep-3' },
        ],
      },
      LATER,
    );

    expect(merged).toMatchObject({
      created: false,
      changed: true,
      addedEpisodes: 1,
      resumed: true,
      job: { state: 'queued', resumeCount: 1, summary: null },
    });
    expect(merged.job.episodes[0]).toEqual(completedBefore);
    expect(merged.job.episodes[1]).toMatchObject({
      id: 'ep-2',
      status: 'pending',
      attempts: 0,
      totalAttempts: 3,
      receipt: null,
    });
    expect(merged.job.episodes[2]).toMatchObject({ id: 'ep-3', status: 'pending' });
  });

  it('keeps an active lease and existing rows while appending only new pending episodes', async () => {
    const memory = new InMemoryJobsCollection();
    const repo = new AnimeArchiveJobsRepo(fakeDb('anime_archive_jobs', memory), () => 'aj_running');
    const input = createJobInput({
      idempotencyKey: 'series:running',
      episodes: [
        { id: 'ep-1', number: 1, canonicalUrl: 'https://example.test/ep-1' },
        { id: 'ep-2', number: 2, canonicalUrl: 'https://example.test/ep-2' },
      ],
    });
    await repo.createOrMergeSeriesSnapshot(input, NOW);
    const durable = memory.docs[0] as AnimeArchiveJobDoc;
    durable.state = 'running';
    durable.leaseOwner = 'worker-one';
    durable.leaseExpiresAt = new Date(LATER.getTime() + 60_000);
    durable.leaseRenewedAt = LATER;
    durable.episodes[0] = episode('ep-1', 1, 'done');
    durable.episodes[1] = episode('ep-2', 2, 'running');
    const rowsBefore = structuredClone(durable.episodes);

    const merged = await repo.createOrMergeSeriesSnapshot(
      {
        ...input,
        episodes: [
          ...input.episodes,
          { id: 'ep-3', number: 3, canonicalUrl: 'https://example.test/ep-3' },
        ],
      },
      LATER,
    );

    expect(merged).toMatchObject({ changed: true, resumed: false, addedEpisodes: 1 });
    expect(merged.job).toMatchObject({
      state: 'running',
      leaseOwner: 'worker-one',
      leaseExpiresAt: durable.leaseExpiresAt,
      leaseRenewedAt: LATER,
    });
    expect(merged.job.episodes.slice(0, 2)).toEqual(rowsBefore);
    expect(merged.job.episodes[2]).toMatchObject({ id: 'ep-3', status: 'pending' });
  });

  it('keeps a completed job unchanged when the source snapshot has no new episode', () => {
    const complete = createCompletedSeriesJob();
    const before = structuredClone(complete);
    const result = mergeAnimeArchiveSeriesSnapshot(
      complete,
      complete.episodes.map(({ id, number, canonicalUrl, title }) => ({
        id,
        number,
        canonicalUrl,
        ...(title ? { title } : {}),
      })),
      LATER,
    );
    expect(result).toMatchObject({ changed: false, resumed: false, addedEpisodes: 0 });
    expect(result.job).toEqual(before);
  });

  it('resumes failed/interrupted rows without restarting completed episodes', () => {
    const done = episode('ep-1', 1, 'done');
    const resumed = resumeAnimeArchiveEpisodes(
      [done, episode('ep-2', 2, 'failed'), episode('ep-3', 3, 'running')],
      LATER,
    );

    expect(resumed[0]).toEqual(done);
    expect(resumed.slice(1)).toEqual([
      expect.objectContaining({ id: 'ep-2', status: 'pending', attempts: 0, totalAttempts: 1 }),
      expect.objectContaining({ id: 'ep-3', status: 'pending', attempts: 0, totalAttempts: 1 }),
    ]);
  });

  it('terminalizes a lease-recovered delivery marker and never resumes that uncertain row', () => {
    const oldDocumentWithMarker = episode('ep-2', 2, 'running', {
      deliveryToken: 'delivery-token-old-document',
      deliveryStartedAt: NOW,
      deliveryOutcomeUnknown: undefined,
    });
    const [recovered] = recoverAnimeArchiveEpisodes([oldDocumentWithMarker], 3, LATER);

    expect(recovered).toMatchObject({
      id: 'ep-2',
      status: 'failed',
      deliveryToken: 'delivery-token-old-document',
      deliveryOutcomeUnknown: true,
      failureReason: ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN,
      completedAt: LATER,
    });
    expect(resumeAnimeArchiveEpisodes([recovered as AnimeArchiveJobEpisode], LATER)[0]).toEqual(
      recovered,
    );
  });

  it('preserves delivery-uncertain rows when a series snapshot adds later episodes', () => {
    const job = createCompletedSeriesJob();
    job.state = 'partial';
    job.episodes[1] = episode('ep-2', 2, 'failed', {
      receipt: null,
      deliveryToken: 'delivery-token-uncertain',
      deliveryStartedAt: NOW,
      deliveryOutcomeUnknown: true,
      failureReason: ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN,
    });
    const result = mergeAnimeArchiveSeriesSnapshot(
      job,
      [
        { id: 'ep-1', number: 1, canonicalUrl: 'https://example.test/ep-1' },
        { id: 'ep-2', number: 2, canonicalUrl: 'https://example.test/ep-2' },
        { id: 'ep-3', number: 3, canonicalUrl: 'https://example.test/ep-3' },
      ],
      LATER,
    );

    expect(result).toMatchObject({ changed: true, resumed: true, addedEpisodes: 1 });
    expect(result.job.episodes[1]).toMatchObject({
      id: 'ep-2',
      status: 'failed',
      deliveryToken: 'delivery-token-uncertain',
      deliveryOutcomeUnknown: true,
      failureReason: ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN,
    });
    expect(result.job.episodes[2]).toMatchObject({
      id: 'ep-3',
      status: 'pending',
      deliveryToken: null,
      deliveryOutcomeUnknown: false,
    });
  });

  it('binds marker, completion and rollback transitions to the same opaque token', async () => {
    const calls: Array<{
      filter: Record<string, any>;
      update: Record<string, any>;
      options: Record<string, any>;
    }> = [];
    const db = {
      collection: () => ({
        async findOneAndUpdate(
          filter: Record<string, any>,
          update: Record<string, any>,
          options: Record<string, any>,
        ) {
          calls.push({ filter, update, options });
          return null;
        },
      }),
    } as unknown as Db;
    const repo = new AnimeArchiveJobsRepo(db);
    const receipt = { chatId: -100, messageId: 901, mediaKind: 'video' as const };

    await repo.beginEpisodeDelivery('job', 'episode', 'worker', 'delivery-token', NOW);
    await repo.completeEpisode('job', 'episode', 'worker', 'delivery-token', receipt, NOW);
    await repo.abortEpisodeDelivery('job', 'episode', 'worker', 'delivery-token', NOW);

    expect(calls[0]?.filter.episodes.$elemMatch).toMatchObject({
      id: 'episode',
      deliveryToken: null,
      deliveryOutcomeUnknown: { $ne: true },
    });
    expect(calls[0]?.update.$set).toMatchObject({
      'episodes.$.deliveryToken': 'delivery-token',
      'episodes.$.deliveryOutcomeUnknown': false,
    });
    expect(calls[0]?.options.writeConcern).toEqual({
      w: 'majority',
      journal: true,
      wtimeoutMS: 10_000,
    });
    expect(calls[1]?.filter.episodes.$elemMatch.deliveryToken).toBe('delivery-token');
    expect(calls[1]?.update.$set).toMatchObject({
      'episodes.$.status': 'done',
      'episodes.$.deliveryToken': null,
      'episodes.$.receipt': receipt,
    });
    expect(calls[1]?.options.writeConcern).toEqual(calls[0]?.options.writeConcern);
    expect(calls[2]?.filter.episodes.$elemMatch.deliveryToken).toBe('delivery-token');
  });

  it('builds a safe terminal summary with ordered failed episode details', () => {
    const summary = summarizeAnimeArchiveEpisodes(
      [episode('ep-10', 10, 'failed'), episode('ep-1', 1, 'done'), episode('ep-2', 2, 'failed')],
      1,
    );
    expect(summary).toMatchObject({
      total: 3,
      completed: 1,
      failed: 2,
      pending: 0,
      running: 0,
      skipped: 1,
    });
    expect(summary.failedEpisodes.map((row) => row.number)).toEqual([2, 10]);
  });

  it('declares unique, TTL and lease-query indexes', async () => {
    const indexes: Array<{ keys: Record<string, number>; options: Record<string, unknown> }> = [];
    const db = {
      collection: () => ({
        async createIndex(keys: Record<string, number>, options: Record<string, unknown> = {}) {
          indexes.push({ keys, options });
          return 'index';
        },
      }),
    } as unknown as Db;
    await AnimeArchiveRepo.ensureIndexes(db);

    expect(indexes).toContainEqual({
      keys: { expiresAt: 1 },
      options: { expireAfterSeconds: 0 },
    });
    expect(indexes).toContainEqual({
      keys: { idempotencyKey: 1 },
      options: { unique: true },
    });
    expect(indexes).toContainEqual({
      keys: { dedupeKey: 1 },
      options: {
        unique: true,
        partialFilterExpression: { dedupeKey: { $type: 'string' }, state: 'pending' },
      },
    });
    expect(indexes.some((index) => index.keys.leaseExpiresAt === 1)).toBe(true);
  });
});

class InMemoryOffersCollection {
  readonly docs: AnimeArchiveOfferDoc[] = [];

  async insertOne(doc: AnimeArchiveOfferDoc) {
    if (this.docs.some((entry) => entry.state === 'pending' && entry.dedupeKey === doc.dedupeKey)) {
      throw Object.assign(new Error('duplicate key'), { code: 11_000 });
    }
    this.docs.push(structuredClone(doc));
    return { acknowledged: true };
  }

  async findOne(filter: Record<string, any>) {
    const doc = this.docs.find((candidate) => offerMatches(candidate, filter));
    return doc ? structuredClone(doc) : null;
  }

  async findOneAndUpdate(
    filter: Record<string, any>,
    update: Record<string, any>,
    options: { returnDocument?: 'before' | 'after' } = {},
  ) {
    const doc = this.docs.find((candidate) => offerMatches(candidate, filter));
    if (!doc) return null;
    const previous = structuredClone(doc);
    Object.assign(doc, update.$set ?? {});
    return options.returnDocument === 'before' ? previous : structuredClone(doc);
  }

  async updateMany(filter: Record<string, any>, update: Record<string, any>) {
    let modifiedCount = 0;
    for (const doc of this.docs) {
      if (!offerMatches(doc, filter)) continue;
      Object.assign(doc, update.$set ?? {});
      modifiedCount += 1;
    }
    return { modifiedCount };
  }
}

function offerMatches(doc: AnimeArchiveOfferDoc, filter: Record<string, any>): boolean {
  if (filter.id !== undefined && doc.id !== filter.id) return false;
  if (filter.dedupeKey !== undefined && doc.dedupeKey !== filter.dedupeKey) return false;
  if (filter.state !== undefined && doc.state !== filter.state) return false;
  if (
    filter.requesterTelegramId !== undefined &&
    doc.requesterTelegramId !== filter.requesterTelegramId
  ) {
    return false;
  }
  if (filter.chatId !== undefined && doc.chatId !== filter.chatId) return false;
  if (filter.threadId !== undefined && doc.threadId !== filter.threadId) return false;
  if (filter.requiresAdmin !== undefined && doc.requiresAdmin !== filter.requiresAdmin)
    return false;
  if (filter.expiresAt?.$gt && doc.expiresAt <= filter.expiresAt.$gt) return false;
  if (filter.expiresAt?.$lte && doc.expiresAt > filter.expiresAt.$lte) return false;
  if (filter.confirmationMessageId === null && doc.confirmationMessageId !== null) return false;
  if (
    filter.confirmationMessageId?.$gt !== undefined &&
    (doc.confirmationMessageId === null ||
      doc.confirmationMessageId <= filter.confirmationMessageId.$gt)
  ) {
    return false;
  }
  return true;
}

class InMemoryJobsCollection {
  readonly docs: AnimeArchiveJobDoc[] = [];

  async updateOne(filter: Record<string, any>, update: Record<string, any>) {
    const existing = this.docs.find((doc) => doc.idempotencyKey === filter.idempotencyKey);
    if (existing) return { upsertedCount: 0, modifiedCount: 0 };
    this.docs.push(structuredClone(update.$setOnInsert));
    return { upsertedCount: 1, modifiedCount: 0 };
  }

  async findOne(filter: Record<string, any>) {
    return (
      this.docs.find((doc) =>
        filter.idempotencyKey
          ? doc.idempotencyKey === filter.idempotencyKey
          : filter.id
            ? doc.id === filter.id
            : doc.offerId === filter.offerId,
      ) ?? null
    );
  }

  async findOneAndUpdate(filter: Record<string, any>, update: Record<string, any>) {
    const doc = this.docs.find(
      (entry) =>
        entry.id === filter.id &&
        entry.state === filter.state &&
        entry.updatedAt.getTime() === filter.updatedAt.getTime() &&
        entry.leaseOwner === filter.leaseOwner &&
        sameNullableDate(entry.leaseExpiresAt, filter.leaseExpiresAt) &&
        sameNullableDate(entry.leaseRenewedAt, filter.leaseRenewedAt) &&
        JSON.stringify(entry.episodes) === JSON.stringify(filter.episodes),
    );
    if (!doc) return null;
    Object.assign(doc, structuredClone(update.$set ?? {}));
    return structuredClone(doc);
  }
}

function sameNullableDate(left: Date | null, right: Date | null): boolean {
  return left === null || right === null ? left === right : left.getTime() === right.getTime();
}

function createCompletedSeriesJob(): AnimeArchiveJobDoc {
  const episodes = [episode('ep-1', 1, 'done'), episode('ep-2', 2, 'done')];
  return {
    id: 'aj_done',
    idempotencyKey: 'caller:done',
    offerId: 'ao_done',
    scope: 'series',
    source: 'animeunity',
    series: target.series,
    destination: { chatId: -100, threadId: 42, replyToMessageId: 7 },
    requesterTelegramId: 123,
    quotaBypass: false,
    episodes,
    maxAttempts: 4,
    state: 'done',
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseRenewedAt: null,
    claimCount: 1,
    leaseRecoveryCount: 0,
    resumeCount: 0,
    skippedOnCurrentRun: 0,
    summary: summarizeAnimeArchiveEpisodes(episodes),
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    cancelledAt: null,
  };
}

function fakeDb(collectionName: string, collection: object): Db {
  return {
    collection(name: string) {
      if (name !== collectionName) throw new Error(`Unexpected collection: ${name}`);
      return collection;
    },
  } as unknown as Db;
}
