import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import {
  resolveAnimeArchiveConfig,
  resolveLLMConfig,
  resolveMiningLLMConfig,
} from '../src/config/index.js';

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
    expect(env.MINING_LLM_MAX_TOKENS_PER_MINUTE).toBe(15_000);
    expect(env.MINING_LLM_FOREGROUND_QUIET_MS).toBe(15_000);
    expect(env.MINING_LLM_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(env.MEMORY_MINING_MAX_WINDOW_BYTES).toBe(12_000);
    expect(env.LLM_NSFW_DEFAULT_MODE).toBe('smart');
    expect(env.REPLY_CANDIDATE_COUNT).toBe(3);
    expect(env.REPLY_MAX_REGENERATIONS).toBe(1);
    expect(env.MONGO_DB).toBe('goonerbot');
    expect(env.TELEGRAM_API_ROOT).toBeUndefined();
    expect(env.LINK_MEDIA_COOKIES_FILE).toBeUndefined();
    expect(env.LINK_MEDIA_EXTRA_YTDLP_HOSTS).toBeUndefined();
    expect(env.LINK_MEDIA_YTDLP_NETWORK_ISOLATION).toBe(true);
    expect(env.LINK_MEDIA_BWRAP_BIN).toBe('/usr/bin/bwrap');
    expect(env.ANIME_ARCHIVE_ENABLED).toBe(true);
    expect(env.ANIME_ARCHIVE_BULK_ENABLED).toBe(true);
    expect(env.ANIME_ARCHIVE_MAX_UPLOAD_MB).toBe(45);
    expect(env.ANIME_ARCHIVE_BULK_CONCURRENCY).toBe(1);
    expect(env.SOCIAL_QUESTIONS_ENABLED).toBe(true);
    expect(env.SOCIAL_QUESTION_CURIOSITY_PROBABILITY).toBe(0.1);
    expect(env.SOCIAL_QUESTION_USER_COOLDOWN_MINUTES).toBe(720);
    expect(env.SOCIAL_QUESTION_TTL_MINUTES).toBe(30);
    expect(env.SOCIAL_QUESTION_UNQUOTED_ANSWER_WINDOW_MINUTES).toBe(8);
    expect(env.CAPABILITY_LOCAL_DEVELOPMENT_ENABLED).toBe(false);
    expect(env.CAPABILITY_LOCAL_DEVELOPMENT_ADMIN_IDS).toEqual([]);
    expect(env.CAPABILITY_LOCAL_DEVELOPMENT_PLANNER_MODEL).toBe('gemini-3.6-flash');
    expect(env.CAPABILITY_LOCAL_DEVELOPMENT_CODER_MODEL).toBe('qwen/qwen3.5-397b-a17b');
    expect(env.CAPABILITY_LOCAL_DEVELOPMENT_REVIEW_MODEL).toBe('nvidia/nemotron-3-super-120b-a12b');
  });

  it('keeps long-form anime limits independent and forces sequential bulk work', () => {
    const cfg = resolveAnimeArchiveConfig(
      loadEnv({
        ...base,
        ANIME_ARCHIVE_MAX_DURATION_SECONDS: '9000',
        ANIME_ARCHIVE_MAX_DOWNLOAD_MB: '512',
        ANIME_ARCHIVE_MAX_UPLOAD_MB: '1900',
        ANIME_ARCHIVE_BULK_CONCURRENCY: '9',
      }),
    );
    expect(cfg).toMatchObject({
      enabled: true,
      bulkEnabled: true,
      maxDurationSeconds: 9_000,
      maxDownloadBytes: 512 * 1024 * 1024,
      maxUploadBytes: 1_900 * 1024 * 1024,
      bulkConcurrency: 1,
    });
  });

  it('caps anime archive resource limits even when deployment values are unsafe', () => {
    const cfg = resolveAnimeArchiveConfig(
      loadEnv({
        ...base,
        ANIME_ARCHIVE_MAX_DURATION_SECONDS: '999999999',
        ANIME_ARCHIVE_MAX_DOWNLOAD_MB: '999999999',
        ANIME_ARCHIVE_MAX_UPLOAD_MB: '999999999',
        ANIME_ARCHIVE_TIMEOUT_MS: '999999999',
      }),
    );
    expect(cfg.maxDurationSeconds).toBe(6 * 60 * 60);
    expect(cfg.maxDownloadBytes).toBe(4_096 * 1024 * 1024);
    expect(cfg.maxUploadBytes).toBe(2_000 * 1024 * 1024);
    expect(cfg.timeoutMs).toBe(2 * 60 * 60_000);
  });

  it('normalizes link-media cookie/runtime configuration', () => {
    const env = loadEnv({
      ...base,
      LINK_MEDIA_COOKIES_FILE: ' data/link-media.cookies.txt ',
      LINK_MEDIA_COOKIES_INSTAGRAM: ' sessionid=test ',
      LINK_MEDIA_YTDLP_JS_RUNTIME: ' deno:/usr/bin/deno ',
      LINK_MEDIA_EXTRA_YTDLP_HOSTS: 'videos.example, clips.example',
    });
    expect(env.LINK_MEDIA_COOKIES_FILE).toBe('data/link-media.cookies.txt');
    expect(env.LINK_MEDIA_COOKIES_INSTAGRAM).toBe('sessionid=test');
    expect(env.LINK_MEDIA_YTDLP_JS_RUNTIME).toBe('deno:/usr/bin/deno');
    expect(env.LINK_MEDIA_EXTRA_YTDLP_HOSTS).toBe('videos.example, clips.example');
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

  it('parses immutable local-development admin ids and bounds worker settings', () => {
    const env = loadEnv({
      ...base,
      CAPABILITY_LOCAL_DEVELOPMENT_ENABLED: 'true',
      CAPABILITY_LOCAL_DEVELOPMENT_ADMIN_IDS: '123,456',
      CAPABILITY_LOCAL_DEVELOPMENT_MAX_ATTEMPTS: '3',
      CAPABILITY_LOCAL_DEVELOPMENT_JOB_TIMEOUT_MS: '60000',
    });
    expect(env.CAPABILITY_LOCAL_DEVELOPMENT_ENABLED).toBe(true);
    expect(env.CAPABILITY_LOCAL_DEVELOPMENT_ADMIN_IDS).toEqual([123, 456]);
    expect(env.CAPABILITY_LOCAL_DEVELOPMENT_MAX_ATTEMPTS).toBe(3);
    expect(env.CAPABILITY_LOCAL_DEVELOPMENT_JOB_TIMEOUT_MS).toBe(60_000);

    expect(() => loadEnv({ ...base, CAPABILITY_LOCAL_DEVELOPMENT_MAX_ATTEMPTS: '4' })).toThrow(
      /CAPABILITY_LOCAL_DEVELOPMENT_MAX_ATTEMPTS/,
    );
    for (const malformed of ['123abc', '123.9', '1e3', '-123', '0']) {
      expect(() => loadEnv({ ...base, CAPABILITY_LOCAL_DEVELOPMENT_ADMIN_IDS: malformed })).toThrow(
        /Telegram ID/,
      );
    }
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
      maxTokensPerMinute: 15_000,
      foregroundQuietMs: 15_000,
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
      MINING_LLM_MAX_TOKENS_PER_MINUTE: '12000',
      MINING_LLM_FOREGROUND_QUIET_MS: '5000',
      MINING_LLM_REQUEST_TIMEOUT_MS: '90000',
    });
    const cfg = resolveMiningLLMConfig(env);

    expect(cfg).toEqual({
      baseUrl: 'http://192.168.178.27:4024/v1',
      apiKey: 'mining-key',
      model: 'gemma-4-31b-it',
      maxRequestsPerMinute: 2,
      maxTokensPerMinute: 12_000,
      foregroundQuietMs: 5_000,
      requestTimeoutMs: 90_000,
    });
  });

  it('rejects a non-positive mining request rate', () => {
    expect(() => loadEnv({ ...base, MINING_LLM_MAX_REQUESTS_PER_MINUTE: '0' })).toThrow(
      /MINING_LLM_MAX_REQUESTS_PER_MINUTE/,
    );
  });

  it('rejects a non-positive mining token rate', () => {
    expect(() => loadEnv({ ...base, MINING_LLM_MAX_TOKENS_PER_MINUTE: '0' })).toThrow(
      /MINING_LLM_MAX_TOKENS_PER_MINUTE/,
    );
  });

  it('rejects a mining transcript byte budget below the safe minimum', () => {
    expect(() => loadEnv({ ...base, MEMORY_MINING_MAX_WINDOW_BYTES: '1000' })).toThrow(
      /MEMORY_MINING_MAX_WINDOW_BYTES/,
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
