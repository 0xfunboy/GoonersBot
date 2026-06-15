import { describe, expect, it } from 'vitest';
import { jaccard, findDuplicate } from '../src/memory/memoryDeduper.js';
import { MemoryMiner, isSensitiveMemory } from '../src/memory/memoryMiner.js';
import type { LLMProvider } from '../src/providers/llm/types.js';
import type { MemoryCandidate, MemoryItem } from '../src/memory/types.js';

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
          normalizedText: 'x y z totally other',
          text: 'x y z totally other',
        }),
        [item()],
      ),
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
      model: 'm',
      temperature: 0.1,
      maxCandidates: 5,
      minSalience: 0.45,
    });
  }

  it('filters blocked, sensitive, low-confidence, low-salience', async () => {
    const m = miner({
      candidates: [
        cand({ text: 'good lore', normalizedText: 'good lore', confidence: 0.9, salience: 0.8 }),
        cand({ text: 'blocked one', normalizedText: 'blocked one', toxicity: 'blocked' }),
        cand({ text: 'his password is hunter2', normalizedText: 'his password is hunter2' }),
        cand({ text: 'low conf', normalizedText: 'low conf', confidence: 0.2 }),
        cand({ text: 'low sal', normalizedText: 'low sal', salience: 0.1 }),
      ],
    });
    const out = await m.extractCandidates({
      messages: [
        { handle: '@bob', isBot: false, message: { messageText: 'hi', timestamp: new Date() } },
      ],
      existingMemories: [],
      language: 'italian',
      nsfwEnabled: true,
      minConfidence: 0.62,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('good lore');
  });

  it('returns [] when the model yields nothing', async () => {
    const m = miner(null);
    const out = await m.extractCandidates({
      messages: [
        { handle: '@bob', isBot: false, message: { messageText: 'hi', timestamp: new Date() } },
      ],
      existingMemories: [],
      language: 'italian',
      nsfwEnabled: false,
      minConfidence: 0.62,
    });
    expect(out).toEqual([]);
  });
});
