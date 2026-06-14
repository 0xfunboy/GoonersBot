import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { resolveLLMConfig } from '../src/config/index.js';
import { createLLMProvider, safeJson } from '../src/providers/llm/index.js';

const base = { TELEGRAM_BOT_TOKEN: 't' };

describe('createLLMProvider', () => {
  it('selects solclawn via OpenAI-compatible adapter', () => {
    const p = createLLMProvider(
      resolveLLMConfig(loadEnv({ ...base, LLM_PROVIDER: 'solclawn', LLM_MODEL: 'qwen' })),
    );
    expect(p.name).toBe('solclawn');
    expect(p.capabilities.chat).toBe(true);
  });

  it('derives capabilities from configured models', () => {
    const p = createLLMProvider(
      resolveLLMConfig(
        loadEnv({
          ...base,
          LLM_PROVIDER: 'openai',
          LLM_MODEL: 'gpt',
          LLM_VISION_MODEL: 'gpt-vision',
          LLM_IMAGE_MODEL: 'dalle',
          LLM_TRANSCRIPTION_MODEL: 'whisper',
        }),
      ),
    );
    expect(p.capabilities).toMatchObject({
      chat: true,
      vision: true,
      imageGeneration: true,
      transcription: true,
    });
    expect(typeof p.visionCompletion).toBe('function');
    expect(typeof p.transcribeAudio).toBe('function');
    expect(typeof p.generateImage).toBe('function');
  });

  it('reports missing capabilities and removes their methods', () => {
    const p = createLLMProvider(
      resolveLLMConfig(loadEnv({ ...base, LLM_PROVIDER: 'ollama', LLM_MODEL: 'gemma' })),
    );
    expect(p.capabilities.vision).toBe(false);
    expect(p.visionCompletion).toBeUndefined();
    expect(p.generateImage).toBeUndefined();
  });

  it('builds the deepseek provider', () => {
    const p = createLLMProvider(
      resolveLLMConfig(
        loadEnv({ ...base, LLM_PROVIDER: 'deepseek', DEEPSEEK_MODEL: 'deepseek-chat' }),
      ),
    );
    expect(p.name).toBe('deepseek');
    expect(p.capabilities.chat).toBe(true);
  });
});

describe('safeJson', () => {
  it('parses plain JSON', () => {
    expect(safeJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses fenced JSON', () => {
    expect(safeJson<{ a: number }>('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('parses JSON embedded in prose', () => {
    expect(safeJson<{ ok: boolean }>('Sure: {"ok":true} done')).toEqual({ ok: true });
  });
  it('returns null on garbage', () => {
    expect(safeJson('no json here')).toBeNull();
  });
});
