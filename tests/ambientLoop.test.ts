import { describe, expect, it, vi } from 'vitest';
import { AutoEngageScorer } from '../src/services/autoengage.js';
import { observeAmbientFacts } from '../src/ambient/affinity.js';
import { runLearnNotifyJob, nextCommandFor } from '../src/jobs/learnNotifyJob.js';
import { classifyMessage } from '../src/ambient/classifier.js';
import type { AmbientFact } from '../src/ambient/types.js';
import type { LLMProvider, AutoEngageScore } from '../src/providers/llm/types.js';
import type { Storage } from '../src/storage/index.js';
import type { LocalDevelopmentJob } from '../src/capabilities/localDevelopmentJobs.js';

function scorer(score: Partial<AutoEngageScore>, knownTopicBonus = 0.2): AutoEngageScorer {
  const llm = {
    async scoreAutoEngage() {
      return {
        shouldReply: true,
        confidence: 0.5,
        reason: 'test',
        suggestedTone: 'neutral',
        risk: 'low',
        ...score,
      } as AutoEngageScore;
    },
  } as unknown as LLMProvider;
  return new AutoEngageScorer(llm, {
    maxRepliesPerChatPerHour: 100,
    chatCooldownSeconds: 0,
    userCooldownSeconds: 0,
    minConfidence: 0.6,
    knownTopicBonus,
  });
}

const inputs = (knownTopic: boolean) => ({
  person: { userHandle: '@u' } as never,
  context: { chatId: -100 } as never,
  currentMessage: 'ma quindi che ne pensate di questo episodio',
  modeName: 'default',
  modeDescription: '',
  history: [],
  userFacts: [],
  groupFacts: [],
  knownTopic,
});

describe('autoengage known-topic bonus', () => {
  it('stays quiet on an unknown topic below the confidence bar', async () => {
    const decision = await scorer({ confidence: 0.5 }).decide(inputs(false), false, true);
    expect(decision.shouldReply).toBe(false);
  });

  it('speaks up at the same confidence when it actually knows the subject', async () => {
    const decision = await scorer({ confidence: 0.5 }).decide(inputs(true), false, true);
    expect(decision.shouldReply).toBe(true);
  });

  it('never lets the bonus bypass the hourly cap', async () => {
    const llm = {
      async scoreAutoEngage() {
        return { shouldReply: true, confidence: 1, reason: 'x', suggestedTone: 'n', risk: 'low' };
      },
    } as unknown as LLMProvider;
    const capped = new AutoEngageScorer(llm, {
      maxRepliesPerChatPerHour: 1,
      chatCooldownSeconds: 0,
      userCooldownSeconds: 0,
      minConfidence: 0.6,
      knownTopicBonus: 0.5,
    });
    capped.noteReply(-100, '@u'); // consumes the single allowed reply for this hour
    const decision = await capped.decide(inputs(true), false, true);
    expect(decision.shouldReply).toBe(false);
    expect(decision.reason).toMatch(/cap/i);
  });

  it('never lets the bonus bypass the chat cooldown', async () => {
    const llm = {
      async scoreAutoEngage() {
        return { shouldReply: true, confidence: 1, reason: 'x', suggestedTone: 'n', risk: 'low' };
      },
    } as unknown as LLMProvider;
    const cooled = new AutoEngageScorer(llm, {
      maxRepliesPerChatPerHour: 100,
      chatCooldownSeconds: 600,
      userCooldownSeconds: 0,
      minConfidence: 0.6,
      knownTopicBonus: 0.5,
    });
    cooled.noteReply(-100, '@u');
    const decision = await cooled.decide(inputs(true), false, true);
    expect(decision.shouldReply).toBe(false);
    expect(decision.reason).toMatch(/cooldown/i);
  });

  it('still respects a bad-feedback penalty', async () => {
    const decision = await scorer({ confidence: 0.62 }, 0.1).decide(
      { ...inputs(true), recentNegativeFeedback: true },
      false,
      true,
    );
    // 0.6 base + 0.15 penalty - 0.1 bonus = 0.65 > 0.62
    expect(decision.shouldReply).toBe(false);
  });

  it('is driven by a signal the message handler can compute with one regex pass', () => {
    expect(classifyMessage('che episodio assurdo di questo anime').domains.length).toBeGreaterThan(
      0,
    );
    expect(classifyMessage('ahahah muoio').domains.length).toBe(0);
  });
});

