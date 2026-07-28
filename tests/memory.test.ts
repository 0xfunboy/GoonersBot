import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { jaccard, findDuplicate } from '../src/memory/memoryDeduper.js';
import {
  MemoryMiner,
  isSensitiveMemory,
  normalizeMemoryMiningCandidate,
} from '../src/memory/memoryMiner.js';
import { memoryMiningResultSchema } from '../src/memory/schemas.js';
import type { LLMProvider } from '../src/providers/llm/types.js';
import type { MemoryCandidate, MemoryItem } from '../src/memory/types.js';
import {
  buildMemoryMiningPrompt,
  MEMORY_MINING_SCHEMA_HINT,
  MEMORY_MINING_SYSTEM,
  selectMemoriesForMiningContext,
} from '../src/prompts/memoryMining.js';
import { estimateMiningRequestTokens } from '../src/providers/llm/miningPacer.js';
import { MemoryItemsRepo } from '../src/storage/repositories/memoryItems.js';

function cand(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    subjectType: 'user',
    subjectHandle: '@bob',
    involvedHandles: ['@bob'],
    category: 'reputation',
    text: 'is the meme lord of the group',
    normalizedText: 'is the meme lord of the group',
    confidence: 0.9,
    salience: 0.8,
    toxicity: 'clean',
    sourceMessageIds: [1],
    reason: 'recurring',
    ...over,
  };
}

function item(over: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date();
  return {
    _id: 'x',
    chatId: -1,
    subjectType: 'user',
    subjectHandle: '@bob',
    involvedHandles: ['@bob'],
    text: 'is the meme lord of the group',
    normalizedText: 'is the meme lord of the group',
    category: 'reputation',
    source: 'auto',
    sourceMessageIds: [],
    confidence: 0.8,
    salience: 0.5,
    toxicity: 'clean',
    status: 'active',
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    positiveFeedbackCount: 0,
    negativeFeedbackCount: 0,
    tags: [],
    ...over,
  };
}

describe('memoryDeduper', () => {
  it('jaccard similarity', () => {
    expect(jaccard('the meme lord', 'the meme lord')).toBe(1);
    expect(jaccard('totally different words here', 'nothing alike whatsoever')).toBeLessThan(0.2);
  });
  it('finds exact normalized duplicate', () => {
    expect(findDuplicate(cand(), [item()])).not.toBeNull();
  });
  it('finds near-duplicate same subject+category', () => {
    const dup = findDuplicate(
      cand({
        normalizedText: 'meme lord of the whole group',
        text: 'meme lord of the whole group',
      }),
      [item()],
    );
    expect(dup).not.toBeNull();
  });
  it('no duplicate for different subject', () => {
    expect(
      findDuplicate(
        cand({
          subjectHandle: '@alice',
        }),
        [item()],
      ),
    ).toBeNull();
  });
  it('does not merge equal group text across different subject types', () => {
    expect(
      findDuplicate(cand({ subjectType: 'group', subjectHandle: null, involvedHandles: [] }), [
        item({ subjectType: 'event', subjectHandle: null, involvedHandles: [] }),
      ]),
    ).toBeNull();
  });
});

describe('isSensitiveMemory', () => {
  it('flags sensitive content', () => {
    expect(isSensitiveMemory('his password is hunter2')).toBe(true);
    expect(isSensitiveMemory('call him at +39 333 1234567')).toBe(true);
    expect(isSensitiveMemory('is the resident doom-metal DJ')).toBe(false);
  });
});

