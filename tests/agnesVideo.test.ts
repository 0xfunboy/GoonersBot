import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgnesVideoGenerator, VideoRateLimitError } from '../src/providers/video/agnes.js';

const cfg = {
  enabled: true,
  baseUrl: 'http://router.test',
  apiKey: 'k',
  model: 'agnes-video-v2.0',
  timeoutMs: 5_000,
  maxBytes: 10 * 1024 * 1024,
  minIntervalMs: 60_000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('AgnesVideoGenerator', () => {
  it('returns the clip bytes and duration on success', async () => {
    const fetchMock = vi
      .fn()
      // 1st call: the generation request
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ url: 'http://cdn.test/clip.mp4', seconds: '5.0' }] }),
      )
      // 2nd call: downloading the produced file
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('MP4DATA').buffer,
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const clip = await new AgnesVideoGenerator(cfg).generate('a dog biting its tail');
    expect(clip.buffer.toString()).toBe('MP4DATA');
    expect(clip.seconds).toBe(5);
    expect(clip.mime).toBe('video/mp4');
  });

  it('maps a plain 429 to VideoRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { message: 'video submit failed (HTTP 429)' } }, 429),
      ),
    );
    await expect(new AgnesVideoGenerator(cfg).generate('x')).rejects.toBeInstanceOf(
      VideoRateLimitError,
    );
  });

  it('maps the 502 "rate limit exceeded" body to VideoRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { message: 'video generation rate limit exceeded: allows 1 requests per 1 minute(s)' } },
          502,
        ),
      ),
    );
    await expect(new AgnesVideoGenerator(cfg).generate('x')).rejects.toBeInstanceOf(
      VideoRateLimitError,
    );
  });

  it('gates a second request inside the cooldown without calling the API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'http://cdn.test/a.mp4', seconds: '5.0' }] }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('A').buffer,
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AgnesVideoGenerator(cfg);
    await gen.generate('first');
    const callsAfterFirst = fetchMock.mock.calls.length;

    await expect(gen.generate('second')).rejects.toBeInstanceOf(VideoRateLimitError);
    // the upstream slot must not be spent by the gated call
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(gen.cooldownMs()).toBeGreaterThan(0);
  });

  it('is disabled without a model or base url', () => {
    expect(new AgnesVideoGenerator({ ...cfg, enabled: false }).enabled).toBe(false);
    expect(new AgnesVideoGenerator({ ...cfg, baseUrl: '' }).enabled).toBe(false);
  });
});
