import { File as NodeFile } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaProcessor } from '../src/providers/media/index.js';
import type { SearxngProvider } from '../src/search/searxng.js';

if (!('File' in globalThis)) {
  Object.defineProperty(globalThis, 'File', { configurable: true, value: NodeFile });
}

afterEach(() => vi.unstubAllGlobals());

describe('remote URL consumers', () => {
  it('PageScanner refuses a loopback result before fetch', async () => {
    const { PageScanner } = await import('../src/search/pageScanner.js');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const scanner = new PageScanner({
      timeoutMs: 1_000,
      maxBytes: 64 * 1024,
      userAgent: 'test',
    });

    await expect(scanner.scan(['http://127.0.0.1/admin'])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ImageFinder refuses private SearXNG result URLs before vision', async () => {
    const { ImageFinder } = await import('../src/media/imageFinder.js');
    const searxng = {
      enabled: true,
      searchImages: vi.fn().mockResolvedValue(['http://[::ffff:7f00:1]/image.png']),
    } as unknown as SearxngProvider;
    const describeImage = vi.fn();
    const media = {
      canDescribeImage: true,
      describeImage,
    } as unknown as MediaProcessor;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new ImageFinder(searxng, media, ['test']).find()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(describeImage).not.toHaveBeenCalled();
  });
});
