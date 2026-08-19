import { describe, expect, it, vi } from 'vitest';
import { AmbientRetriever } from '../src/ambient/retriever.js';
import { bestDomainFor, classifyMessage } from '../src/ambient/classifier.js';
import { extractSubjects } from '../src/ambient/subjects.js';
import { observeAmbientFacts } from '../src/ambient/affinity.js';
import { runLearnNotifyJob } from '../src/jobs/learnNotifyJob.js';
import type { AmbientConfig } from '../src/config/index.js';
import type { AmbientFact, AmbientProvider } from '../src/ambient/types.js';
import type { Storage } from '../src/storage/index.js';
import type { LocalDevelopmentJob } from '../src/capabilities/localDevelopmentJobs.js';

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

describe('a slow provider can never stall a reply', () => {
  it('gives up on a provider that hangs past the deadline', async () => {
    const hanging: AmbientProvider = {
      name: 'hanging',
      domains: ['anime'],
      enabled: true,
      // Deliberately ignores the abort signal, which is the case the race protects against.
      recall: () => new Promise<AmbientFact[]>(() => undefined),
    };
    const retriever = new AmbientRetriever(config({ deadlineMs: 250 }), [hanging]);

    const started = Date.now();
    const result = await retriever.recall({
      message: 'e uscito il nuovo episodio di Frieren',
      chatId: -100,
      nsfwAllowed: false,
    });

    expect(result.facts).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still returns what a fast provider produced alongside a hanging one', async () => {
    const fast: AmbientProvider = {
      name: 'fast',
      domains: ['anime'],
      enabled: true,
      recall: async () => [
        {
          domain: 'anime',
          subject: 'Frieren',
          text: 'facts',
          confidence: 0.9,
          fromCache: true,
        },
      ],
    };
    const hanging: AmbientProvider = {
      name: 'hanging',
      domains: ['anime'],
      enabled: true,
      recall: () => new Promise<AmbientFact[]>(() => undefined),
    };
    const retriever = new AmbientRetriever(config({ deadlineMs: 250 }), [hanging, fast]);

    const result = await retriever.recall({
      message: 'un episodio di Frieren',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(result.facts.map((f) => f.subject)).toEqual(['Frieren']);
  });

  it('hands providers a signal so their own HTTP work can abort too', async () => {
    let seen: AbortSignal | undefined;
    const provider: AmbientProvider = {
      name: 'p',
      domains: ['anime'],
      enabled: true,
      recall: async (request) => {
        seen = request.signal;
        return [];
      },
    };
    await new AmbientRetriever(config(), [provider]).recall({
      message: 'un episodio di anime',
      chatId: -100,
      nsfwAllowed: false,
    });
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

describe('Italian elision is not quotation', () => {
  it.each([
    "che ne pensi dell'anime? l'ho trovato bello",
    "è uscito l'ultimo episodio di Tanya the Evil? l'ho aspettato tanto",
    "un'altra volta con l'isekai",
  ])('never produces an elision-fused subject from %j', (message) => {
    for (const subject of extractSubjects(message)) {
      // "anime? l" and friends are the shape this used to produce.
      expect(subject).not.toMatch(/\bl$/);
      expect(subject).not.toMatch(/\?/);
    }
  });

  it('still honours a real quoted title', () => {
    expect(extractSubjects('ho visto "La Haine" ieri')).toContain('La Haine');
  });
});

describe('facts carry a domain their provider actually covers', () => {
  it('picks the best classified domain the provider supports', () => {
    // A message that is anime-flavoured but also about tooling.
    const classification = classifyMessage('sto guardando un anime mentre configuro docker');
    expect(bestDomainFor(classification, ['technology', 'gaming'], 'technology')).toBe(
      'technology',
    );
  });

  it('falls back rather than borrowing an uncovered domain', () => {
    const classification = classifyMessage('che episodio assurdo di questo anime');
    expect(bestDomainFor(classification, ['philosophy', 'science'], 'science')).toBe('science');
  });

  it('uses the covered domain when the provider does support the top one', () => {
    const classification = classifyMessage('il nichilismo di Nietzsche');
    expect(bestDomainFor(classification, ['philosophy', 'science'], 'science')).toBe('philosophy');
  });
});

describe('repeat mentions preserve what is already known', () => {
  it('merges rather than replacing, so threads survive a later thread-less mention', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const storage = {
      topicAffinity: { record: async () => undefined },
      conversationEntities: {
        touch: async (doc: Record<string, unknown>) => {
          calls.push(doc);
        },
        upsert: vi.fn(),
      },
    } as unknown as Storage;

    const fact: AmbientFact = {
      domain: 'anime',
      subject: 'Frieren',
      text: 'facts',
      confidence: 0.9,
      fromCache: true,
      entityId: 'anilist:154587',
    };
    await observeAmbientFacts(storage, { chatId: -100, userHandle: '@u', facts: [fact] });

    // `touch` is the merge-safe write; `upsert` would replace threadIds with [].
    expect(calls).toHaveLength(1);
    expect(storage.conversationEntities.upsert).not.toHaveBeenCalled();
    expect(calls[0]?.['threadIds']).toEqual([]);
  });
});

describe('learn notifier bounds what it announces', () => {
  const job = (overrides: Partial<LocalDevelopmentJob> = {}): LocalDevelopmentJob =>
    ({
      id: '11111111-2222-3333-4444-555555555555',
      state: 'ready',
      privateChatId: 12345,
      updatedAt: new Date().toISOString(),
      ...overrides,
    }) as LocalDevelopmentJob;

  const storage = () =>
    ({
      jobNotifications: { claim: async () => true, release: async () => undefined },
    }) as unknown as Storage;

  it('never announces a stale job, which is runnable rather than finished', async () => {
    // listTerminal filters it out; this asserts the notifier is not handed one by mistake either.
    const notify = vi.fn(async () => true);
    await runLearnNotifyJob({ enabled: true, listTerminal: async () => [] }, storage(), notify);
    expect(notify).not.toHaveBeenCalled();
  });

  it('announces a genuinely finished job with its next command', async () => {
    const notify = vi.fn(async () => true);
    const result = await runLearnNotifyJob(
      { enabled: true, listTerminal: async () => [job()] },
      storage(),
      notify,
    );
    expect(result.notified).toBe(1);
    expect(notify.mock.calls[0]?.[0].nextCommand).toBe('/learn diff 11111111');
  });
});

describe('a prompt block must never reach a user', () => {
  it('strips the grounding block that leaked into the group verbatim', async () => {
    const { stripPromptScaffolding } = await import('../src/services/agentRuntime.js');
    const leaked = [
      'WEB CONTEXT (fresh results from a web search for "significato nautra vota" - use these',
      'facts to be accurate; include direct links when the user asks for links, sources, prices,',
      'listings, availability, or "what you found"; never say you "searched the web"):',
      '- Vota - Significato ed etimologia: la voce Treccani [treccani.it] https://treccani.it/vota',
      'SCANNED PAGES (opened result pages; prefer these concrete details over snippets):',
      '- Vota: dettaglio concreto',
    ].join('\n');

    const out = stripPromptScaffolding(leaked);

    // The findings survive; the instructions written for the model do not.
    expect(out).toContain('Treccani');
    expect(out).toContain('https://treccani.it/vota');
    for (const directive of [
      'WEB CONTEXT',
      'SCANNED PAGES',
      'use these',
      'never say you',
      'prefer these concrete',
    ]) {
      expect(out, `leaked: ${directive}`).not.toContain(directive);
    }
  });

  it('leaves ordinary prose untouched', async () => {
    const { stripPromptScaffolding } = await import('../src/services/agentRuntime.js');
    const prose = 'Esce giovedi 20 agosto su Netflix (e anche su YouTube).';
    expect(stripPromptScaffolding(prose)).toBe(prose);
  });
});
