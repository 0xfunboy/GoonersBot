import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadEnv } from '../src/config/env.js';
import { resolveLLMConfig } from '../src/config/index.js';
import {
  createLLMProvider,
  createMiningLLMProvider,
  extractJsonValues,
  OpenAICompatibleProvider,
  safeJson,
} from '../src/providers/llm/index.js';
import { FallbackLLMProvider } from '../src/providers/llm/fallback.js';
import type { JsonRequest } from '../src/providers/llm/types.js';
import { fakeLLM } from './helpers.js';
import {
  currentLlmUsage,
  recordCurrentLlmUsage,
  runWithGroupPlan,
} from '../src/providers/llm/requestContext.js';

const base = { TELEGRAM_BOT_TOKEN: 't' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createLLMProvider', () => {
  it('selects solclawn via OpenAI-compatible adapter', () => {
    const p = createLLMProvider(
      resolveLLMConfig(loadEnv({ ...base, LLM_PROVIDER: 'solclawn', LLM_MODEL: 'qwen' })),
    );
    expect(p.name).toBe('solclawn');
    expect(p.capabilities.chat).toBe(true);
  });

  it('derives capabilities from configured models', () => {
    const p = createLLMProvider(
      resolveLLMConfig(
        loadEnv({
          ...base,
          LLM_PROVIDER: 'openai',
          LLM_MODEL: 'gpt',
          LLM_VISION_MODEL: 'gpt-vision',
          LLM_IMAGE_MODEL: 'dalle',
          LLM_TRANSCRIPTION_MODEL: 'whisper',
        }),
      ),
    );
    expect(p.capabilities).toMatchObject({
      chat: true,
      vision: true,
      imageGeneration: true,
      transcription: true,
    });
    expect(typeof p.visionCompletion).toBe('function');
    expect(typeof p.transcribeAudio).toBe('function');
    expect(typeof p.generateImage).toBe('function');
  });

  it('reports missing capabilities and removes their methods', () => {
    const p = createLLMProvider(
      resolveLLMConfig(loadEnv({ ...base, LLM_PROVIDER: 'ollama', LLM_MODEL: 'gemma' })),
    );
    expect(p.capabilities.vision).toBe(false);
    expect(p.visionCompletion).toBeUndefined();
    expect(p.generateImage).toBeUndefined();
  });

  it('builds the deepseek provider', () => {
    const p = createLLMProvider(
      resolveLLMConfig(
        loadEnv({ ...base, LLM_PROVIDER: 'deepseek', DEEPSEEK_MODEL: 'deepseek-chat' }),
      ),
    );
    expect(p.name).toBe('deepseek');
    expect(p.capabilities.chat).toBe(true);
  });

  it('builds an ordered pool of configured free-tier fallbacks', () => {
    const cfg = resolveLLMConfig(
      loadEnv({
        ...base,
        LLM_PROVIDER: 'ollama',
        LLM_MODEL: 'local',
        GROQ_API_KEY: 'groq-key',
        GROQ_MODEL: 'openai/gpt-oss-120b',
        GEMINI_API_KEY: 'gemini-key',
        GEMINI_MODEL: 'gemini-flash',
        OPENROUTER_API_KEY: 'router-key',
      }),
    );
    expect(cfg.freeFallbacks.map((item) => item.name)).toEqual([
      'groq-free',
      'gemini-free',
      'openrouter-free',
    ]);
    expect(cfg.freeFallbacks[0]).toMatchObject({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
    });
    expect(cfg.freeFallbacks[2]).toMatchObject({ model: 'openrouter/free' });
  });

  it('adds ordered alternative models from the same gateway without duplicating the primary', () => {
    const cfg = resolveLLMConfig(
      loadEnv({
        ...base,
        LLM_PROVIDER: 'custom_openai_compatible',
        LLM_BASE_URL: 'http://router.test/v1/',
        LLM_API_KEY: 'shared-key',
        LLM_MODEL: 'primary',
        LLM_ROUTER_FALLBACK_MODELS: 'primary, gemma-free, deepseek-free',
      }),
    );
    expect(cfg.freeFallbacks).toEqual([
      {
        name: 'router-fallback-1',
        baseUrl: 'http://router.test/v1',
        apiKey: 'shared-key',
        model: 'gemma-free',
      },
      {
        name: 'router-fallback-2',
        baseUrl: 'http://router.test/v1',
        apiKey: 'shared-key',
        model: 'deepseek-free',
      },
    ]);
  });
});

