import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchSafeRemoteBuffer = vi.hoisted(() => vi.fn());

vi.mock('../src/utils/safeRemoteFetch.js', () => ({ fetchSafeRemoteBuffer }));

describe('passive page audit', () => {
  afterEach(() => fetchSafeRemoteBuffer.mockReset());

  it('reports observable quality and header indicators without active probing', async () => {
    fetchSafeRemoteBuffer.mockResolvedValue({
      buffer: Buffer.from(
        '<html><head><title>Demo</title><meta name="description" content="A page"><script src="https://cdn.example.test/app.js"></script></head><body><h1>Demo</h1><img src="/hero.jpg"><form action="http://example.test/post"></form><script>window.x=1</script></body></html>',
      ),
      finalUrl: 'https://example.test/',
      status: 200,
      contentType: 'text/html',
      headers: new Headers({
        'content-security-policy': "default-src 'self'",
        'x-content-type-options': 'nosniff',
      }),
    });

    const { PageScanner } = await import('../src/search/pageScanner.js');
    const audit = await new PageScanner({
      timeoutMs: 1_000,
      maxBytes: 64 * 1024,
      userAgent: 'test',
    }).audit('https://example.test/');

    expect(audit).not.toBeNull();
    expect(audit?.quality.title).toBe(true);
    expect(audit?.quality.imagesMissingAlt).toBe(1);
    expect(audit?.quality.externalScriptCount).toBe(1);
    expect(audit?.security.inlineScriptCount).toBe(1);
    expect(audit?.security.insecureFormCount).toBe(1);
    expect(audit?.security.findings).toEqual(
      expect.arrayContaining(['Manca Strict-Transport-Security.', '1 form invia dati via HTTP.']),
    );
    expect(audit?.limitations.join(' ')).toMatch(/non è un pentest/i);
    expect(fetchSafeRemoteBuffer).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ maxBytes: 256_000 }),
    );
  });

  it('turns a safe-fetch private-target rejection into no audit', async () => {
    fetchSafeRemoteBuffer.mockRejectedValueOnce(
      new Error('remote address is not publicly routable'),
    );
    const { PageScanner } = await import('../src/search/pageScanner.js');
    const audit = await new PageScanner({
      timeoutMs: 1_000,
      maxBytes: 64 * 1024,
      userAgent: 'test',
    }).audit('http://127.0.0.1/admin');
    expect(audit).toBeNull();
    expect(fetchSafeRemoteBuffer).toHaveBeenCalledTimes(1);
  });
});
