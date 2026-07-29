import { childLogger } from '../../utils/logger.js';
import type {
  AutoEngageScore,
  ChatRequest,
  ChatResult,
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
  private readonly circuitByOperation = new Map<
    string,
    { openUntil: number; consecutiveFailures: number }
  >();

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

  private async withFallback<T>(
    label: string,
    primaryCall: () => Promise<T>,
    fallbackCall: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw abortReason(signal);
    const runFallback = async (): Promise<T> => {
      if (signal?.aborted) throw abortReason(signal);
      const result = await fallbackCall();
      if (signal?.aborted) throw abortReason(signal);
      return result;
    };
    const circuit = this.circuitByOperation.get(label);
    if (circuit && Date.now() < circuit.openUntil) return runFallback();
    try {
      const result = await primaryCall();
      if (signal?.aborted) throw abortReason(signal);
      this.circuitByOperation.delete(label);
      return result;
    } catch (err) {
      if (signal?.aborted) throw abortReason(signal);
      this.notePrimaryFailure(label);
      log.warn({ err, label }, 'primary LLM failed - retrying on fallback');
      return runFallback();
    }
  }

  private notePrimaryFailure(label: string): void {
    const current = this.circuitByOperation.get(label) ?? {
      openUntil: 0,
      consecutiveFailures: 0,
    };
    const consecutiveFailures = current.consecutiveFailures + 1;
    // Do not hammer an exhausted free quota on every internal brain stage. The short exponential
    // circuit closes automatically, so a recovered primary returns without a process restart.
    const cooldownMs = Math.min(5 * 60_000, 15_000 * 2 ** Math.min(4, consecutiveFailures - 1));
    this.circuitByOperation.set(label, {
      consecutiveFailures,
      openUntil: Date.now() + cooldownMs,
    });
  }

  /**
   * Per-call model overrides belong to the primary route. A fallback endpoint has its own
   * configured model and may not expose the primary model name at all.
   */
  private fallbackRequest<T extends { model?: string }>(req: T): Omit<T, 'model'> {
    const { model: _primaryModel, ...fallbackReq } = req;
    return fallbackReq;
  }

  chatCompletion(req: ChatRequest): Promise<ChatResult> {
    return this.withFallback(
      'chatCompletion',
      async () => {
        const result = await this.primary.chatCompletion(req);
        if (!result.text.trim()) throw new Error('primary returned empty visible text');
        return result;
      },
      async () => {
        const result = await this.fallback.chatCompletion(this.fallbackRequest(req));
        if (!result.text.trim()) throw new Error('fallback returned empty visible text');
        return result;
      },
      req.signal,
    );
  }

  scoreAutoEngage(req: ScoreAutoEngageRequest): Promise<AutoEngageScore> {
    return this.withFallback(
      'scoreAutoEngage',
      () => this.primary.scoreAutoEngage(req),
      () => this.fallback.scoreAutoEngage(this.fallbackRequest(req)),
      req.signal,
    );
  }

  jsonCompletion<T>(req: JsonRequest<T>): Promise<T | null> {
    return this.withFallback(
      'jsonCompletion',
      async () => {
        const result = await this.primary.jsonCompletion(req);
        if (result === null) throw new Error('primary returned no schema-valid JSON');
        return result;
      },
      async () => {
        const result = await this.fallback.jsonCompletion(this.fallbackRequest(req));
        if (result === null) throw new Error('fallback returned no schema-valid JSON');
        return result;
      },
      req.signal,
    );
  }

  private async doEmbed(texts: string[]): Promise<number[][]> {
    const provider = this.primary.capabilities.embeddings ? this.primary : this.fallback;
    if (!provider.embed) throw new Error('embedding provider missing embed method');
    return provider.embed(texts);
  }

  async *streamChatCompletion(req: ChatRequest): AsyncGenerator<string, ChatResult, void> {
    if (req.signal?.aborted) throw abortReason(req.signal);
    const streamCircuit = this.circuitByOperation.get('streamChatCompletion');
    if (streamCircuit && Date.now() < streamCircuit.openUntil) {
      return yield* this.validatedStream(
        this.fallback,
        this.fallbackRequest(req),
        'fallback stream',
      );
    }
    let yielded = false;
    try {
      const gen = this.validatedStream(this.primary, req, 'primary stream');
      let res = await gen.next();
      while (!res.done) {
        if (res.value) {
          yielded = true;
          yield res.value;
        }
        res = await gen.next();
      }
      if (req.signal?.aborted) throw abortReason(req.signal);
      this.circuitByOperation.delete('streamChatCompletion');
      return res.value;
    } catch (err) {
      if (req.signal?.aborted) throw abortReason(req.signal);
      this.notePrimaryFailure('streamChatCompletion');
      if (yielded) {
        // Restarting would duplicate already-visible text, but the next request must avoid the
        // provider that just died mid-stream.
        log.warn({ err }, 'primary stream failed after output - opening circuit');
        throw err;
      }
      log.warn({ err }, 'primary stream failed before output - falling back');
      return yield* this.validatedStream(
        this.fallback,
        this.fallbackRequest(req),
        'fallback stream',
      );
    }
  }

  private async *validatedStream(
    provider: LLMProvider,
    req: ChatRequest,
    label: string,
  ): AsyncGenerator<string, ChatResult, void> {
    const gen = provider.streamChatCompletion(req);
    let emitted = '';
    let next = await gen.next();
    while (!next.done) {
      if (next.value) {
        emitted += next.value;
        yield next.value;
      }
      next = await gen.next();
    }
    const result = next.value;
    const visible = result.text.trim() ? result.text : emitted;
    if (!visible.trim()) throw new Error(`${label} returned empty visible text`);
    if (!emitted && result.text) yield result.text;
    return result.text ? result : { ...result, text: emitted };
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('LLM request aborted');
}
