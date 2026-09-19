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
    const { summarizePageAudit } = await import('../src/search/pageScanner.js');
    const summary = summarizePageAudit(audit!);
    expect(summary).toContain('https://example.test/');
    expect(summary).toContain('Manca Strict-Transport-Security.');
    expect(summary).toContain('1 immagini senza attributo alt');
    expect(summary).toContain('non vulnerabilità dimostrate');
    expect(summary).not.toMatch(/PASSIVE PAGE AUDIT|SHA256|"observations"|score=/);
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

  it('reads a bounded same-origin HTML/CSS/JS sample with reproducible evidence and no inferred vulnerability', async () => {
    const main =
      '<html><head><title>Demo</title><base href="/public/"><script src="app.js"></script><script src="second.js"></script><script src="omitted.js"></script><script src="https://cdn.example.test/external.js"></script><link rel="stylesheet" href="app.css"></head><body><a href="about">About</a><a href="contact">Contact</a><a href="third">Third</a><a href="/logout">Logout</a><a href="https://external.example.test/">External</a></body></html>';
    const bodies: Record<string, { text: string; type: string }> = {
      '/': { text: main, type: 'text/html' },
      '/public/app.js': {
        text: 'const fixed = "hello";\ndocument.querySelector("main").innerHTML = fixed;',
        type: 'text/javascript',
      },
      '/public/second.js': { text: 'console.log("hello")', type: 'application/javascript' },
      '/public/app.css': {
        text: '@media (max-width: 600px) { main { display: block; } }',
        type: 'text/css',
      },
      '/public/about': {
        text: '<html><title>About</title><body><h1>About</h1><main>A public project.</main></body></html>',
        type: 'text/html',
      },
      '/public/contact': {
        text: '<html><title>Contact</title><body><h1>Contact</h1></body></html>',
        type: 'text/html',
      },
    };
    fetchSafeRemoteBuffer.mockImplementation(async (raw, options) => {
      const url = new URL(String(raw));
      options.validateUrl?.(url);
      const source = bodies[url.pathname];
      if (!source) throw new Error('unexpected source');
      return {
        buffer: Buffer.from(source.text),
        finalUrl: url.toString(),
        status: 200,
        contentType: source.type,
        headers: new Headers(),
      };
    });
    const { PageScanner } = await import('../src/search/pageScanner.js');
    const { formatPageAudit } = await import('../src/search/groundingService.js');
    const audit = await new PageScanner({
      timeoutMs: 1_000,
      maxBytes: 64_000,
      userAgent: 'test',
    }).audit('https://example.test/');
    expect(audit?.sources).toHaveLength(5);
    expect(fetchSafeRemoteBuffer).toHaveBeenCalledTimes(6);
    expect(audit?.sources?.every((source) => source.status === 'inspected')).toBe(true);
    expect(audit?.sources?.[0]?.observations[0]).toMatchObject({
      line: 2,
      description: expect.stringContaining('non dimostra una vulnerabilità'),
    });
    expect(audit?.sources?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(audit?.coverage?.omittedCandidates).toBe(2);
    expect(formatPageAudit(audit!)).toContain('https://example.test/public/app.js');
    expect(formatPageAudit(audit!)).toContain('rendered=false');
    for (const [, options] of fetchSafeRemoteBuffer.mock.calls.slice(1)) {
      expect(() => options.validateUrl(new URL('https://external.example.test/redirect'))).toThrow(
        /outside/,
      );
      expect(options.timeoutMs).toBeLessThanOrEqual(1_000);
    }
  });

  it('reserves failed body allowances against the shared budget and leaves skipped sources explicit', async () => {
    const html =
      '<script src="/one.js"></script><script src="/two.js"></script><script src="/three.js"></script><a href="/about">About</a>';
    fetchSafeRemoteBuffer.mockResolvedValueOnce({
      buffer: Buffer.from(html),
      finalUrl: 'https://example.test/',
      status: 200,
      contentType: 'text/html',
      headers: new Headers(),
    });
    fetchSafeRemoteBuffer.mockRejectedValue(new Error('remote response exceeds byte limit'));
    const { PageScanner } = await import('../src/search/pageScanner.js');
    const audit = await new PageScanner({
      timeoutMs: 1_000,
      maxBytes: 64_000,
      userAgent: 'test',
    }).audit('https://example.test/');
    expect(fetchSafeRemoteBuffer).toHaveBeenCalledTimes(3);
    expect(audit?.coverage).toMatchObject({
      maxBytes: 512_000,
      consumedBudgetBytes: 512_000,
      downloadedBytes: Buffer.byteLength(html),
      budgetExhausted: true,
    });
    expect(audit?.sources?.map((source) => source.status)).toEqual([
      'unavailable',
      'unavailable',
      'budget_exhausted',
      'budget_exhausted',
    ]);
    expect(fetchSafeRemoteBuffer.mock.calls[2]?.[1].maxBytes).toBe(
      256_000 - Buffer.byteLength(html),
    );
  });
});
