import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgnesImageGenerator } from '../src/providers/image/agnes.js';

const cfg = {
  enabled: true,
  // This operator-configured local endpoint is deliberately trusted and must remain usable.
  baseUrl: 'http://127.0.0.1:8080',
  apiKey: 'test-key',
  model: 'agnes-image',
  timeoutMs: 5_000,
  maxBytes: 8,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Agnes image remote output hardening', () => {
  it('keeps the configured local provider trusted but guards its returned media URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://1.1.1.1/generated.png' }] }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-type': 'image/png' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const image = await new AgnesImageGenerator(cfg).generate('sunset landscape');

    expect(image.buffer).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:8080/v1/images/generations',
    );
  });

  it('rejects a provider response that points at metadata without a second request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ url: 'http://169.254.169.254/latest/meta-data' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new AgnesImageGenerator(cfg).generate('sunset landscape')).rejects.toThrow(
      /publicly routable/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds inline base64 before returning it', async () => {
    const tooLarge = Buffer.alloc(cfg.maxBytes + 1, 1).toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: tooLarge }] })),
    );

    await expect(new AgnesImageGenerator(cfg).generate('sunset landscape')).rejects.toThrow(
      /too large/,
    );
  });

  it('bounds the provider JSON response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response('x'.repeat(1024 * 1024 + 1), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(new AgnesImageGenerator(cfg).generate('sunset landscape')).rejects.toThrow(
      /byte limit/,
    );
  });
});
