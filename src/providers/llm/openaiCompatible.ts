import { childLogger } from '../../utils/logger.js';
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
  imageModel: string | undefined;
  transcriptionModel: string | undefined;
  ttsModel: string | undefined;
  requestTimeoutMs: number;
}

const log = childLogger('llm');

/** Rough token estimate (~4 chars/token) used when the backend omits usage. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
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

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.capabilities = {
      chat: Boolean(opts.chatModel),
      vision: Boolean(opts.visionModel),
      transcription: Boolean(opts.transcriptionModel),
      imageGeneration: Boolean(opts.imageModel),
      tts: Boolean(opts.ttsModel),
    };
    if (this.capabilities.vision) this.visionCompletion = (req) => this.doVision(req);
    if (this.capabilities.transcription) this.transcribeAudio = (req) => this.doTranscribe(req);
    if (this.capabilities.imageGeneration) this.generateImage = (req) => this.doGenerateImage(req);
  }

  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.opts.apiKey) h['Authorization'] = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  protected url(path: string): string {
    return `${this.opts.baseUrl}${path}`;
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
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens;

    const res = await this.fetchWithTimeout(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
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
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens;

    const res = await this.fetchWithTimeout(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`stream chat failed (${res.status}): ${text.slice(0, 500)}`);
    }

    let full = '';
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
    const body: Record<string, unknown> = { model, messages, stream: false };
    if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens;

    const res = await this.fetchWithTimeout(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
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
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
interface ChatCompletionStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}
interface ImageGenResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
}
