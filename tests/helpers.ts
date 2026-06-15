import type { Storage } from '../src/storage/index.js';
import type { LLMProvider, AutoEngageScore } from '../src/providers/llm/types.js';

/** Build a partial Storage fake; only the methods a test touches need to be provided. */
export function fakeStorage(overrides: Record<string, unknown>): Storage {
  return overrides as unknown as Storage;
}

/** A minimal in-memory bans repo honouring expiry (mirrors BansRepo semantics). */
export function inMemoryBans() {
  const map = new Map<string, { until: number | null }>();
  return {
    async ban(handle: string, seconds: number) {
      map.set(handle, { until: seconds > 0 ? Date.now() + seconds * 1000 : null });
    },
    async unban(handle: string) {
      map.delete(handle);
    },
    async isBanned(handle: string, now: Date = new Date()) {
      const e = map.get(handle);
      if (!e) return false;
      if (e.until === null) return true;
      if (e.until > now.getTime()) return true;
      map.delete(handle);
      return false;
    },
  };
}

/** A fake LLM provider for autoengage/reply tests. */
export function fakeLLM(opts: {
  score?: Partial<AutoEngageScore>;
  capabilities?: Partial<LLMProvider['capabilities']>;
}): LLMProvider {
  const score: AutoEngageScore = {
    shouldReply: true,
    confidence: 0.9,
    reason: 'test',
    suggestedTone: 'neutral',
    risk: 'low',
    ...opts.score,
  };
  return {
    name: 'fake',
    capabilities: {
      chat: true,
      vision: false,
      transcription: false,
      imageGeneration: false,
      tts: false,
      ...opts.capabilities,
    },
    async chatCompletion() {
      return { text: 'hi', usage: { estimated: true }, model: 'fake' };
    },
    async *streamChatCompletion() {
      yield 'hi';
      return { text: 'hi', usage: { estimated: true }, model: 'fake' };
    },
    async extractFacts() {
      return [];
    },
    async scoreAutoEngage() {
      return score;
    },
    async jsonCompletion() {
      return null;
    },
  };
}
