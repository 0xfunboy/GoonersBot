import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { resolveLLMConfig } from '../src/config/index.js';

const base = { TELEGRAM_BOT_TOKEN: 'token123' };

describe('loadEnv', () => {
  it('fails fast when TELEGRAM_BOT_TOKEN is missing', () => {
    expect(() => loadEnv({})).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('applies defaults for optional config', () => {
    const env = loadEnv(base);
    expect(env.BOT_USERNAME).toBe('GoonersBot');
    expect(env.LLM_PROVIDER).toBe('ollama');
    expect(env.FREE_LLM_MODEL).toBe('gemma4:31b');
    expect(env.MAX_CONTEXT_MESSAGES).toBe(25);
    expect(env.AUTOENGAGE_DEFAULT_ENABLED).toBe(false);
    expect(env.CONVERSATION_TRACKER_DEFAULT_ENABLED).toBe(true);
    expect(env.AUTOFACT_DEFAULT_ENABLED).toBe(false);
    expect(env.LLM_NSFW_DEFAULT_MODE).toBe('smart');
    expect(env.REPLY_CANDIDATE_COUNT).toBe(1);
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
