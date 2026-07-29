import { childLogger } from '../../utils/logger.js';
import { currentGroupPlan, recordCurrentLlmUsage } from './requestContext.js';
import { createAbortScope, throwIfAborted } from '../../utils/abort.js';
import {
  CapabilityUnavailableError,
  type AutoEngageScore,
  type ChatRequest,
  type ChatResult,
  type ImageRequest,
  type ImageResult,
  type LLMProvider,
  type ProviderCapabilities,
  type ScoreAutoEngageRequest,
  type TranscribeRequest,
  type VisionRequest,
} from './types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  /** Router-specific plan headers; disabled for independent public provider endpoints. */
  forwardGroupPlan?: boolean;
  /** Defaults to true. Set false for a route whose configured chat model must stay pinned. */
  allowRequestModelOverride?: boolean;
  /** Defaults to true. Set false when calls must not debit the conversational request context. */
  meterUsage?: boolean;
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
const MAX_LLM_BODY_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
type ByteStreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ByteStreamReadResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      callback: (value: ByteStreamReadResult | PromiseLike<ByteStreamReadResult>) => void,
      value: ByteStreamReadResult,
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const fail = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(reason);
    };
    const onAbort = (): void => {
      const reason =
        signal.reason instanceof Error ? signal.reason : new Error('LLM response read aborted');
      void reader.cancel(reason).catch(() => undefined);
      fail(reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then((value) => finish(resolve, value), fail);
  });
}

