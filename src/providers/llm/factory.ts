import type { EmbeddingsConfig, LLMConfig, MiningLLMConfig } from '../../config/index.js';
import { childLogger } from '../../utils/logger.js';
import { DeepSeekProvider } from './deepseek.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { FallbackLLMProvider } from './fallback.js';
import type { ChatRequest, ChatResult, LLMProvider } from './types.js';
import { MiningRequestPacer } from './miningPacer.js';

const log = childLogger('llm-factory');
const MINING_TRANSIENT_FAILURE_COOLDOWN_MS = 60_000;

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && parts.length < 5) {
    seen.add(current);
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current =
      typeof current === 'object' && current !== null && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return parts.join(' | ');
}

function isTransientMiningFailure(error: unknown): boolean {
  return /(?:timed?\s*out|fetch failed|econn(?:refused|reset)|eai_again|enotfound|socket|network|chat completion failed \((?:408|425|429|5\d\d)\))/i.test(
    errorChainText(error),
  );
}

/**
 * A client abort does not guarantee that a remote inference queue stopped generating. Keep the
 * dedicated miner quiet briefly after a transient failure so the scheduler and historical
 * backfill cannot immediately hand the same congested gateway another expensive 31B request.
 */
class ContinuousMiningProvider extends OpenAICompatibleProvider {
  private unavailableUntil = 0;
  private readonly pacer: MiningRequestPacer;

  constructor(
    options: ConstructorParameters<typeof OpenAICompatibleProvider>[0],
    maxRequestsPerMinute: number,
  ) {
    super(options);
    this.pacer = new MiningRequestPacer({ maxRequestsPerMinute });
  }

  private assertAvailable(): void {
    const remainingMs = this.unavailableUntil - Date.now();
    if (remainingMs > 0) {
      throw new Error(`continuous mining provider cooling down for ${remainingMs}ms`);
    }
  }

  private async paced<T>(signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
    return this.pacer.run(
      async () => {
        try {
          return await request();
        } catch (err) {
          if (isTransientMiningFailure(err)) {
            this.unavailableUntil = Date.now() + MINING_TRANSIENT_FAILURE_COOLDOWN_MS;
            log.warn(
              { err, cooldownMs: MINING_TRANSIENT_FAILURE_COOLDOWN_MS },
              'dedicated mining provider entered transient-failure cooldown',
            );
          }
          throw err;
        }
      },
      { beforeStart: () => this.assertAvailable(), signal },
    );
  }

  override chatCompletion(req: ChatRequest): Promise<ChatResult> {
    return this.paced(req.signal, () => super.chatCompletion(req));
  }

  override async *streamChatCompletion(req: ChatRequest): AsyncGenerator<string, ChatResult, void> {
    // The miner does not currently stream, but keeping this surface behind the same gate prevents a
    // future caller from accidentally bypassing the provider-wide invariant.
    const buffered = await this.paced(req.signal, async () => {
      const chunks: string[] = [];
      const stream = super.streamChatCompletion(req);
      for (;;) {
        const step = await stream.next();
        if (step.done) return { chunks, result: step.value };
        chunks.push(step.value);
      }
    });
    for (const chunk of buffered.chunks) yield chunk;
    return buffered.result;
  }
}

/**
 * Select and construct the LLM provider based on resolved config (env-driven).
 * The host (e.g. llm.solclawn.com) is never hardcoded here - it arrives via LLMConfig.baseUrl.
 */
export function createLLMProvider(cfg: LLMConfig, embeddings?: EmbeddingsConfig): LLMProvider {
  const base = {
    baseUrl: cfg.baseUrl,
    forwardGroupPlan: true,
    apiKey: cfg.apiKey,
    chatModel: cfg.model,
    visionModel: cfg.visionModel,
    visionBaseUrl: cfg.visionBaseUrl,
    visionEndpointUrl: cfg.visionEndpointUrl,
    visionApiKey: cfg.visionApiKey,
    nsfwModel: cfg.nsfwModel,
    nsfwBaseUrl: cfg.nsfwBaseUrl,
    nsfwApiKey: cfg.nsfwApiKey,
    imageModel: cfg.imageModel,
    transcriptionModel: cfg.transcriptionModel,
    ttsModel: cfg.ttsModel,
    embeddingModel: embeddings?.enabled ? embeddings.model : undefined,
    embeddingBaseUrl: embeddings?.enabled ? embeddings.baseUrl : undefined,
    embeddingApiKey: embeddings?.enabled ? embeddings.apiKey : undefined,
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
      forwardGroupPlan: cfg.fallback.baseUrl === cfg.baseUrl,
      apiKey: cfg.fallback.apiKey,
      chatModel: cfg.fallback.model,
      visionModel: undefined,
      visionEndpointUrl: undefined,
      imageModel: undefined,
      transcriptionModel: undefined,
      ttsModel: undefined,
      embeddingModel: embeddings?.enabled ? embeddings.model : undefined,
      embeddingBaseUrl: embeddings?.enabled ? embeddings.baseUrl : undefined,
      embeddingApiKey: embeddings?.enabled ? embeddings.apiKey : undefined,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
    log.info(
      { primary: provider.name, fallbackModel: cfg.fallback.model, baseUrl: cfg.fallback.baseUrl },
      'LLM fallback endpoint enabled',
    );
    provider = new FallbackLLMProvider(provider, fallbackProvider);
  }

  for (const endpoint of cfg.freeFallbacks) {
    const fallbackProvider = new OpenAICompatibleProvider({
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      forwardGroupPlan: endpoint.baseUrl === cfg.baseUrl,
      apiKey: endpoint.apiKey,
      chatModel: endpoint.model,
      visionModel: undefined,
      visionEndpointUrl: undefined,
      imageModel: undefined,
      transcriptionModel: undefined,
      ttsModel: undefined,
      embeddingModel: undefined,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
    log.info(
      { provider: endpoint.name, model: endpoint.model, baseUrl: endpoint.baseUrl },
      'free-tier LLM fallback enabled',
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
  for (const cap of ['vision', 'transcription', 'imageGeneration', 'tts', 'embeddings'] as const) {
    if (!provider.capabilities[cap]) {
      log.info({ capability: cap }, 'capability not configured - will degrade gracefully');
    }
  }
  return provider;
}

/**
 * Continuous learning has its own explicit model and no conversation-plan header/capabilities.
 * This keeps background extraction off the paid/interactive routing path.
 */
export function createMiningLLMProvider(cfg: MiningLLMConfig): LLMProvider {
  const provider = new ContinuousMiningProvider(
    {
      name: 'continuous-miner',
      baseUrl: cfg.baseUrl,
      forwardGroupPlan: false,
      allowRequestModelOverride: false,
      meterUsage: false,
      apiKey: cfg.apiKey,
      chatModel: cfg.model,
      visionModel: undefined,
      visionEndpointUrl: undefined,
      imageModel: undefined,
      transcriptionModel: undefined,
      ttsModel: undefined,
      embeddingModel: undefined,
      requestTimeoutMs: cfg.requestTimeoutMs,
    },
    cfg.maxRequestsPerMinute,
  );
  log.info(
    {
      provider: provider.name,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      maxRequestsPerMinute: cfg.maxRequestsPerMinute,
    },
    'dedicated continuous-mining LLM initialized',
  );
  return provider;
}
