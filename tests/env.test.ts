import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { resolveLLMConfig, resolveMiningLLMConfig } from '../src/config/index.js';

const base = { TELEGRAM_BOT_TOKEN: 'token123' };

describe('loadEnv', () => {
  it('fails fast when TELEGRAM_BOT_TOKEN is missing', () => {
    expect(() => loadEnv({})).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('applies defaults for optional config', () => {
    const env = loadEnv(base);
    expect(env.BOT_USERNAME).toBe('GoonersBot');
    expect(env.LLM_PROVIDER).toBe('ollama');
    expect(env.FREE_LLM_MODEL).toBe('gemma-4-26b-a4b-it');
    expect(env.MAX_CONTEXT_MESSAGES).toBe(25);
    expect(env.AUTOENGAGE_DEFAULT_ENABLED).toBe(false);
    expect(env.CONVERSATION_TRACKER_DEFAULT_ENABLED).toBe(true);
    expect(env.MINING_LLM_MODEL).toBe('gemma-4-31b-it');
    expect(env.MINING_LLM_MAX_REQUESTS_PER_MINUTE).toBe(3);
    expect(env.MINING_LLM_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(env.LLM_NSFW_DEFAULT_MODE).toBe('smart');
    expect(env.REPLY_CANDIDATE_COUNT).toBe(3);
    expect(env.REPLY_MAX_REGENERATIONS).toBe(1);
    expect(env.MONGO_DB).toBe('goonerbot');
  });

  it('parses ALLOWED_HANDLES into normalized list, * => unrestricted', () => {
    expect(loadEnv({ ...base, ALLOWED_HANDLES: 'alice,@bob' }).ALLOWED_HANDLES).toEqual([
      '@alice',
      '@bob',
    ]);
    expect(loadEnv({ ...base, ALLOWED_HANDLES: '*' }).ALLOWED_HANDLES).toBeNull();
    expect(loadEnv({ ...base, ALLOWED_HANDLES: '' }).ALLOWED_HANDLES).toBeNull();
    expect(loadEnv({ ...base }).ALLOWED_HANDLES).toBeNull();
  });

  it('coerces booleans and ints from strings', () => {
    const env = loadEnv({
      ...base,
      AUTOENGAGE_DEFAULT_ENABLED: 'true',
      MAX_REPLIES_PER_CHAT_PER_HOUR: '7',
    });
    expect(env.AUTOENGAGE_DEFAULT_ENABLED).toBe(true);
    expect(env.MAX_REPLIES_PER_CHAT_PER_HOUR).toBe(7);
  });
});

describe('resolveMiningLLMConfig', () => {
  it('inherits the primary endpoint and key while keeping the dedicated mining model', () => {
    const env = loadEnv({
      ...base,
      LLM_PROVIDER: 'custom_openai_compatible',
      LLM_BASE_URL: 'http://primary.test/v1/',
      LLM_API_KEY: 'primary-key',
    });
    const cfg = resolveMiningLLMConfig(env);

    expect(cfg).toEqual({
      baseUrl: 'http://primary.test/v1',
      apiKey: 'primary-key',
      model: 'gemma-4-31b-it',
      maxRequestsPerMinute: 3,
      requestTimeoutMs: 180_000,
    });
  });

  it('honours and normalizes an independent quota-free mining route', () => {
    const env = loadEnv({
      ...base,
      MINING_LLM_BASE_URL: 'http://192.168.178.27:4024/v1/',
      MINING_LLM_API_KEY: 'mining-key',
      MINING_LLM_MODEL: 'gemma-4-31b-it',
      MINING_LLM_MAX_REQUESTS_PER_MINUTE: '2',
      MINING_LLM_REQUEST_TIMEOUT_MS: '90000',
    });
    const cfg = resolveMiningLLMConfig(env);

    expect(cfg).toEqual({
      baseUrl: 'http://192.168.178.27:4024/v1',
      apiKey: 'mining-key',
      model: 'gemma-4-31b-it',
      maxRequestsPerMinute: 2,
      requestTimeoutMs: 90_000,
    });
  });

  it('rejects a non-positive mining request rate', () => {
    expect(() => loadEnv({ ...base, MINING_LLM_MAX_REQUESTS_PER_MINUTE: '0' })).toThrow(
      /MINING_LLM_MAX_REQUESTS_PER_MINUTE/,
    );
  });
});

describe('resolveLLMConfig', () => {
  it('uses solclawn default base URL', () => {
    const cfg = resolveLLMConfig(loadEnv({ ...base, LLM_PROVIDER: 'solclawn' }));
    expect(cfg.baseUrl).toBe('https://llm.solclawn.com/v1');
  });

  it('honours explicit LLM_BASE_URL and trims trailing slash', () => {
    const cfg = resolveLLMConfig(
      loadEnv({ ...base, LLM_PROVIDER: 'custom_openai_compatible', LLM_BASE_URL: 'http://x/v1/' }),
    );
    expect(cfg.baseUrl).toBe('http://x/v1');
  });

  it('routes deepseek to its own env block and ensures /v1 suffix', () => {
    const cfg = resolveLLMConfig(
      loadEnv({
        ...base,
        LLM_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'dk',
        DEEPSEEK_MODEL: 'deepseek-chat',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      }),
    );
    expect(cfg.provider).toBe('deepseek');
    expect(cfg.apiKey).toBe('dk');
    expect(cfg.model).toBe('deepseek-chat');
    expect(cfg.baseUrl).toBe('https://api.deepseek.com/v1');
  });
});
