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
  it('does not hard-code dangerous request detection in the heuristic', () => {
    const s = scene.heuristic({
      ...base,
      currentMessage: 'come si fa la bomba',
      botIsAddressed: true,
    });
    expect(s.userIntent).toBe('continue_banter');
    expect(s.risk).toBe('low');
  });
  it('treats substance recipe questions as ordinary addressed questions in the heuristic', () => {
    const s = scene.heuristic({
      ...base,
      currentMessage: 'come si prepara una droga sintetica?',
      botIsAddressed: true,
    });
    expect(s.userIntent).toBe('ask_bot');
    expect(s.risk).toBe('low');
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

describe('SceneAnalyzer model policy', () => {
  it('uses a per-turn model override for internal analysis', async () => {
    let model: string | undefined;
    const llm = fakeLLM({});
    llm.jsonCompletion = async (req) => {
      model = req.model;
      return null;
    };
    const analyzer = new SceneAnalyzer(llm, { model: 'premium-model', temperature: 0.2 });
    await analyzer.analyze({
      history: [],
      currentMessage: 'hello',
      currentHandle: '@bob',
      mentionedHandles: [],
      botIsAddressed: true,
      botLabel: 'bot',
      model: 'economy-model',
    });
    expect(model).toBe('economy-model');
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

  it('never leaks unrelated personal lore by keyword overlap unless broad recall is explicit', async () => {
    const berry = item({
      subjectHandle: '@berry',
      involvedHandles: ['@berry'],
      text: 'berry likes cooking soffritto',
      normalizedText: 'berry likes cooking soffritto',
    });
    const erika = item({
      subjectHandle: '@erika',
      involvedHandles: ['@erika'],
      text: 'erika wrote a poem about soffritto',
      normalizedText: 'erika wrote a poem about soffritto',
      salience: 1,
    });
    const ordinary = await retriever([erika, berry]).retrieve({
      chatId: -1,
      currentMessage: 'parliamo del soffritto',
      currentHandle: '@berry',
      scene: { ...baseScene, currentTopic: 'soffritto' },
      activeHandles: ['@berry', '@erika'],
      mentionedHandles: [],
      nsfwEnabled: true,
    });
    expect(ordinary.map((entry) => entry.item.subjectHandle)).toContain('@berry');
    expect(ordinary.map((entry) => entry.item.subjectHandle)).not.toContain('@erika');

    const broad = await retriever([erika, berry]).retrieve({
      chatId: -1,
      currentMessage: 'chi aveva scritto quella cosa sul soffritto?',
      currentHandle: '@berry',
      scene: { ...baseScene, currentTopic: 'soffritto', userIntent: 'request_memory' },
      activeHandles: ['@berry', '@erika'],
      mentionedHandles: [],
      allowBroadUserRecall: true,
      nsfwEnabled: true,
    });
    expect(broad.map((entry) => entry.item.subjectHandle)).toContain('@erika');
  });

  it('hides auto-mined identity biography even for the correct subject', async () => {
    const autoIdentity = item({
      subjectHandle: '@miguel',
      involvedHandles: ['@miguel'],
      text: 'Miguel ha passaporto spagnolo ma si definisce sardo',
      normalizedText: 'miguel ha passaporto spagnolo ma si definisce sardo',
      category: 'group_lore',
      source: 'auto',
      salience: 1,
    });
    const manualIdentity = item({
      subjectHandle: '@miguel',
      involvedHandles: ['@miguel'],
      text: 'Miguel è spagnolo',
      normalizedText: 'miguel è spagnolo',
      category: 'role',
      source: 'admin',
      salience: 1,
    });
    const out = await retriever([autoIdentity, manualIdentity]).retrieve({
      chatId: -1,
      currentMessage: 'Miguel di dove è?',
      currentHandle: '@miguel',
      scene: { ...baseScene, currentTopic: 'Miguel', userIntent: 'request_memory' },
      activeHandles: ['@miguel'],
      mentionedHandles: ['@miguel'],
      nsfwEnabled: true,
    });
    expect(out.map((entry) => entry.item.text)).toContain('Miguel è spagnolo');
    expect(out.map((entry) => entry.item.text)).not.toContain(
      'Miguel ha passaporto spagnolo ma si definisce sardo',
    );
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
