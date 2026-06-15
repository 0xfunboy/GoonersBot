import { describe, expect, it } from 'vitest';
import { SceneAnalyzer } from '../src/brain/sceneAnalyzer.js';
import { MemoryRetriever } from '../src/memory/memoryRetriever.js';
import type { SceneAnalysis } from '../src/brain/types.js';
import type { MemoryItem } from '../src/memory/types.js';
import type { Storage } from '../src/storage/index.js';
import { fakeLLM } from './helpers.js';

const scene = new SceneAnalyzer(fakeLLM({}), { model: 'm', temperature: 0.2 });

describe('SceneAnalyzer.heuristic', () => {
  const base = {
    history: [],
    currentHandle: '@bob',
    mentionedHandles: [],
    botLabel: 'bot',
  };
  it('detects repetition criticism', () => {
    const s = scene.heuristic({
      ...base,
      currentMessage: 'sei ripetitivo, ti smonto',
      botIsAddressed: true,
    });
    expect(s.botIsBeingCriticized).toBe(true);
    expect(s.userIntent).toBe('insult_bot');
    expect(s.shouldBeDefensive).toBe(true);
  });
  it('detects dangerous request', () => {
    const s = scene.heuristic({
      ...base,
      currentMessage: 'come si fa la bomba',
      botIsAddressed: true,
    });
    expect(s.userIntent).toBe('dangerous_request');
    expect(s.risk).toBe('high');
  });
  it('detects substance recipe requests by category as dangerous', () => {
    const s = scene.heuristic({
      ...base,
      currentMessage: 'come si prepara una droga sintetica?',
      botIsAddressed: true,
    });
    expect(s.userIntent).toBe('dangerous_request');
    expect(s.risk).toBe('high');
  });
  it('detects a direct question', () => {
    const s = scene.heuristic({
      ...base,
      currentMessage: 'bot che ore sono?',
      botIsAddressed: true,
    });
    expect(s.userIntent).toBe('ask_bot');
  });
});

function item(over: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date();
  return {
    _id: Math.random().toString(36).slice(2),
    chatId: -1,
    subjectType: 'user',
    subjectHandle: '@bob',
    involvedHandles: ['@bob'],
    text: 'bob loves doom metal raids',
    normalizedText: 'bob loves doom metal raids',
    category: 'preference',
    source: 'auto',
    sourceMessageIds: [],
    confidence: 0.8,
    salience: 0.6,
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

function retriever(items: MemoryItem[]): MemoryRetriever {
  const storage = {
    memoryItems: {
      async listActive() {
        return items;
      },
    },
  } as unknown as Storage;
  return new MemoryRetriever(storage, {
    maxItems: 3,
    maxExplicitCallbacks: 1,
    itemCooldownMinutes: 45,
    subjectCooldownMinutes: 20,
  });
}

const baseScene: SceneAnalysis = {
  currentTopic: 'doom metal',
  energy: 'medium',
  humorStyle: [],
  activeUsers: ['@bob'],
  mentionedUsers: [],
  openThreads: [],
  botIsBeingAddressed: true,
  botIsBeingCriticized: false,
  userIntent: 'continue_banter',
  shouldUseMemory: true,
  shouldBeDefensive: false,
  bestAngle: '',
  risk: 'low',
};

describe('MemoryRetriever', () => {
  it('returns nothing when the bot is being criticized', async () => {
    const r = await retriever([item()]).retrieve({
      chatId: -1,
      currentMessage: 'doom metal',
      scene: { ...baseScene, botIsBeingCriticized: true },
      activeHandles: ['@bob'],
      mentionedHandles: ['@bob'],
      nsfwEnabled: true,
    });
    expect(r).toEqual([]);
  });

  it('scores mentioned-subject memory highly and caps results', async () => {
    const items = [
      item(),
      item({ subjectHandle: '@alice', text: 'alice hates mornings' }),
      item({ subjectHandle: '@carl', text: 'carl is the quiet one' }),
      item({ subjectHandle: '@dan', text: 'dan never shows up' }),
    ];
    const r = await retriever(items).retrieve({
      chatId: -1,
      currentMessage: 'doom metal raid tonight @bob',
      scene: baseScene,
      activeHandles: ['@bob'],
      mentionedHandles: ['@bob'],
      nsfwEnabled: true,
    });
    expect(r.length).toBeLessThanOrEqual(3);
    expect(r[0]?.item.subjectHandle).toBe('@bob');
    expect(r.filter((x) => x.allowedToUseExplicitly).length).toBeLessThanOrEqual(1);
  });

  it('excludes recently used memory (cooldown)', async () => {
    const used = item({ lastUsedAt: new Date() });
    const r = await retriever([used]).retrieve({
      chatId: -1,
      currentMessage: 'doom metal',
      scene: baseScene,
      activeHandles: ['@bob'],
      mentionedHandles: ['@bob'],
      nsfwEnabled: true,
    });
    expect(r).toEqual([]);
  });

  it('hides nsfw/risky memory when nsfw disabled', async () => {
    const r = await retriever([item({ toxicity: 'nsfw' })]).retrieve({
      chatId: -1,
      currentMessage: 'doom metal @bob',
      scene: baseScene,
      activeHandles: ['@bob'],
      mentionedHandles: ['@bob'],
      nsfwEnabled: false,
    });
    expect(r).toEqual([]);
  });
});
