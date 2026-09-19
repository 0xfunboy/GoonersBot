import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearxngProvider } from '../src/search/searxng.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../src/utils/logger.js', () => ({ childLogger: () => ({ warn }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const provider = () =>
  new SearxngProvider({
    enabled: true,
    baseUrl: 'http://localhost:8888',
    timeoutMs: 1000,
    maxResults: 3,
  });

describe('SearXNG upstream failure observability', () => {
  it('distinguishes empty HTTP 200 responses with blocked engines without leaking query or errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [],
            unresponsive_engines: [
              ['brave', 'too many requests'],
              ['duckduckgo', 'CAPTCHA'],
              ['startpage', 'Suspended: CAPTCHA https://private.example/token'],
              ['wikipedia', 'HTTP error 403'],
              ['slow', 'timeout'],
              ['other', 'arbitrary-secret'],
              null,
            ],
          }),
        ),
      ),
    );
    await expect(provider().search('private query')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        engineCount: 6,
        reasons: { challenge: 2, rateLimited: 1, accessDenied: 1, timeout: 1, other: 1 },
      },
      'searxng returned no results with upstream engine failures',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|arbitrary-secret|brave/u);
  });

  it('does not call a legitimate empty result an upstream outage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"results":[]}')));
    await expect(provider().search('unmatched query')).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves usable results when only some engines failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [{ title: 'Observed result', url: 'https://example.org/', content: 'Text' }],
            unresponsive_engines: [['brave', 'too many requests']],
          }),
        ),
      ),
    );
    await expect(provider().search('query')).resolves.toMatchObject({
      results: [{ title: 'Observed result', url: 'https://example.org/', content: 'Text' }],
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
