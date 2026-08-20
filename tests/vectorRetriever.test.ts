import { describe, expect, it } from 'vitest';
import type { SceneAnalysis } from '../src/brain/types.js';
import type { Embedder } from '../src/rag/embedder.js';
import { VectorMemoryRetriever } from '../src/memory/vectorRetriever.js';
import { jaccard } from '../src/memory/memoryDeduper.js';
import type { MemoryItem } from '../src/memory/types.js';
import type { Storage } from '../src/storage/index.js';

const now = new Date();

function item(over: Partial<MemoryItem>): MemoryItem {
  return {
    _id: Math.random().toString(36).slice(2),
    chatId: -1,
    subjectType: 'user',
    subjectHandle: '@x',
    involvedHandles: ['@x'],
    text: 'placeholder',
    normalizedText: 'placeholder',
    category: 'role',
    source: 'manual_extract',
    sourceMessageIds: [],
    createdByHandle: '@admin',
    confidence: 0.9,
    salience: 0.7,
    toxicity: 'clean',
    status: 'active',
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    useCount: 0,
    positiveFeedbackCount: 0,
    negativeFeedbackCount: 0,
    tags: [],
    ...over,
  };
}

const scene: SceneAnalysis = {
  currentTopic: 'who runs infrastructure',
  energy: 'medium',
  humorStyle: [],
  activeUsers: [],
  mentionedUsers: [],
  openThreads: [],
  botIsBeingAddressed: true,
  botIsBeingCriticized: false,
  userIntent: 'request_memory',
  shouldUseMemory: true,
  shouldBeDefensive: false,
  bestAngle: '',
  risk: 'low',
};

describe('VectorMemoryRetriever', () => {
  it('recalls a paraphrased memory by cosine where token overlap would miss', async () => {
    const serverMemory = item({
      subjectHandle: '@0xfunboy',
      text: '0xfunboy maintains deployment infrastructure and production services',
      normalizedText: '0xfunboy maintains deployment infrastructure and production services',
      embedding: [1, 0, 0],
    });
    const unrelated = item({
      subjectHandle: '@alice',
      text: 'alice is obsessed with horror manga',
      normalizedText: 'alice is obsessed with horror manga',
      embedding: [0, 1, 0],
    });
    const storage = {
      memoryItems: {
        async listActive() {
          return [serverMemory, unrelated];
        },
      },
    } as unknown as Storage;
    const embedder: Embedder = {
      enabled: true,
      async embed() {
        return [[1, 0, 0]];
      },
    };
    expect(jaccard(serverMemory.text, 'who is the server guy?')).toBe(0);
    const retriever = new VectorMemoryRetriever(storage, embedder, {
      maxItems: 3,
      maxExplicitCallbacks: 1,
      itemCooldownMinutes: 45,
      subjectCooldownMinutes: 20,
      embeddingDim: 3,
      minScore: 0.3,
    });
    const out = await retriever.retrieve({
      chatId: -1,
      currentMessage: 'who is the server guy?',
      scene,
      activeHandles: [],
      mentionedHandles: [],
      allowBroadUserRecall: true,
      nsfwEnabled: true,
    });
    expect(out[0]?.item.subjectHandle).toBe('@0xfunboy');
    expect(out[0]?.cosineScore).toBeGreaterThan(0.9);
    expect(out[0]?.reason).toContain('cos');
  });

  it('hides auto-mined identity biography even when embedding similarity is perfect', async () => {
    const unsafeIdentity = item({
      subjectHandle: '@miguel',
      involvedHandles: ['@miguel'],
      text: 'Miguel ha passaporto spagnolo ma si definisce sardo',
      normalizedText: 'miguel ha passaporto spagnolo ma si definisce sardo',
      category: 'group_lore',
      source: 'auto',
      embedding: [1, 0, 0],
    });
    const storage = {
      memoryItems: {
        async listActive() {
          return [unsafeIdentity];
        },
      },
    } as unknown as Storage;
    const embedder: Embedder = {
      enabled: true,
      async embed() {
        return [[1, 0, 0]];
      },
    };
    const retriever = new VectorMemoryRetriever(storage, embedder, {
      maxItems: 3,
      maxExplicitCallbacks: 1,
      itemCooldownMinutes: 45,
      subjectCooldownMinutes: 20,
      embeddingDim: 3,
      minScore: 0.3,
    });
    const out = await retriever.retrieve({
      chatId: -1,
      currentMessage: 'Miguel di dove è?',
      currentHandle: '@miguel',
      scene: { ...scene, currentTopic: 'Miguel' },
      activeHandles: ['@miguel'],
      mentionedHandles: ['@miguel'],
      nsfwEnabled: true,
    });
    expect(out).toEqual([]);
  });

  it('does not let embeddings move an unrelated user memory into another person turn', async () => {
    const berryMemory = item({
      subjectHandle: '@berry',
      involvedHandles: ['@berry'],
      text: 'berry talks about cooking',
      normalizedText: 'berry talks about cooking',
      embedding: [0.8, 0.2, 0],
    });
    const johnnyMemory = item({
      subjectHandle: '@johnny',
      involvedHandles: ['@johnny'],
      text: 'johnny compares supermarket offers with spreadsheets',
      normalizedText: 'johnny compares supermarket offers with spreadsheets',
      salience: 1,
      embedding: [1, 0, 0],
    });
    const storage = {
      memoryItems: {
        async listActive() {
          return [johnnyMemory, berryMemory];
        },
      },
    } as unknown as Storage;
    const embedder: Embedder = {
      enabled: true,
      async embed() {
        return [[1, 0, 0]];
      },
    };
    const retriever = new VectorMemoryRetriever(storage, embedder, {
      maxItems: 3,
      maxExplicitCallbacks: 1,
      itemCooldownMinutes: 45,
      subjectCooldownMinutes: 20,
      embeddingDim: 3,
      minScore: 0.3,
    });
    const out = await retriever.retrieve({
      chatId: -1,
      currentMessage: 'berry mi hai preso per johnny?',
      currentHandle: '@berry',
      scene: { ...scene, userIntent: 'continue_banter', currentTopic: 'johnny' },
      activeHandles: ['@berry', '@johnny'],
      mentionedHandles: [],
      nsfwEnabled: true,
    });
    expect(out.map((entry) => entry.item.subjectHandle)).toContain('@berry');
    expect(out.map((entry) => entry.item.subjectHandle)).not.toContain('@johnny');
  });
});
