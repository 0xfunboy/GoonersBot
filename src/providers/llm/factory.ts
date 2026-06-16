import type { LLMConfig } from '../../config/index.js';
import { childLogger } from '../../utils/logger.js';
import { DeepSeekProvider } from './deepseek.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { FallbackLLMProvider } from './fallback.js';
import type { LLMProvider } from './types.js';

const log = childLogger('llm-factory');

/**
 * Select and construct the LLM provider based on resolved config (env-driven).
 * The host (e.g. llm.solclawn.com) is never hardcoded here - it arrives via LLMConfig.baseUrl.
 */
export function createLLMProvider(cfg: LLMConfig): LLMProvider {
  const base = {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    chatModel: cfg.model,
    visionModel: cfg.visionModel,
    visionBaseUrl: cfg.visionBaseUrl,
    visionApiKey: cfg.visionApiKey,
    imageModel: cfg.imageModel,
    transcriptionModel: cfg.transcriptionModel,
    ttsModel: cfg.ttsModel,
    requestTimeoutMs: cfg.requestTimeoutMs,
  };

  let provider: LLMProvider;
  switch (cfg.provider) {
    case 'deepseek':
      provider = new DeepSeekProvider(base);
      break;
    case 'solclawn':
    case 'openai':
    case 'ollama':
    case 'custom_openai_compatible':
      provider = new OpenAICompatibleProvider({ ...base, name: cfg.provider });
      break;
    default: {
      const exhaustive: never = cfg.provider;
      throw new Error(`unknown LLM provider: ${String(exhaustive)}`);
    }
  }

  // Optional fallback chat endpoint (e.g. local Ollama gpt-oss on the GPU box): used when the
  // primary throws. Wrap the primary so it's transparent to every caller.
  if (cfg.fallback) {
    const fallbackProvider = new OpenAICompatibleProvider({
      name: 'fallback',
      baseUrl: cfg.fallback.baseUrl,
      apiKey: cfg.fallback.apiKey,
      chatModel: cfg.fallback.model,
      visionModel: undefined,
      imageModel: undefined,
      transcriptionModel: undefined,
      ttsModel: undefined,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
    log.info(
      { primary: provider.name, fallbackModel: cfg.fallback.model, baseUrl: cfg.fallback.baseUrl },
      'LLM fallback endpoint enabled',
    );
    provider = new FallbackLLMProvider(provider, fallbackProvider);
  }

  log.info(
    { provider: provider.name, baseUrl: cfg.baseUrl, capabilities: provider.capabilities },
    'LLM provider initialized',
  );
  if (!provider.capabilities.chat) {
    log.warn(
      'LLM chat model is not configured (LLM_MODEL/DEEPSEEK_MODEL). Text replies will fail until set.',
    );
  }
  for (const cap of ['vision', 'transcription', 'imageGeneration', 'tts'] as const) {
    if (!provider.capabilities[cap]) {
      log.info({ capability: cap }, 'capability not configured - will degrade gracefully');
    }
  }
  return provider;
}