describe('ambient observation', () => {
  const fact = (overrides: Partial<AmbientFact> = {}): AmbientFact => ({
    domain: 'anime',
    subject: 'Frieren',
    text: 'facts',
    url: 'https://anilist.co/anime/154587',
    confidence: 0.9,
    fromCache: true,
    entityId: 'anilist:154587',
    ...overrides,
  });

  const fakeStorage = () => {
    const affinity: unknown[] = [];
    const entities: unknown[] = [];
    return {
      records: affinity,
      entities,
      storage: {
        topicAffinity: {
          record: vi.fn(async (...args: unknown[]) => {
            affinity.push(args);
          }),
        },
        conversationEntities: {
          upsert: vi.fn(async (doc: unknown) => {
            entities.push(doc);
          }),
        },
      } as unknown as Storage,
    };
  };

  it('records who raised the subject, so taste is not one persons monologue', async () => {
    const { storage, records } = fakeStorage();
    await observeAmbientFacts(storage, {
      chatId: -100,
      userHandle: '@u',
      facts: [fact()],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual([
      -100,
      'anime',
      'anilist:154587',
      'Frieren',
      '@u',
      expect.any(Date),
    ]);
  });

  it('registers the subject as a conversation entity for later referents', async () => {
    const { storage, entities } = fakeStorage();
    await observeAmbientFacts(storage, {
      chatId: -100,
      userHandle: '@u',
      facts: [fact()],
      threadId: 'thread-1',
      messageId: 42,
    });
    expect(entities[0]).toMatchObject({
      chatId: -100,
      entityId: 'anilist:154587',
      type: 'topic',
      canonicalName: 'Frieren',
      threadIds: ['thread-1'],
      sourceMessageIds: [42],
      attributes: expect.arrayContaining(['domain:anime']),
    });
  });

  it('skips facts with no stable identity', async () => {
    const { storage, records } = fakeStorage();
    await observeAmbientFacts(storage, {
      chatId: -100,
      userHandle: '@u',
      facts: [fact({ entityId: undefined })],
    });
    expect(records).toHaveLength(0);
  });

  it('never throws when the store is unavailable', async () => {
    const storage = {
      topicAffinity: {
        record: async () => {
          throw new Error('mongo down');
        },
      },
      conversationEntities: { upsert: async () => undefined },
    } as unknown as Storage;
    await expect(
      observeAmbientFacts(storage, { chatId: -100, userHandle: '@u', facts: [fact()] }),
    ).resolves.toBeUndefined();
  });
});

describe('learn job notifications', () => {
  const job = (overrides: Partial<LocalDevelopmentJob> = {}): LocalDevelopmentJob =>
    ({
      id: '11111111-2222-3333-4444-555555555555',
      state: 'ready',
      privateChatId: 12345,
      resultCode: undefined,
      ...overrides,
    }) as LocalDevelopmentJob;

  const fakeStorage = (claimed = true) => {
    const released: string[] = [];
    return {
      released,
      storage: {
        jobNotifications: {
          claim: vi.fn(async () => claimed),
          release: vi.fn(async (_kind: string, id: string) => {
            released.push(id);
          }),
        },
      } as unknown as Storage,
    };
  };

  it('announces a finished job so nobody has to poll', async () => {
    const { storage } = fakeStorage();
    const notify = vi.fn(async () => true);
    const result = await runLearnNotifyJob(
      { enabled: true, listTerminal: async () => [job()] },
      storage,
      notify,
    );
    expect(result.notified).toBe(1);
    expect(notify.mock.calls[0]?.[0].nextCommand).toBe('/learn diff 11111111');
  });

  it('does not announce the same outcome twice', async () => {
    const { storage } = fakeStorage(false);
    const notify = vi.fn(async () => true);
    const result = await runLearnNotifyJob(
      { enabled: true, listTerminal: async () => [job()] },
      storage,
      notify,
    );
    expect(result.notified).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('releases the claim when delivery fails so the next tick retries', async () => {
    const { storage, released } = fakeStorage();
    await runLearnNotifyJob(
      { enabled: true, listTerminal: async () => [job()] },
      storage,
      async () => false,
    );
    expect(released).toEqual(['11111111-2222-3333-4444-555555555555']);
  });

  it('releases the claim when the notifier throws', async () => {
    const { storage, released } = fakeStorage();
    await runLearnNotifyJob(
      { enabled: true, listTerminal: async () => [job()] },
      storage,
      async () => {
        throw new Error('telegram down');
      },
    );
    expect(released).toHaveLength(1);
  });

  it('does nothing when local development is disabled', async () => {
    const { storage } = fakeStorage();
    const listTerminal = vi.fn(async () => []);
    const result = await runLearnNotifyJob(
      { enabled: false, listTerminal },
      storage,
      async () => true,
    );
    expect(result).toEqual({ inspected: 0, notified: 0 });
    expect(listTerminal).not.toHaveBeenCalled();
  });

  it('points a failed job at the status command and a clean one at nothing', () => {
    expect(nextCommandFor(job({ state: 'ready' }))).toBe('/learn diff 11111111');
    expect(nextCommandFor(job({ state: 'failed' }))).toBe('/learn status 11111111');
    expect(nextCommandFor(job({ state: 'conflict' }))).toBe('/learn status 11111111');
    expect(nextCommandFor(job({ state: 'applied' }))).toBeUndefined();
  });

  it('survives a store that cannot list jobs', async () => {
    const { storage } = fakeStorage();
    const result = await runLearnNotifyJob(
      {
        enabled: true,
        listTerminal: async () => {
          throw new Error('store broken');
        },
      },
      storage,
      async () => true,
    );
    expect(result).toEqual({ inspected: 0, notified: 0 });
  });
});
