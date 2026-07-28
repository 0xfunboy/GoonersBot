import { afterEach, describe, expect, it, vi } from 'vitest';
import { FallbackLLMProvider } from '../src/providers/llm/fallback.js';
import { OpenAICompatibleProvider } from '../src/providers/llm/openaiCompatible.js';
import type { ChatResult, LLMProvider } from '../src/providers/llm/types.js';
import { fakeLLM } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function openAiCompatible(timeoutMs = 25): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: 'test-openai',
    baseUrl: 'https://llm.test/v1',
    apiKey: 'test-key',
    chatModel: 'test-model',
    visionModel: undefined,
    imageModel: undefined,
    transcriptionModel: undefined,
    ttsModel: undefined,
    requestTimeoutMs: timeoutMs,
  });
}

function pendingResponse(onCancel?: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        onCancel?.();
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function namedProvider(name: string, chat: () => Promise<ChatResult>): LLMProvider {
  const provider = { ...fakeLLM({}), name };
  provider.chatCompletion = chat;
  return provider;
}

describe('OpenAI-compatible response lifetime', () => {
  it('keeps LLM_REQUEST_TIMEOUT_MS active while reading a non-stream body', async () => {
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pendingResponse(() => (cancelled = true))),
    );

    await expect(
      openAiCompatible().chatCompletion({
        messages: [{ role: 'user', content: 'never finish this body' }],
      }),
    ).rejects.toThrow('LLM request timed out after 25ms');
    expect(cancelled).toBe(true);
  });

  it('propagates a caller abort that arrives after response headers', async () => {
    let cancelled = false;
    const fetchMock = vi.fn(async () => pendingResponse(() => (cancelled = true)));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const completion = openAiCompatible(5_000).chatCompletion({
      messages: [{ role: 'user', content: 'cancel me' }],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));

    await expect(completion).rejects.toThrow('caller cancelled');
    expect(cancelled).toBe(true);
  });

  it('keeps the timeout alive for the full SSE stream and cancels its reader', async () => {
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pendingResponse(() => (cancelled = true))),
    );

    const stream = openAiCompatible().streamChatCompletion({
      messages: [{ role: 'user', content: 'stall the stream' }],
    });
    await expect(stream.next()).rejects.toThrow('LLM request timed out after 25ms');
    expect(cancelled).toBe(true);
  });
});

describe('ordered LLM fallback circuit', () => {
  it('tries routes in configuration order, then skips the known-bad prefix during cooldown', async () => {
    const calls: string[] = [];
    const failing = (name: string): LLMProvider =>
      namedProvider(name, async () => {
        calls.push(name);
        throw new Error(`${name} unavailable`);
      });
    const last = namedProvider('groq', async () => {
      calls.push('groq');
      return { text: 'recovered', usage: { estimated: true }, model: 'groq-model' };
    });
    const provider = new FallbackLLMProvider(
      new FallbackLLMProvider(
        new FallbackLLMProvider(failing('primary'), failing('operator')),
        failing('router-model'),
      ),
      last,
    );

    await expect(
      provider.chatCompletion({ messages: [{ role: 'user', content: 'hello' }] }),
    ).resolves.toMatchObject({ text: 'recovered' });
    expect(calls).toEqual(['primary', 'operator', 'router-model', 'groq']);

    calls.length = 0;
    await provider.chatCompletion({ messages: [{ role: 'user', content: 'again' }] });
    expect(calls).toEqual(['groq']);
  });

  it('rejects an empty terminal fallback instead of returning an unusable success', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = namedProvider('primary', async () => {
      primaryCalls += 1;
      throw new Error('down');
    });
    const empty = namedProvider('empty-fallback', async () => {
      fallbackCalls += 1;
      return { text: '   ', usage: { estimated: true }, model: 'empty' };
    });
    const provider = new FallbackLLMProvider(primary, empty);

    await expect(
      provider.chatCompletion({ messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow('fallback returned empty visible text');
    await expect(
      provider.chatCompletion({ messages: [{ role: 'user', content: 'again' }] }),
    ).rejects.toThrow('fallback returned empty visible text');
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(2);
  });

  it('does not fail over or open the circuit when the caller cancelled', async () => {
    let releasePrimary: ((result: ChatResult) => void) | undefined;
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = namedProvider('primary', async () => {
      primaryCalls += 1;
      if (primaryCalls > 1) {
        return { text: 'primary recovered', usage: { estimated: true }, model: 'primary' };
      }
      return new Promise<ChatResult>((resolve) => {
        releasePrimary = resolve;
      });
    });
    const fallback = namedProvider('fallback', async () => {
      fallbackCalls += 1;
      return { text: 'fallback', usage: { estimated: true }, model: 'fallback' };
    });
    const provider = new FallbackLLMProvider(primary, fallback);
    const controller = new AbortController();

    const completion = provider.chatCompletion({
      messages: [{ role: 'user', content: 'cancelled turn' }],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(releasePrimary).toBeTypeOf('function'));
    controller.abort(new Error('turn cancelled'));
    releasePrimary?.({ text: 'late answer', usage: { estimated: true }, model: 'primary' });

    await expect(completion).rejects.toThrow('turn cancelled');
    expect(fallbackCalls).toBe(0);
    await expect(
      provider.chatCompletion({ messages: [{ role: 'user', content: 'new turn' }] }),
    ).resolves.toMatchObject({ text: 'primary recovered' });
    expect(primaryCalls).toBe(2);
  });

  it('opens the circuit after a mid-stream provider failure without duplicating partial text', async () => {
    let primaryStreams = 0;
    let fallbackStreams = 0;
    const primary = namedProvider('primary', async () => {
      throw new Error('unused');
    });
    primary.streamChatCompletion = async function* () {
      primaryStreams += 1;
      yield 'partial';
      throw new Error('stream disconnected');
    };
    const fallback = namedProvider('fallback', async () => {
      throw new Error('unused');
    });
    fallback.streamChatCompletion = async function* () {
      fallbackStreams += 1;
      yield 'recovered';
      return { text: 'recovered', usage: { estimated: true }, model: 'fallback' };
    };
    const provider = new FallbackLLMProvider(primary, fallback);
    const firstChunks: string[] = [];

    await expect(
      (async () => {
        for await (const chunk of provider.streamChatCompletion({
          messages: [{ role: 'user', content: 'first' }],
        })) {
          firstChunks.push(chunk);
        }
      })(),
    ).rejects.toThrow('stream disconnected');
    expect(firstChunks).toEqual(['partial']);
    expect(fallbackStreams).toBe(0);

    const secondChunks: string[] = [];
    for await (const chunk of provider.streamChatCompletion({
      messages: [{ role: 'user', content: 'second' }],
    })) {
      secondChunks.push(chunk);
    }
    expect(secondChunks).toEqual(['recovered']);
    expect(primaryStreams).toBe(1);
    expect(fallbackStreams).toBe(1);
  });
});
