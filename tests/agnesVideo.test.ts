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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function videoResponse(body: string): Response {
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'content-type': 'video/mp4' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('AgnesVideoGenerator', () => {
  it('returns the clip bytes and duration on success', async () => {
    const fetchMock = vi
      .fn()
      // 1st call: the generation request
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ url: 'https://1.1.1.1/clip.mp4', seconds: '5.0' }] }),
      )
      // 2nd call: downloading the produced file
      .mockResolvedValueOnce(videoResponse('MP4DATA'));
    vi.stubGlobal('fetch', fetchMock);

    const clip = await new AgnesVideoGenerator(cfg).generate('a dog biting its tail');
    expect(clip.buffer.toString()).toBe('MP4DATA');
    expect(clip.seconds).toBe(5);
    expect(clip.mime).toBe('video/mp4');
  });

  it('passes requested duration and aspect ratio to a supporting backend', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ url: 'https://1.1.1.1/clip.mp4', seconds: '8' }] }),
      )
      .mockResolvedValueOnce(videoResponse('MP4DATA'));
    vi.stubGlobal('fetch', fetchMock);

    await new AgnesVideoGenerator(cfg).generate('adult dancer', {
      durationSeconds: 8,
      aspectRatio: '9:16',
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ duration_seconds: 8, aspect_ratio: '9:16' });
  });

  it('rejects a provider media URL targeting loopback before downloading it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ url: 'http://127.0.0.1/private.mp4', seconds: '5' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new AgnesVideoGenerator(cfg).generate('a dog playing in a park')).rejects.toThrow(
      /publicly routable/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a plain 429 to VideoRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
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
          {
            error: {
              message: 'video generation rate limit exceeded: allows 1 requests per 1 minute(s)',
            },
          },
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
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ url: 'https://1.1.1.1/a.mp4', seconds: '5.0' }] }),
      )
      .mockResolvedValueOnce(videoResponse('A'));
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
