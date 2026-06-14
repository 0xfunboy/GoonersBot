import type { Env, LLMProviderName } from './env.js';
import { getEnv } from './env.js';

export * from './env.js';
export * from './modes.js';
export * from './i18n.js';

/**
 * Resolved LLM provider configuration. `baseUrl`/`model` defaults depend on the provider.
 * Nothing here is hardcoded into business logic — these are config defaults only.
 */
export interface LLMConfig {
  provider: LLMProviderName;
  baseUrl: string;
  apiKey: string | undefined;
  model: string | undefined;
  visionModel: string | undefined;
  imageModel: string | undefined;
  transcriptionModel: string | undefined;
  ttsModel: string | undefined;
  requestTimeoutMs: number;
}

/** Default base URLs per provider. These are examples/defaults, overridable via env. */
const PROVIDER_DEFAULT_BASE_URL: Record<LLMProviderName, string> = {
  solclawn: 'https://llm.solclawn.com/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  custom_openai_compatible: 'http://127.0.0.1:8080/v1',
};

export function resolveLLMConfig(env: Env): LLMConfig {
  const provider = env.LLM_PROVIDER;

  // DeepSeek has its own dedicated env block; fall back to generic LLM_* otherwise.
  if (provider === 'deepseek') {
    const base = (env.DEEPSEEK_BASE_URL || PROVIDER_DEFAULT_BASE_URL.deepseek).replace(/\/+$/, '');
    const baseUrl = base.endsWith('/v1') ? base : `${base}/v1`;
    return {
      provider,
      baseUrl,
      apiKey: env.DEEPSEEK_API_KEY ?? env.LLM_API_KEY,
      model: env.DEEPSEEK_MODEL ?? env.LLM_MODEL,
      visionModel: env.LLM_VISION_MODEL,
      imageModel: env.LLM_IMAGE_MODEL,
      transcriptionModel: env.LLM_TRANSCRIPTION_MODEL,
      ttsModel: env.LLM_TTS_MODEL,
      requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    };
  }

  const baseUrl = (env.LLM_BASE_URL || PROVIDER_DEFAULT_BASE_URL[provider]).replace(/\/+$/, '');
  return {
    provider,
    baseUrl,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    visionModel: env.LLM_VISION_MODEL,
    imageModel: env.LLM_IMAGE_MODEL,
    transcriptionModel: env.LLM_TRANSCRIPTION_MODEL,
    ttsModel: env.LLM_TTS_MODEL,
    requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
  };
}

export interface AppConfig {
  env: Env;
  llm: LLMConfig;
}

export function loadConfig(): AppConfig {
  const env = getEnv();
  return {
    env,
    llm: resolveLLMConfig(env),
  };
}
