import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeRemoteUrl,
  fetchSafeRemoteBuffer,
  isBlockedNetworkAddress,
} from '../src/utils/safeRemoteFetch.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('safe remote fetch', () => {
  it.each([
    'http://127.0.0.1/secret',
    'http://2130706433/secret',
    'http://10.1.2.3/secret',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.10/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fe90::1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
    'http://localhost/',
    'file:///etc/passwd',
    'data:text/plain,secret',
  ])('rejects non-public target %s before fetch', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(assertSafeRemoteUrl(url)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recognizes IPv4-mapped, full link-local and NAT64 private forms', () => {
    expect(isBlockedNetworkAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedNetworkAddress('febf::1')).toBe(true);
    expect(isBlockedNetworkAddress('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isBlockedNetworkAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('revalidates every redirect and never requests a private Location', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSafeRemoteBuffer('https://1.1.1.1/start', {
        timeoutMs: 1_000,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/publicly routable/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops credentials on a cross-origin redirect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://8.8.8.8/final' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSafeRemoteBuffer('https://1.1.1.1/start', {
      timeoutMs: 1_000,
      maxBytes: 1024,
      headers: {
        authorization: 'Bearer secret',
        cookie: 'session=secret',
        'x-request-id': 'safe',
      },
      allowedContentTypes: ['text/plain'],
    });

    const redirectedHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
    expect(redirectedHeaders.get('authorization')).toBeNull();
    expect(redirectedHeaders.get('cookie')).toBeNull();
    expect(redirectedHeaders.get('x-request-id')).toBe('safe');
    expect(result.finalUrl).toBe('https://8.8.8.8/final');
  });

  it('rejects declared and streamed bodies above the byte cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('small', {
          headers: { 'content-length': '5000', 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(12), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSafeRemoteBuffer('https://1.1.1.1/declared', {
        timeoutMs: 1_000,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/byte limit/);
    await expect(
      fetchSafeRemoteBuffer('https://1.1.1.1/chunked', {
        timeoutMs: 1_000,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/byte limit/);
  });

  it('requires an explicitly allowed Content-Type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>not an image</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ),
    );

    await expect(
      fetchSafeRemoteBuffer('https://1.1.1.1/image', {
        timeoutMs: 1_000,
        maxBytes: 1024,
        allowedContentTypes: ['image/*'],
      }),
    ).rejects.toThrow(/Content-Type/);
  });

  it('enforces one wall-clock timeout across the whole request', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: URL, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }),
    );

    const pending = fetchSafeRemoteBuffer('https://1.1.1.1/slow', {
      timeoutMs: 50,
      maxBytes: 1024,
    });
    const rejection = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(51);
    await rejection;
  });
});