describe('MemoryMiner.extractCandidates', () => {
  function miner(payload: unknown): MemoryMiner {
    const llm = {
      async jsonCompletion() {
        return payload;
      },
    } as unknown as LLMProvider;
    return new MemoryMiner(llm, {
      temperature: 0.1,
      maxCandidates: 5,
      minSalience: 0.45,
    });
  }

  it('filters blocked, sensitive, low-confidence, low-salience', async () => {
    const m = miner({
      candidates: [
        cand({
          category: 'group_lore',
          text: 'good lore',
          normalizedText: 'good lore',
          confidence: 0.9,
          salience: 0.8,
        }),
        cand({ text: 'blocked one', normalizedText: 'blocked one', toxicity: 'blocked' }),
        cand({ text: 'his password is hunter2', normalizedText: 'his password is hunter2' }),
        cand({ text: 'low conf', normalizedText: 'low conf', confidence: 0.2 }),
        cand({ text: 'low sal', normalizedText: 'low sal', salience: 0.1 }),
      ],
    });
    const out = await m.extractCandidates({
      messages: [
        {
          messageId: 1,
          handle: '@bob',
          isBot: false,
          message: { messageText: 'hi', timestamp: new Date() },
        },
      ],
      existingMemories: [],
      language: 'italian',
      nsfwEnabled: true,
      minConfidence: 0.62,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('good lore');
  });

  it('leaves new profile facts and running jokes to the authoritative social graph', async () => {
    const m = miner({
      candidates: [
        cand({ category: 'preference', text: 'Bob ama il jazz' }),
        cand({ category: 'running_joke', text: 'La solita stampante di Bob' }),
        cand({ category: 'quote', text: 'Bob ha detto: mai più Excel' }),
      ],
    });
    const out = await m.extractCandidates({
      messages: [
        {
          messageId: 1,
          handle: '@bob',
          isBot: false,
          message: { messageText: 'mai più Excel', timestamp: new Date() },
        },
      ],
      existingMemories: [],
      language: 'italian',
      nsfwEnabled: false,
      minConfidence: 0.62,
    });
    expect(out.map((candidate) => candidate.category)).toEqual(['quote']);
  });

  it('rejects ungrounded ids/handles and canonicalizes model text deterministically', async () => {
    const m = miner({
      candidates: [
        cand({
          category: 'group_lore',
          subjectHandle: '@ALICE',
          involvedHandles: ['@BOB', '@bob'],
          text: '  Alice   adora Meme  ',
          normalizedText: 'do not trust this field',
          sourceMessageIds: [11, 12, 99, 11],
        }),
        cand({
          category: 'group_lore',
          subjectHandle: '@CAROL',
          involvedHandles: ['@carol'],
          text: 'Carol sa usare Blender',
          normalizedText: 'wrong',
          sourceMessageIds: [11],
        }),
        cand({
          subjectHandle: '@ghost',
          involvedHandles: [],
          text: 'invented subject',
          normalizedText: 'invented subject',
          sourceMessageIds: [11],
        }),
        cand({
          involvedHandles: ['@ghost'],
          text: 'invented participant',
          normalizedText: 'invented participant',
          sourceMessageIds: [11],
        }),
        cand({
          text: 'bot-only evidence',
          normalizedText: 'bot-only evidence',
          sourceMessageIds: [12, 99],
        }),
      ],
    });
    const out = await m.extractCandidates({
      messages: [
        {
          messageId: 11,
          handle: '@alice',
          isBot: false,
          message: { messageText: 'io adoro i meme', timestamp: new Date() },
        },
        {
          messageId: 12,
          handle: '@goonerbot',
          isBot: true,
          message: { messageText: 'not evidence', timestamp: new Date() },
        },
        {
          messageId: 13,
          handle: '@bob',
          isBot: false,
          message: { messageText: 'confermo', timestamp: new Date() },
        },
      ],
      existingMemories: [],
      knownHandles: ['@carol'],
      eligibleSourceMessageIds: [11],
      language: 'italian',
      nsfwEnabled: false,
      minConfidence: 0.62,
    });

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      subjectHandle: '@alice',
      involvedHandles: ['@bob'],
      normalizedText: 'alice adora meme',
      sourceMessageIds: [11],
    });
    expect(out[1]).toMatchObject({
      subjectHandle: '@carol',
      involvedHandles: ['@carol'],
      sourceMessageIds: [11],
    });
  });

  it('throws when the model yields no schema-valid result', async () => {
    const m = miner(null);
    await expect(
      m.extractCandidates({
        messages: [
          {
            messageId: 1,
            handle: '@bob',
            isBot: false,
            message: { messageText: 'hi', timestamp: new Date() },
          },
        ],
        existingMemories: [],
        language: 'italian',
        nsfwEnabled: false,
        minConfidence: 0.62,
      }),
    ).rejects.toThrow('schema-valid');
  });

  it('uses the compact human schema contract and a bounded output for Gemma mining', async () => {
    const jsonCompletion = vi.fn(async () => ({ candidates: [] }));
    const m = new MemoryMiner({ jsonCompletion } as unknown as LLMProvider, {
      temperature: 0.1,
      maxCandidates: 8,
      minSalience: 0.45,
    });
    await m.extractCandidates({
      messages: [
        {
          messageId: 1,
          handle: '@bob',
          isBot: false,
          message: { messageText: 'questa è lore', timestamp: new Date() },
        },
      ],
      existingMemories: [],
      language: 'italian',
      nsfwEnabled: false,
      minConfidence: 0.62,
    });

    expect(jsonCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ includeGeneratedSchema: false, maxTokens: 900 }),
    );
  });
});

