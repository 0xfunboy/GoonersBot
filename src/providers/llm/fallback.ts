import { childLogger } from '../../utils/logger.js';
import type {
  AutoEngageScore,
  ChatRequest,
  ChatResult,
  ExtractFactsRequest,
  Fact,
  ImageRequest,
  ImageResult,
  JsonRequest,
  LLMProvider,
  ProviderCapabilities,
  ScoreAutoEngageRequest,
  TranscribeRequest,
  VisionRequest,
} from './types.js';

const log = childLogger('llm-fallback');

/**
 * Wraps a primary LLM provider with a fallback one: if a primary chat/reasoning call throws
 * (timeout, connection refused, 5xx…), the same call is retried on the fallback provider. This is
 * transparent to every caller (it implements LLMProvider).
 *
 * Capability methods (vision/transcription/image) and capabilities are taken from the PRIMARY -
 * those backends are configured independently and the fallback is meant for chat resilience.
 * Streaming falls back only if the primary fails before emitting any chunk (a mid-stream failure
 * can't be cleanly restarted without duplicating text).
 */
export class FallbackLLMProvider implements LLMProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  visionCompletion?: (req: VisionRequest) => Promise<ChatResult>;
  transcribeAudio?: (req: TranscribeRequest) => Promise<string>;
  generateImage?: (req: ImageRequest) => Promise<ImageResult>;
  embed?: (texts: string[]) => Promise<number[][]>;

  constructor(
    private readonly primary: LLMProvider,
    private readonly fallback: LLMProvider,
  ) {
    this.name = `${primary.name}->${fallback.name}`;
    this.capabilities = {
      ...primary.capabilities,
      embeddings: primary.capabilities.embeddings || fallback.capabilities.embeddings,
    };
    if (primary.visionCompletion) this.visionCompletion = (r) => primary.visionCompletion!(r);
    if (primary.transcribeAudio) this.transcribeAudio = (r) => primary.transcribeAudio!(r);
    if (primary.generateImage) this.generateImage = (r) => primary.generateImage!(r);
    if (this.capabilities.embeddings) this.embed = (texts) => this.doEmbed(texts);
  }

  private async withFallback<T>(label: string, fn: (p: LLMProvider) => Promise<T>): Promise<T> {
    try {
      return await fn(this.primary);
    } catch (err) {
      log.warn({ err, label }, 'primary LLM failed - retrying on fallback');
      return fn(this.fallback);
    }
  }

  chatCompletion(req: ChatRequest): Promise<ChatResult> {
    return this.withFallback('chatCompletion', (p) => p.chatCompletion(req));
  }

  extractFacts(req: ExtractFactsRequest): Promise<Fact[]> {
    return this.withFallback('extractFacts', (p) => p.extractFacts(req));
  }

  scoreAutoEngage(req: ScoreAutoEngageRequest): Promise<AutoEngageScore> {
    return this.withFallback('scoreAutoEngage', (p) => p.scoreAutoEngage(req));
  }

  jsonCompletion<T>(req: JsonRequest<T>): Promise<T | null> {
    return this.withFallback('jsonCompletion', (p) => p.jsonCompletion(req));
  }

  private async doEmbed(texts: string[]): Promise<number[][]> {
    const provider = this.primary.capabilities.embeddings ? this.primary : this.fallback;
    if (!provider.embed) throw new Error('embedding provider missing embed method');
    return provider.embed(texts);
  }

  async *streamChatCompletion(req: ChatRequest): AsyncGenerator<string, ChatResult, void> {
    let yielded = false;
    try {
      const gen = this.primary.streamChatCompletion(req);
      let res = await gen.next();
      while (!res.done) {
        yielded = true;
        yield res.value;
        res = await gen.next();
      }
      return res.value;
    } catch (err) {
      if (yielded) throw err; // can't restart mid-stream without duplicating output
      log.warn({ err }, 'primary stream failed before output - falling back');
      return yield* this.fallback.streamChatCompletion(req);
    }
  }
}
