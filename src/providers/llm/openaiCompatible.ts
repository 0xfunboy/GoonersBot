import { childLogger } from '../../utils/logger.js';
import { currentGroupPlan } from './requestContext.js';
import {
  CapabilityUnavailableError,
  type AutoEngageScore,
  type ChatRequest,
  type ChatResult,
  type ExtractFactsRequest,
  type Fact,
  type ImageRequest,
  type ImageResult,
  type LLMProvider,
  type ProviderCapabilities,
  type ScoreAutoEngageRequest,
  type TranscribeRequest,
  type VisionRequest,
} from './types.js';

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string | undefined;
  chatModel: string | undefined;
  visionModel: string | undefined;
  /** Optional separate endpoint for vision; falls back to baseUrl/apiKey when undefined. */
  visionBaseUrl?: string | undefined;
  /** Optional full vision endpoint URL, for routers exposing /v1/vision instead of chat completions. */
  visionEndpointUrl?: string | undefined;
  visionApiKey?: string | undefined;
  /** NSFW model name + optional separate endpoint (e.g. amoral-gemma on a router) for NSFW turns. */
  nsfwModel?: string | undefined;
  nsfwBaseUrl?: string | undefined;
  nsfwApiKey?: string | undefined;
  imageModel: string | undefined;
  transcriptionModel: string | undefined;
  ttsModel: string | undefined;
  embeddingModel?: string | undefined;
  embeddingBaseUrl?: string | undefined;
  embeddingApiKey?: string | undefined;
  requestTimeoutMs: number;
}

const log = childLogger('llm');

/** Rough token estimate (~4 chars/token) used when the backend omits usage. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeFinishReason(value: unknown): ChatResult['finishReason'] {
  if (value === 'length' || value === 'content_filter' || value === 'stop') return value;
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Apply OpenAI sampling params onto a request body. */
function applySampling(body: Record<string, unknown>, req: ChatRequest): void {
  if (req.temperature !== undefined) body['temperature'] = req.temperature;
  if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens;
  if (req.topP !== undefined) body['top_p'] = req.topP;
  if (req.frequencyPenalty !== undefined) body['frequency_penalty'] = req.frequencyPenalty;
  if (req.presencePenalty !== undefined) body['presence_penalty'] = req.presencePenalty;
}