async function readResponseText(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_LLM_BODY_BYTES,
): Promise<string> {
  if (!response.body) {
    throwIfAborted(signal);
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let finished = false;
  try {
    for (;;) {
      const chunk = await readStreamChunk(reader, signal);
      if (chunk.done) {
        finished = true;
        text += decoder.decode();
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`LLM response body exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    throwIfAborted(signal);
    return text;
  } finally {
    if (!finished) await reader.cancel(signal.reason).catch(() => undefined);
  }
}

async function readResponseJson<T>(response: Response, signal: AbortSignal): Promise<T> {
  const text = await readResponseText(response, signal);
  throwIfAborted(signal);
  return JSON.parse(text) as T;
}

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
    if (this.opts.forwardGroupPlan && groupPlan) {
      h['X-GemRouter-Group-Plan'] = groupPlan;
      // Compatibility with older deployments that still use the original LeakRouter name.
      h['X-LeakRouter-Group-Plan'] = groupPlan;
    }
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
      if (this.opts.forwardGroupPlan && groupPlan) {
        h['X-GemRouter-Group-Plan'] = groupPlan;
        h['X-LeakRouter-Group-Plan'] = groupPlan;
      }
      return { url: `${this.opts.nsfwBaseUrl.replace(/\/+$/, '')}/chat/completions`, headers: h };
    }
    return { url: this.url('/chat/completions'), headers: this.headers() };
  }

  /**
   * Keep the timeout/parent-abort scope alive until the response body has been fully consumed.
   * `fetch()` resolves as soon as the headers arrive, so disposing the scope immediately after it
   * returns leaves `json()`, `text()` and SSE readers able to hang forever.
   */
  private async withTimedResponse<T>(
    url: string,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const scope = createAbortScope(this.opts.requestTimeoutMs, signal, 'LLM request');
    try {
      const response = await fetch(url, { ...init, signal: scope.signal });
      return await consume(response, scope.signal);
    } finally {
      scope.dispose();
    }
  }

  protected requireChatModel(model?: string): string {
    const requestedModel = this.opts.allowRequestModelOverride === false ? undefined : model;
    const m = requestedModel ?? this.opts.chatModel;
    if (!m) throw new CapabilityUnavailableError('chat');
    return m;
  }

  private recordUsage(usage: ChatResult['usage']): void {
    if (this.opts.meterUsage !== false) recordCurrentLlmUsage(usage);
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
    if (req.responseFormat) body['response_format'] = req.responseFormat;

    const ep = this.chatEndpoint(model);
    return this.withTimedResponse(
      ep.url,
      {
        method: 'POST',
        headers: ep.headers,
        body: JSON.stringify(body),
      },
      async (res, signal) => {
        if (!res.ok) {
          const text = await readResponseText(res, signal, MAX_ERROR_BODY_BYTES);
          throw new Error(`chat completion failed (${res.status}): ${text.slice(0, 500)}`);
        }
        const json = await readResponseJson<ChatCompletionResponse>(res, signal);
        const text = json.choices?.[0]?.message?.content ?? '';
        const usage = json.usage;
        const returnedModel =
          nonEmpty(res.headers.get('x-gemrouter-backend-model') ?? undefined) ??
          nonEmpty(json.model) ??
          model;
        const result: ChatResult = {
          text,
          model: returnedModel,
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
        this.recordUsage(result.usage);
        return result;
      },
      req.signal,
    );
  }

  async *streamChatCompletion(req: ChatRequest): AsyncGenerator<string, ChatResult, void> {
    const model = this.requireChatModel(req.model);
    const messages = this.buildMessages(req);
    const body: Record<string, unknown> = { model, messages, stream: true };
    applySampling(body, req);

    const ep = this.chatEndpoint(model);
    const scope = createAbortScope(this.opts.requestTimeoutMs, req.signal, 'LLM request');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let streamFinished = false;
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: ep.headers,
        body: JSON.stringify(body),
        signal: scope.signal,
      });
      if (!res.ok || !res.body) {
        const text = await readResponseText(res, scope.signal, MAX_ERROR_BODY_BYTES);
        throw new Error(`stream chat failed (${res.status}): ${text.slice(0, 500)}`);
      }

      const returnedModel =
        nonEmpty(res.headers.get('x-gemrouter-backend-model') ?? undefined) ?? model;
      let full = '';
      let finishReason: ChatResult['finishReason'];
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await readStreamChunk(reader, scope.signal);
        if (done) {
          streamFinished = true;
          buffer += decoder.decode();
          break;
        }
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
            // Ignore a malformed upstream event, but never ignore an abort/read failure.
          }
        }
      }
      throwIfAborted(scope.signal);
      const result: ChatResult = {
        text: full,
        model: returnedModel,
        finishReason,
        usage: {
          inputTokens: estimateTokens(messages.map((m) => m.content).join('\n')),
          outputTokens: estimateTokens(full),
          estimated: true,
        },
      };
      this.recordUsage(result.usage);
      return result;
    } finally {
      if (reader && !streamFinished) {
        await reader.cancel(scope.signal.reason).catch(() => undefined);
      }
      scope.dispose();
    }
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
    if (this.opts.forwardGroupPlan && groupPlan) {
      visionHeaders['X-GemRouter-Group-Plan'] = groupPlan;
      visionHeaders['X-LeakRouter-Group-Plan'] = groupPlan;
    }

    return this.withTimedResponse(
      visionUrl,
      {
        method: 'POST',
        headers: visionHeaders,
        body: JSON.stringify(body),
      },
      async (res, signal) => {
        if (!res.ok) {
          const text = await readResponseText(res, signal, MAX_ERROR_BODY_BYTES);
          throw new Error(`vision completion failed (${res.status}): ${text.slice(0, 500)}`);
        }
        const json = await readResponseJson<ChatCompletionResponse>(res, signal);
        const text = json.choices?.[0]?.message?.content ?? '';
        const returnedModel =
          nonEmpty(res.headers.get('x-gemrouter-backend-model') ?? undefined) ??
          nonEmpty(json.model) ??
          model;
        const result: ChatResult = {
          text,
          model: returnedModel,
          usage: json.usage
            ? {
                inputTokens: json.usage.prompt_tokens,
                outputTokens: json.usage.completion_tokens,
                estimated: false,
              }
            : { outputTokens: estimateTokens(text), estimated: true },
        };
        this.recordUsage(result.usage);
        return result;
      },
      req.signal,
    );
  }

  private async doTranscribe(req: TranscribeRequest): Promise<string> {
    const model = this.opts.transcriptionModel;
    if (!model) throw new CapabilityUnavailableError('transcription');
    const form = new FormData();
    const blob = new Blob([new Uint8Array(req.audio)], { type: req.mime });
    form.append('file', blob, req.fileName ?? 'audio.ogg');
    form.append('model', model);

    return this.withTimedResponse(
      this.url('/audio/transcriptions'),
      {
        method: 'POST',
        headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
        body: form,
      },
      async (res, signal) => {
        if (!res.ok) {
          const text = await readResponseText(res, signal, MAX_ERROR_BODY_BYTES);
          throw new Error(`transcription failed (${res.status}): ${text.slice(0, 500)}`);
        }
        const json = await readResponseJson<{ text?: string }>(res, signal);
        return json.text ?? '';
      },
      req.signal,
    );
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
    return this.withTimedResponse(
      this.url('/images/generations'),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      async (res, signal) => {
        if (!res.ok) {
          const text = await readResponseText(res, signal, MAX_ERROR_BODY_BYTES);
          throw new Error(`image generation failed (${res.status}): ${text.slice(0, 500)}`);
        }
        const json = await readResponseJson<ImageGenResponse>(res, signal);
        const item = json.data?.[0];
        if (item?.url) return { url: item.url, model, provider: 'llm' };
        if (item?.b64_json) {
          return { buffer: Buffer.from(item.b64_json, 'base64'), model, provider: 'llm' };
        }
        throw new Error('image generation returned no data');
      },
      req.signal,
    );
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
    return this.withTimedResponse(
      `${baseUrl}/embeddings`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: texts }),
      },
      async (res, signal) => {
        if (!res.ok) {
          const text = await readResponseText(res, signal, MAX_ERROR_BODY_BYTES);
          throw new Error(`embeddings failed (${res.status}): ${text.slice(0, 500)}`);
        }
        const json = await readResponseJson<EmbeddingsResponse>(res, signal);
        return texts.map((_, i) => json.data?.[i]?.embedding ?? []);
      },
    );
  }

  async jsonCompletion<T>(req: import('./types.js').JsonRequest<T>): Promise<T | null> {
    const generatedSchema =
      req.includeGeneratedSchema === false ? '' : compactJsonSchema(req.schema);
    const schemaContract = [req.schemaHint?.trim(), generatedSchema].filter(Boolean).join('\n\n');
    const sys =
      (req.system ? `${req.system}\n\n` : '') +
      'Output ONLY a single valid JSON object. No prose, no markdown fences, no comments.' +
      (schemaContract ? `\n\nREQUIRED OUTPUT CONTRACT:\n${schemaContract}` : '');
    const complete = async (
      messages: import('./types.js').ChatMessage[],
      temperature: number,
    ): Promise<ChatResult> => {
      const request: ChatRequest = {
        system: sys,
        messages,
        temperature,
        responseFormat: { type: 'json_object' },
        ...(req.model ? { model: req.model } : {}),
        ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
        signal: req.signal,
      };
      try {
        return await this.chatCompletion(request);
      } catch (error) {
        if (!isUnsupportedJsonModeError(error)) throw error;
        log.debug({ model: req.model }, 'JSON mode unsupported; retrying with prompt-only JSON');
        const { responseFormat: _responseFormat, ...plainRequest } = request;
        return this.chatCompletion(plainRequest);
      }
    };
    const first = await complete([{ role: 'user', content: req.prompt }], req.temperature ?? 0.1);
    const firstValidation = validateJsonCandidates(first.text, req);
    if (firstValidation.data !== null) return firstValidation.data;

    // One repair attempt: show the model its broken output, exact contract and bounded validation
    // failures. No parser-side value repair occurs: the model must produce a fresh valid object.
    throwIfAborted(req.signal);
    const repair = await complete(
      [
        { role: 'user', content: req.prompt },
        { role: 'assistant', content: first.text.slice(0, 4_000) },
        {
          role: 'user',
          content:
            'That output did not satisfy the required JSON contract.' +
            (firstValidation.issues.length
              ? ` Validation failures:\n- ${firstValidation.issues.join('\n- ')}`
              : ' It did not contain a complete JSON object.') +
            '\nReply again with ONLY one corrected JSON object. Preserve supported facts; do not invent missing values.',
        },
      ],
      0,
    );
    const repairedValidation = validateJsonCandidates(repair.text, req);
    if (repairedValidation.data !== null) return repairedValidation.data;
    log.debug(
      {
        model: req.model,
        firstIssues: firstValidation.issues,
        repairIssues: repairedValidation.issues,
      },
      'jsonCompletion failed validation after repair',
    );
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
      ...(req.model ? { model: req.model } : {}),
      maxTokens: req.maxTokens ?? 160,
      signal: req.signal,
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

/**
 * Extract complete object/array values with a quote-aware balanced scanner. This avoids the old
 * first-"{" / last-"}" greediness when a model emits reasoning or more than one JSON candidate.
 */
export function extractJsonValues(text: string, maxCandidates = 16): unknown[] {
  if (!text) return [];
  const values: unknown[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let index = 0; index < text.length && values.length < maxCandidates; index += 1) {
    const char = text[index] ?? '';
    if (start < 0) {
      if (char === '{' || char === '[') {
        start = index;
        stack.push(char);
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char !== '}' && char !== ']') continue;
    const opening = stack.at(-1);
    if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) {
      start = -1;
      stack.length = 0;
      continue;
    }
    stack.pop();
    if (stack.length > 0) continue;
    const candidate = text.slice(start, index + 1);
    start = -1;
    try {
      values.push(JSON.parse(candidate) as unknown);
    } catch {
      // Continue scanning: a later candidate may still be complete and schema-valid.
    }
  }
  return values;
}

/** Parse the first complete JSON value that may be fenced or surrounded by prose. */
export function safeJson<T>(text: string): T | null {
  return (extractJsonValues(text, 1)[0] as T | undefined) ?? null;
}

function compactJsonSchema<T>(schema: import('zod').ZodType<T>): string {
  try {
    const jsonSchema = zodToJsonSchema(schema, {
      name: 'response',
      $refStrategy: 'none',
    });
    const serialized = JSON.stringify(jsonSchema);
    return serialized.length <= 16_000
      ? `JSON Schema: ${serialized}`
      : `JSON Schema (truncated; obey the human contract above): ${serialized.slice(0, 16_000)}`;
  } catch (error) {
    log.debug({ error }, 'could not render Zod schema for structured prompt');
    return '';
  }
}

function validateJsonCandidates<T>(
  text: string,
  req: import('./types.js').JsonRequest<T>,
): { data: T | null; issues: string[] } {
  const candidates = extractJsonValues(text);
  const issues: string[] = [];
  for (const candidate of candidates) {
    const normalized = req.normalizeCandidate?.(candidate) ?? candidate;
    const validation = req.schema.safeParse(normalized);
    if (validation.success) return { data: validation.data, issues: [] };
    for (const issue of validation.error.issues.slice(0, 8)) {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      issues.push(`${path}: ${issue.message}`);
      if (issues.length >= 8) break;
    }
    if (issues.length >= 8) break;
  }
  return { data: null, issues };
}

function isUnsupportedJsonModeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(?:400|404|415|422)\b/.test(message) &&
    /\b(?:response[_ -]?format|json[_ -]?object|json mode|unsupported)\b/i.test(message) &&
    !/\b(?:degraded|cool(?:down|ing)|rate.?limit|quota)\b/i.test(message)
  );
}

// ---- response shapes ----
interface ChatCompletionResponse {
  model?: string;
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