describe('safeJson', () => {
  it('parses plain JSON', () => {
    expect(safeJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses fenced JSON', () => {
    expect(safeJson<{ a: number }>('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('parses JSON embedded in prose', () => {
    expect(safeJson<{ ok: boolean }>('Sure: {"ok":true} done')).toEqual({ ok: true });
  });
  it('returns null on garbage', () => {
    expect(safeJson('no json here')).toBeNull();
  });
  it('extracts balanced candidates without being confused by braces inside strings', () => {
    expect(
      extractJsonValues(
        'reasoning {"broken": true} then {"ok":true,"text":"literal } and { stay quoted"}',
      ),
    ).toEqual([{ broken: true }, { ok: true, text: 'literal } and { stay quoted' }]);
  });
});

describe('OpenAI-compatible structured output', () => {
  it('uses JSON mode, supplies the schema and repairs with concrete validation issues', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const outputs = ['{"ok":"wrong"}', '{"ok":true}'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const content = outputs.shift() ?? '{"ok":true}';
        return new Response(
          JSON.stringify({
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const provider = new OpenAICompatibleProvider({
      name: 'structured-test',
      baseUrl: 'https://llm.test/v1',
      apiKey: 'test',
      chatModel: 'test-model',
      visionModel: undefined,
      imageModel: undefined,
      transcriptionModel: undefined,
      ttsModel: undefined,
      requestTimeoutMs: 2_000,
    });

    await expect(
      provider.jsonCompletion({
        prompt: 'Return the result.',
        schema: z.object({ ok: z.boolean() }),
        schemaHint: 'ok must be a boolean.',
      }),
    ).resolves.toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.['response_format']).toEqual({ type: 'json_object' });
    const firstMessages = bodies[0]?.['messages'] as Array<{ role: string; content: string }>;
    expect(firstMessages[0]?.content).toContain('ok must be a boolean');
    expect(firstMessages[0]?.content).toContain('JSON Schema');
    const repairMessages = bodies[1]?.['messages'] as Array<{ role: string; content: string }>;
    expect(repairMessages.at(-1)?.content).toContain('ok: Expected boolean');
  });

  it('can use a compact human contract without duplicating a generated JSON Schema', async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const provider = new OpenAICompatibleProvider({
      name: 'compact-structured-test',
      baseUrl: 'https://llm.test/v1',
      apiKey: undefined,
      chatModel: 'test-model',
      visionModel: undefined,
      imageModel: undefined,
      transcriptionModel: undefined,
      ttsModel: undefined,
      requestTimeoutMs: 2_000,
    });

    await expect(
      provider.jsonCompletion({
        prompt: 'Return the result.',
        schema: z.object({ ok: z.boolean() }),
        schemaHint: 'Compact contract: ok is boolean.',
        includeGeneratedSchema: false,
      }),
    ).resolves.toEqual({ ok: true });
    const messages = body?.['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain('Compact contract');
    expect(messages[0]?.content).not.toContain('JSON Schema');
  });

  it('validates every complete candidate and applies lossless normalization before Zod', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'analysis {"wrong":1} final {"status":"YES","count":"4"}',
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const provider = new OpenAICompatibleProvider({
      name: 'structured-test',
      baseUrl: 'https://llm.test/v1',
      apiKey: undefined,
      chatModel: 'test-model',
      visionModel: undefined,
      imageModel: undefined,
      transcriptionModel: undefined,
      ttsModel: undefined,
      requestTimeoutMs: 2_000,
    });
    await expect(
      provider.jsonCompletion({
        prompt: 'Return JSON.',
        schema: z.object({ status: z.literal('yes'), count: z.number().int() }),
        normalizeCandidate: (candidate) => {
          if (!candidate || typeof candidate !== 'object') return candidate;
          const value = candidate as Record<string, unknown>;
          return {
            ...value,
            status:
              typeof value['status'] === 'string' ? value['status'].toLowerCase() : value['status'],
            count: typeof value['count'] === 'string' ? Number(value['count']) : value['count'],
          };
        },
      }),
    ).resolves.toEqual({ status: 'yes', count: 4 });
  });
});

describe('FallbackLLMProvider', () => {
  it('uses its configured model instead of a failed primary model override', async () => {
    const primary = fakeLLM({});
    primary.chatCompletion = async () => {
      throw new Error('primary unavailable');
    };
    primary.streamChatCompletion = async function* () {
      yield* [];
      throw new Error('primary unavailable');
    };
    primary.jsonCompletion = async () => {
      throw new Error('primary unavailable');
    };

    const fallback = fakeLLM({ json: { ok: true } });
    let chatModel: string | undefined;
    let streamModel: string | undefined;
    let jsonModel: string | undefined;
    fallback.chatCompletion = async (req) => {
      chatModel = req.model;
      return { text: 'recovered', usage: { estimated: true }, model: 'local-model' };
    };
    fallback.streamChatCompletion = async function* (req) {
      streamModel = req.model;
      yield 'recovered';
      return { text: 'recovered', usage: { estimated: true }, model: 'local-model' };
    };
    const originalJsonCompletion = fallback.jsonCompletion.bind(fallback);
    fallback.jsonCompletion = async <T>(req: JsonRequest<T>) => {
      jsonModel = req.model;
      return originalJsonCompletion(req);
    };

    const provider = new FallbackLLMProvider(primary, fallback);
    await expect(
      provider.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'remote-model',
      }),
    ).resolves.toMatchObject({ text: 'recovered', model: 'local-model' });
    expect(chatModel).toBeUndefined();

    const chunks: string[] = [];
    for await (const chunk of provider.streamChatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'remote-model',
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['recovered']);
    expect(streamModel).toBeUndefined();

    await expect(
      provider.jsonCompletion({
        prompt: 'return JSON',
        model: 'remote-model',
        schema: z.object({ ok: z.boolean() }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(jsonModel).toBeUndefined();
  });

  it('falls back on empty chat text and schema-invalid JSON, not only network errors', async () => {
    const primary = fakeLLM({});
    primary.chatCompletion = async () => ({
      text: '   ',
      usage: { estimated: true },
      model: 'empty-primary',
    });
    primary.jsonCompletion = async () => null;
    const fallback = fakeLLM({ json: { ok: true } });
    fallback.chatCompletion = async () => ({
      text: 'visible fallback',
      usage: { estimated: true },
      model: 'fallback',
    });

    const provider = new FallbackLLMProvider(primary, fallback);
    await expect(
      provider.chatCompletion({ messages: [{ role: 'user', content: 'hello' }] }),
    ).resolves.toMatchObject({ text: 'visible fallback' });
    await expect(
      provider.jsonCompletion({
        prompt: 'json',
        schema: z.object({ ok: z.boolean() }),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects null from the terminal structured fallback', async () => {
    const primary = fakeLLM({});
    const fallback = fakeLLM({});
    primary.jsonCompletion = async () => null;
    fallback.jsonCompletion = async () => null;
    const provider = new FallbackLLMProvider(primary, fallback);

    await expect(
      provider.jsonCompletion({
        prompt: 'json',
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow('fallback returned no schema-valid JSON');
  });

  it('keeps structured-output circuit failures isolated from ordinary chat', async () => {
    let primaryChatCalls = 0;
    const primary = fakeLLM({});
    primary.jsonCompletion = async () => null;
    primary.chatCompletion = async () => {
      primaryChatCalls += 1;
      return { text: 'primary chat', usage: { estimated: true }, model: 'primary' };
    };
    const fallback = fakeLLM({ json: { ok: true } });
    const provider = new FallbackLLMProvider(primary, fallback);

    await provider.jsonCompletion({
      prompt: 'json',
      schema: z.object({ ok: z.boolean() }),
    });
    await expect(
      provider.chatCompletion({ messages: [{ role: 'user', content: 'hello' }] }),
    ).resolves.toMatchObject({ text: 'primary chat' });
    expect(primaryChatCalls).toBe(1);
  });
});

describe('per-turn LLM metering', () => {
  it('keeps dedicated mining pinned and outside conversational routing and metering', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Headers | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'mined' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 21, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const provider = createMiningLLMProvider({
      baseUrl: 'http://miner.test/v1',
      apiKey: undefined,
      model: 'gemma-4-31b-it',
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 15_000,
      requestTimeoutMs: 2_000,
    });

    await runWithGroupPlan('free', async () => {
      await expect(
        provider.chatCompletion({
          messages: [{ role: 'user', content: 'mine this' }],
          model: 'expensive-interactive-model',
        }),
      ).resolves.toMatchObject({ model: 'gemma-4-31b-it', text: 'mined' });
      expect(currentLlmUsage()).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        estimated: false,
        calls: 0,
      });
    });

    expect(capturedBody?.['model']).toBe('gemma-4-31b-it');
    expect(capturedHeaders?.get('X-GemRouter-Group-Plan')).toBeNull();
    expect(capturedHeaders?.get('X-LeakRouter-Group-Plan')).toBeNull();
  });

  it('does not dispatch a mining request that cannot fit in the one-minute token budget', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = createMiningLLMProvider({
      baseUrl: 'http://miner.test/v1',
      apiKey: undefined,
      model: 'gemma-4-31b-it',
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 15_000,
      requestTimeoutMs: 180_000,
    });

    await expect(
      provider.chatCompletion({
        messages: [{ role: 'user', content: 'oversized '.repeat(5_000) }],
        maxTokens: 1_500,
      }),
    ).rejects.toThrow(/exceeds the 15000 token\/minute budget; request was not sent/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('distributes mining starts across the minute and never exceeds the rolling cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const epoch = Date.now();
    const starts: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        starts.push(Date.now() - epoch);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'mined' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const provider = createMiningLLMProvider({
      baseUrl: 'http://miner.test/v1',
      apiKey: undefined,
      model: 'gemma-4-31b-it',
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 15_000,
      requestTimeoutMs: 180_000,
    });
    const request = { messages: [{ role: 'user' as const, content: 'mine this' }] };
    const pending = Array.from({ length: 4 }, () => provider.chatCompletion(request));

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 20_000]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(starts).toEqual([0, 20_000, 40_000]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(starts).toEqual([0, 20_000, 40_000, 60_000]);
    await expect(Promise.all(pending)).resolves.toHaveLength(4);

    for (const end of starts) {
      expect(starts.filter((start) => start > end - 60_000 && start <= end)).toHaveLength(
        end === 0 ? 1 : Math.min(3, end / 20_000 + 1),
      );
    }
  });

  it('allows only one mining HTTP request in flight even when callers overlap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    let releaseFirst!: (response: Response) => void;
    let fetchCalls = 0;
    const fetchMock = vi.fn(async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          })
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: 'mined' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = createMiningLLMProvider({
      baseUrl: 'http://miner.test/v1',
      apiKey: undefined,
      model: 'gemma-4-31b-it',
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 15_000,
      requestTimeoutMs: 180_000,
    });
    const request = { messages: [{ role: 'user' as const, content: 'mine this' }] };
    const first = provider.chatCompletion(request);
    const second = provider.chatCompletion(request);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFirst(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'mined' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('paces the structured-output repair as a second real mining request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const starts: number[] = [];
    const outputs = ['{"ok":"not-a-boolean"}', '{"ok":true}'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        starts.push(Date.now());
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: outputs.shift() }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const provider = createMiningLLMProvider({
      baseUrl: 'http://miner.test/v1',
      apiKey: undefined,
      model: 'gemma-4-31b-it',
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 15_000,
      requestTimeoutMs: 180_000,
    });
    const result = provider.jsonCompletion({
      prompt: 'Return a boolean.',
      schema: z.object({ ok: z.boolean() }),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts[1]! - starts[0]!).toBe(20_000);
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('does not immediately hammer the dedicated gateway after a transient mining failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('LLM request timed out after 180000ms');
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = createMiningLLMProvider({
      baseUrl: 'http://miner.test/v1',
      apiKey: undefined,
      model: 'gemma-4-31b-it',
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 15_000,
      requestTimeoutMs: 180_000,
    });
    const request = { messages: [{ role: 'user' as const, content: 'mine this' }] };

    await expect(provider.chatCompletion(request)).rejects.toThrow(/timed out/);
    await expect(provider.chatCompletion(request)).rejects.toThrow(/cooling down/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves model overrides, plan forwarding and metering on the primary provider', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Headers | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'interactive' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 13, completion_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const provider = createLLMProvider(
      resolveLLMConfig(
        loadEnv({
          ...base,
          LLM_PROVIDER: 'custom_openai_compatible',
          LLM_BASE_URL: 'http://primary.test/v1',
          LLM_MODEL: 'configured-primary',
        }),
      ),
    );

    await runWithGroupPlan('pro', async () => {
      await expect(
        provider.chatCompletion({
          messages: [{ role: 'user', content: 'answer this' }],
          model: 'per-turn-model',
        }),
      ).resolves.toMatchObject({ model: 'per-turn-model', text: 'interactive' });
      expect(currentLlmUsage()).toEqual({
        inputTokens: 13,
        outputTokens: 3,
        estimated: false,
        calls: 1,
      });
    });

    expect(capturedBody?.['model']).toBe('per-turn-model');
    expect(capturedHeaders?.get('X-GemRouter-Group-Plan')).toBe('pro');
    expect(capturedHeaders?.get('X-LeakRouter-Group-Plan')).toBe('pro');
  });

  it('reports the backend model selected by GemRouter response metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: 'requested-model',
              choices: [{ message: { content: 'routed' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 4, completion_tokens: 2 },
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'x-gemrouter-backend-model': 'actual-backend-model',
              },
            },
          ),
      ),
    );
    const provider = createLLMProvider(
      resolveLLMConfig(
        loadEnv({
          ...base,
          LLM_PROVIDER: 'custom_openai_compatible',
          LLM_BASE_URL: 'http://router.test/v1',
          LLM_MODEL: 'requested-model',
        }),
      ),
    );

    await expect(
      provider.chatCompletion({ messages: [{ role: 'user', content: 'route me' }] }),
    ).resolves.toMatchObject({ model: 'actual-backend-model', text: 'routed' });
  });

  it('aggregates every internal provider call inside the group-plan context', async () => {
    await runWithGroupPlan('pro', async () => {
      recordCurrentLlmUsage({ inputTokens: 120, outputTokens: 30, estimated: false });
      recordCurrentLlmUsage({ inputTokens: 80, outputTokens: 20, estimated: true });
      expect(currentLlmUsage()).toEqual({
        inputTokens: 200,
        outputTokens: 50,
        estimated: true,
        calls: 2,
      });
    });
    expect(currentLlmUsage()).toBeUndefined();
  });
});