/**
 * Generic OpenAI-compatible adapter. Powers the `solclawn` (LeakRouter OpenAI surface),
 * `openai`, `ollama`, and `custom_openai_compatible` providers. DeepSeek extends this.
 *
 * Capabilities are derived from which models are configured: a missing model => that
 * capability is reported false and the corresponding method throws CapabilityUnavailableError
 * (callers degrade gracefully).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  protected readonly opts: OpenAICompatibleOptions;

  // Capability methods exist as own properties ONLY when configured, so callers can
  // feature-detect via `typeof provider.visionCompletion === 'function'`.
  visionCompletion?: (req: VisionRequest) => Promise<ChatResult>;
  transcribeAudio?: (req: TranscribeRequest) => Promise<string>;
  generateImage?: (req: ImageRequest) => Promise<ImageResult>;
  embed?: (texts: string[]) => Promise<number[][]>;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.capabilities = {
      chat: Boolean(opts.chatModel),
      vision: Boolean(opts.visionModel),
      transcription: Boolean(opts.transcriptionModel),
      imageGeneration: Boolean(opts.imageModel),
      tts: Boolean(opts.ttsModel),
      embeddings: Boolean(opts.embeddingModel),
    };
    if (this.capabilities.vision) this.visionCompletion = (req) => this.doVision(req);
    if (this.capabilities.transcription) this.transcribeAudio = (req) => this.doTranscribe(req);
    if (this.capabilities.imageGeneration) this.generateImage = (req) => this.doGenerateImage(req);
    if (this.capabilities.embeddings) this.embed = (texts) => this.doEmbed(texts);
  }

  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.opts.apiKey) h['Authorization'] = `Bearer ${this.opts.apiKey}`;
    const groupPlan = currentGroupPlan();
    if (groupPlan) h['X-LeakRouter-Group-Plan'] = groupPlan;
    return h;
  }

  protected url(path: string): string {
    return `${this.opts.baseUrl}${path}`;
  }

  /**
   * Chat endpoint + auth for a given model. The NSFW model can live on a separate backend (its own
   * base URL/key), so adult turns are routed there while everyday chat uses the primary endpoint.
   */
  private chatEndpoint(model: string): { url: string; headers: Record<string, string> } {
    if (this.opts.nsfwModel && model === this.opts.nsfwModel && this.opts.nsfwBaseUrl) {
      const h: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.opts.nsfwApiKey) h['Authorization'] = `Bearer ${this.opts.nsfwApiKey}`;
      const groupPlan = currentGroupPlan();
      if (groupPlan) h['X-LeakRouter-Group-Plan'] = groupPlan;
      return { url: `${this.opts.nsfwBaseUrl.replace(/\/+$/, '')}/chat/completions`, headers: h };
    }
    return { url: this.url('/chat/completions'), headers: this.headers() };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  protected requireChatModel(model?: string): string {
    const m = model ?? this.opts.chatModel;
    if (!m) throw new CapabilityUnavailableError('chat');
    return m;
  }

  async chatCompletion(req: ChatRequest): Promise<ChatResult> {
    const model = this.requireChatModel(req.model);
    const messages = this.buildMessages(req);
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    applySampling(body, req);

    const ep = this.chatEndpoint(model);
    const res = await this.fetchWithTimeout(ep.url, {
      method: 'POST',
      headers: ep.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`chat completion failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as ChatCompletionResponse;
    const text = json.choices?.[0]?.message?.content ?? '';
    const usage = json.usage;
    return {
      text,
      model,
      finishReason: normalizeFinishReason(json.choices?.[0]?.finish_reason),
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            estimated: false,
          }
        : {
            inputTokens: estimateTokens(messages.map((m) => m.content).join('\n')),
            outputTokens: estimateTokens(text),
            estimated: true,
          },
    };
  }

  async *streamChatCompletion(req: ChatRequest): AsyncGenerator<string, ChatResult, void> {
    const model = this.requireChatModel(req.model);
    const messages = this.buildMessages(req);
    const body: Record<string, unknown> = { model, messages, stream: true };
    applySampling(body, req);

    const ep = this.chatEndpoint(model);
    const res = await this.fetchWithTimeout(ep.url, {
      method: 'POST',
      headers: ep.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`stream chat failed (${res.status}): ${text.slice(0, 500)}`);
    }

    let full = '';
    let finishReason: ChatResult['finishReason'];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data) as ChatCompletionStreamChunk;
          const delta = chunk.choices?.[0]?.delta?.content;
          finishReason = normalizeFinishReason(chunk.choices?.[0]?.finish_reason) ?? finishReason;
          if (delta) {
            full += delta;
            yield delta;
          }
        } catch {
          // ignore partial/non-JSON keepalive lines
        }
      }
    }
    return {
      text: full,
      model,
      finishReason,
      usage: {
        inputTokens: estimateTokens(messages.map((m) => m.content).join('\n')),
        outputTokens: estimateTokens(full),
        estimated: true,
      },
    };
  }

  private buildMessages(req: ChatRequest): Array<{ role: string; content: string }> {
    const out: Array<{ role: string; content: string }> = [];
    if (req.system) out.push({ role: 'system', content: req.system });
    for (const m of req.messages) out.push({ role: m.role, content: m.content });
    return out;
  }

  private async doVision(req: VisionRequest): Promise<ChatResult> {
    const model = this.opts.visionModel;
    if (!model) throw new CapabilityUnavailableError('vision');
    const content = [
      { type: 'text', text: req.prompt },
      { type: 'image_url', image_url: { url: `data:${req.imageMime};base64,${req.imageBase64}` } },
    ];
    const messages: Array<Record<string, unknown>> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content });
    const body: Record<string, unknown> = this.opts.visionEndpointUrl
      ? { messages, stream: false }
      : { model, messages, stream: false };
    if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens;

    // Vision may live on a separate backend (e.g. an Ollama with llama3.2-vision) since the
    // main chat host often lacks vision. Fall back to the main base/key when not overridden.
    const visionUrl = this.opts.visionEndpointUrl
      ? this.opts.visionEndpointUrl
      : this.opts.visionBaseUrl
      ? `${this.opts.visionBaseUrl.replace(/\/+$/, '')}/chat/completions`
      : this.url('/chat/completions');
    const visionHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    const visionKey = this.opts.visionEndpointUrl
      ? (nonEmpty(this.opts.visionApiKey) ?? this.opts.apiKey)
      : this.opts.visionBaseUrl
        ? nonEmpty(this.opts.visionApiKey)
        : this.opts.apiKey;
    if (visionKey) visionHeaders['Authorization'] = `Bearer ${visionKey}`;
    const groupPlan = currentGroupPlan();
    if (groupPlan) visionHeaders['X-LeakRouter-Group-Plan'] = groupPlan;

    const res = await this.fetchWithTimeout(visionUrl, {
      method: 'POST',
      headers: visionHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`vision completion failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as ChatCompletionResponse;
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text,
      model,
      usage: json.usage
        ? {
            inputTokens: json.usage.prompt_tokens,
            outputTokens: json.usage.completion_tokens,
            estimated: false,
          }
        : { outputTokens: estimateTokens(text), estimated: true },
    };
  }

  private async doTranscribe(req: TranscribeRequest): Promise<string> {
    const model = this.opts.transcriptionModel;
    if (!model) throw new CapabilityUnavailableError('transcription');
    const form = new FormData();
    const blob = new Blob([new Uint8Array(req.audio)], { type: req.mime });
    form.append('file', blob, req.fileName ?? 'audio.ogg');
    form.append('model', model);

    const res = await this.fetchWithTimeout(this.url('/audio/transcriptions'), {
      method: 'POST',
      headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`transcription failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { text?: string };
    return json.text ?? '';
  }

  private async doGenerateImage(req: ImageRequest): Promise<ImageResult> {
    const model = this.opts.imageModel;
    if (!model) throw new CapabilityUnavailableError('imageGeneration');
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      size: req.size ?? '1024x1024',
      n: 1,
    };
    const res = await this.fetchWithTimeout(this.url('/images/generations'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`image generation failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as ImageGenResponse;
    const item = json.data?.[0];
    if (item?.url) return { url: item.url, model };
    if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64'), model };
    throw new Error('image generation returned no data');
  }

  private async doEmbed(texts: string[]): Promise<number[][]> {
    const model = this.opts.embeddingModel;
    if (!model) throw new CapabilityUnavailableError('embeddings');
    if (texts.length === 0) return [];
    const baseUrl = (this.opts.embeddingBaseUrl ?? this.opts.baseUrl).replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = this.opts.embeddingBaseUrl
      ? (nonEmpty(this.opts.embeddingApiKey) ?? this.opts.apiKey)
      : this.opts.apiKey;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await this.fetchWithTimeout(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`embeddings failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as EmbeddingsResponse;
    return texts.map((_, i) => json.data?.[i]?.embedding ?? []);
  }

  async extractFacts(req: ExtractFactsRequest): Promise<Fact[]> {
    const system =
      'You extract durable, useful, non-sensitive facts about group chat members. ' +
      'Return ONLY JSON: {"facts":[{"userHandle":"@handle","fact":"..."}]}. ' +
      'If nothing is worth saving, return {"facts":[]}. ' +
      'Never store medical, political, address, identity, password or temporary-mood data.';
    const user =
      `${req.context}\n\nExisting facts (do not duplicate):\n` +
      `${req.existingFacts.map((f) => `- ${f}`).join('\n') || '(none)'}\n\n` +
      'Return the JSON now.';
    const result = await this.chatCompletion({
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0,
    });
    const parsed = safeJson<{ facts?: Array<{ userHandle?: string; fact?: string }> }>(result.text);
    if (!parsed?.facts) return [];
    return parsed.facts
      .filter((f): f is { userHandle: string; fact: string } => Boolean(f.userHandle && f.fact))
      .map((f) => ({ userHandle: f.userHandle, fact: f.fact }));
  }

  async jsonCompletion<T>(req: import('./types.js').JsonRequest<T>): Promise<T | null> {
    const sys =
      (req.system ? `${req.system}\n\n` : '') +
      'Output ONLY a single valid JSON object. No prose, no markdown fences, no comments.';
    const first = await this.chatCompletion({
      system: sys,
      messages: [{ role: 'user', content: req.prompt }],
      temperature: req.temperature ?? 0.1,
      ...(req.model ? { model: req.model } : {}),
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    });
    const parsed1 = safeJson<unknown>(first.text);
    const v1 = parsed1 !== null ? req.schema.safeParse(parsed1) : null;
    if (v1 && v1.success) return v1.data;

    // One repair attempt: show the model its broken output and demand valid JSON.
    const repair = await this.chatCompletion({
      system: sys,
      messages: [
        { role: 'user', content: req.prompt },
        { role: 'assistant', content: first.text.slice(0, 2000) },
        {
          role: 'user',
          content:
            'That was not valid JSON for the required schema. Reply again with ONLY the corrected JSON object.',
        },
      ],
      temperature: 0,
      ...(req.model ? { model: req.model } : {}),
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    });
    const parsed2 = safeJson<unknown>(repair.text);
    const v2 = parsed2 !== null ? req.schema.safeParse(parsed2) : null;
    if (v2 && v2.success) return v2.data;
    log.debug('jsonCompletion failed validation after repair');
    return null;
  }

  async scoreAutoEngage(req: ScoreAutoEngageRequest): Promise<AutoEngageScore> {
    const system =
      req.system ??
      'You decide whether a group chat bot should reply right now. ' +
        'Return ONLY JSON: {"shouldReply":bool,"confidence":0..1,"reason":str,"suggestedTone":str,"risk":"low|medium|high"}.';
    const result = await this.chatCompletion({
      system,
      messages: [{ role: 'user', content: req.prompt }],
      temperature: 0,
    });
    const parsed = safeJson<Partial<AutoEngageScore>>(result.text);
    return {
      shouldReply: Boolean(parsed?.shouldReply),
      confidence: clamp01(typeof parsed?.confidence === 'number' ? parsed.confidence : 0),
      reason: typeof parsed?.reason === 'string' ? parsed.reason : 'no reason',
      suggestedTone: typeof parsed?.suggestedTone === 'string' ? parsed.suggestedTone : 'neutral',
      risk: parsed?.risk === 'high' || parsed?.risk === 'medium' ? parsed.risk : 'low',
    };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Parse JSON that may be wrapped in markdown fences or surrounded by prose. */
export function safeJson<T>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    log.debug('failed to parse JSON from model output');
    return null;
  }
}

// ---- response shapes ----
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
interface ChatCompletionStreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
}
interface ImageGenResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
}
interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}
