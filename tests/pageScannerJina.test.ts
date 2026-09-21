import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchSafeRemoteBuffer = vi.hoisted(() => vi.fn());
const isBlockedNetworkAddress = vi.hoisted(() => vi.fn().mockReturnValue(false));

vi.mock('../src/utils/safeRemoteFetch.js', () => ({
  fetchSafeRemoteBuffer,
  isBlockedNetworkAddress,
}));

describe('PageScanner Jina Reader fallback', () => {
  afterEach(() => {
    fetchSafeRemoteBuffer.mockReset();
    vi.unstubAllGlobals();
  });

  it('falls back to Jina Reader when static HTML yields less than 150 chars', async () => {
    // 1. Static HTML returns a React SPA shell with almost no text (<150 chars)
    fetchSafeRemoteBuffer.mockResolvedValue({
      buffer: Buffer.from(
        '<!DOCTYPE html><html><head><title>SPA</title></head><body><div id="root"></div></body></html>',
      ),
      finalUrl: 'https://spa.example.com/',
      status: 200,
      contentType: 'text/html',
      headers: new Headers(),
    });

    // 2. Jina Reader fetch returns rich markdown content
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('r.jina.ai')) {
        return new Response(
          'Title: Comprehensive React Documentation\n\n# Getting Started\nThis full markdown documentation was rendered on the server by Jina Reader, preserving headings, examples, explanations, and architectural details that static scraping missed.',
          { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
        );
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { PageScanner } = await import('../src/search/pageScanner.js');
    const scanner = new PageScanner({
      timeoutMs: 3000,
      maxBytes: 64 * 1024,
      userAgent: 'GoonerBot/2.0',
    });

    const pages = await scanner.scan(['https://spa.example.com/docs']);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.title).toBe('Comprehensive React Documentation');
    expect(pages[0]?.text).toContain('rendered on the server by Jina Reader');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://r.jina.ai/https://spa.example.com/docs'),
      expect.anything(),
    );
  });
});