describe('memory mining prompt budget', () => {
  it('selects relevant lore beyond the old top-300 cutoff within a deterministic byte cap', () => {
    const messages = [
      {
        messageId: 900,
        handle: '@alice',
        isBot: false,
        message: {
          messageText: 'la stampante di Alice è tornata a mangiare fogli',
          timestamp: new Date('2026-07-28T08:00:00Z'),
        },
      },
    ];
    const memories = Array.from({ length: 557 }, (_, index) =>
      item({
        _id: `memory-${index}`,
        subjectHandle: '@other',
        involvedHandles: ['@other'],
        category: 'group_lore',
        text: `evento completamente scollegato numero ${index}`,
        normalizedText: `evento completamente scollegato numero ${index}`,
        salience: 0.95,
        confidence: 0.95,
      }),
    );
    memories[556] = item({
      _id: 'relevant-beyond-300',
      subjectHandle: '@alice',
      involvedHandles: ['@alice'],
      category: 'group_lore',
      text: 'La stampante di Alice mangia sempre i fogli',
      normalizedText: 'la stampante di alice mangia sempre i fogli',
      salience: 0.1,
      confidence: 0.6,
    });

    const selected = selectMemoriesForMiningContext(messages, memories);
    const prompt = buildMemoryMiningPrompt({
      messages,
      existingMemories: memories,
      language: 'italian',
      nsfwEnabled: false,
      maxCandidates: 8,
    });

    expect(selected.map((memory) => memory._id)).toContain('relevant-beyond-300');
    expect(selected.length).toBeLessThanOrEqual(20);
    expect(prompt).toContain('relevant-beyond-300');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(10_000);
    expect(prompt).toContain('out of 557');
    const system = [
      MEMORY_MINING_SYSTEM,
      'Output ONLY a single valid JSON object. No prose, no markdown fences, no comments.',
      `REQUIRED OUTPUT CONTRACT:\n${MEMORY_MINING_SCHEMA_HINT}`,
    ].join('\n\n');
    expect(
      estimateMiningRequestTokens({
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 900,
      }),
    ).toBeLessThan(15_000);
  });
});

describe('normalizeMemoryMiningCandidate', () => {
  it('normalizes only lossless JSON-shape deviations emitted by local models', () => {
    const normalized = normalizeMemoryMiningCandidate(
      [
        {
          subject_type: 'GROUP',
          subject_handle: '',
          involved_handles: '@alice',
          category: 'GROUP LORE',
          text: '  La stampante è diventata il boss finale  ',
          confidence: '0.91',
          salience: '0.8',
          toxicity: 'CLEAN',
          source_message_ids: ['#101'],
          operation: 'NEW',
          target_memory_id: '',
        },
      ],
      new Set([101]),
    );

    expect(memoryMiningResultSchema.parse(normalized)).toEqual({
      candidates: [
        expect.objectContaining({
          subjectType: 'group',
          subjectHandle: null,
          involvedHandles: ['@alice'],
          category: 'group_lore',
          normalizedText: 'la stampante è diventata il boss finale',
          confidence: 0.91,
          salience: 0.8,
          toxicity: 'clean',
          sourceMessageIds: [101],
          operation: 'new',
          targetMemoryId: null,
        }),
      ],
    });
  });

  it('does not coerce an unobserved evidence id or unsupported enum into validity', () => {
    const normalized = normalizeMemoryMiningCandidate(
      {
        candidates: {
          subjectType: 'community',
          category: 'group_lore',
          text: 'qualcosa',
          confidence: '0.9',
          salience: '0.8',
          toxicity: 'clean',
          sourceMessageIds: ['999'],
        },
      },
      new Set([101]),
    );
    const parsed = memoryMiningResultSchema.safeParse(normalized);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['candidates.0.subjectType', 'candidates.0.sourceMessageIds.0']),
      );
    }
  });
});

describe('MemoryItemsRepo.reinforce', () => {
  it('updates only through the atomic new-evidence guard', async () => {
    const updateOne = vi
      .fn()
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    const db = {
      collection: () => ({ updateOne }),
    } as unknown as Db;
    const repo = new MemoryItemsRepo(db);
    const id = '507f1f77bcf86cd799439011';

    expect(await repo.reinforce(id, [])).toBe(false);
    expect(updateOne).not.toHaveBeenCalled();

    expect(await repo.reinforce(id, [7, 7, -1, Number.NaN])).toBe(false);
    expect(await repo.reinforce(id, [8])).toBe(true);
    expect(updateOne).toHaveBeenCalledTimes(2);

    const [filter, pipeline] = updateOne.mock.calls[0] as [Record<string, unknown>, unknown[]];
    expect(filter).toMatchObject({ status: 'active' });
    expect(JSON.stringify(filter)).toContain('$setDifference');
    expect(JSON.stringify(filter)).toContain('[[7]');
    expect(JSON.stringify(pipeline)).toContain('$setUnion');
  });
});
