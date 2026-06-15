/**
 * LLM provider abstraction.
 *
 * Replaces the original `omnimodkit` (OpenAI-only, hardcoded) with a capability-aware interface
 * so GoonerBot can swap backends via env. If a provider lacks a capability, callers fail
 * gracefully (clean message, log) instead of crashing the bot.
 */

export interface ProviderCapabilities {
  chat: boolean;
  vision: boolean;
  transcription: boolean;
  imageGeneration: boolean;
  tts: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** estimated when the backend does not return usage */
  estimated: boolean;
}

export interface ChatResult {
  text: string;
  usage: TokenUsage;
  model: string;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** override the default chat model */
  model?: string;
}

export interface VisionRequest {
  system?: string;
  prompt: string;
  imageBase64: string;
  imageMime: string;
  maxTokens?: number;
}

export interface TranscribeRequest {
  audio: Buffer;
  mime: string;
  fileName?: string;
}

export interface ImageRequest {
  prompt: string;
  size?: string;
}

export interface ImageResult {
  /** a URL or a data URL; consumers handle both */
  url?: string;
  /** raw image bytes when the backend returns base64 */
  buffer?: Buffer;
  model: string;
}

export interface Fact {
  userHandle: string;
  fact: string;
}

export interface ExtractFactsRequest {
  /** the latest exchange + context to mine for durable facts */
  context: string;
  existingFacts: string[];
}

export type AutoEngageRisk = 'low' | 'medium' | 'high';

export interface AutoEngageScore {
  shouldReply: boolean;
  confidence: number; // 0..1
  reason: string;
  suggestedTone: string;
  risk: AutoEngageRisk;
}

export interface ScoreAutoEngageRequest {
  /** the fully-composed scoring prompt (built by prompts/) */
  prompt: string;
  system?: string;
}

/** A schema-validated JSON request. The provider parses + zod-validates + repairs once. */
export interface JsonRequest<T> {
  system?: string;
  prompt: string;
  schema: import('zod').ZodType<T>;
  temperature?: number;
  model?: string;
  maxTokens?: number;
}

/**
 * The capability methods are optional at runtime: a provider exposes `capabilities` and may
 * omit unsupported methods. `chatCompletion` and the two "reasoning" helpers
 * (`extractFacts`, `scoreAutoEngage`) build on chat and are always available when `chat` is true.
 */
export interface LLMProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  chatCompletion(req: ChatRequest): Promise<ChatResult>;
  /** Streaming variant; yields incremental text chunks. */
  streamChatCompletion(req: ChatRequest): AsyncGenerator<string, ChatResult, void>;

  visionCompletion?(req: VisionRequest): Promise<ChatResult>;
  transcribeAudio?(req: TranscribeRequest): Promise<string>;
  generateImage?(req: ImageRequest): Promise<ImageResult>;

  extractFacts(req: ExtractFactsRequest): Promise<Fact[]>;
  scoreAutoEngage(req: ScoreAutoEngageRequest): Promise<AutoEngageScore>;

  /**
   * Call the model, parse JSON, validate against a zod schema, repair once on failure.
   * Returns null if it ultimately can't produce valid JSON (callers fall back gracefully).
   */
  jsonCompletion<T>(req: JsonRequest<T>): Promise<T | null>;
}

/** Raised when a capability is requested that the active provider does not support. */
export class CapabilityUnavailableError extends Error {
  constructor(public readonly capability: keyof ProviderCapabilities) {
    super(`LLM capability not available: ${capability}`);
    this.name = 'CapabilityUnavailableError';
  }
}
