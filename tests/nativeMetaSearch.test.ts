import { describe, expect, it, vi } from 'vitest';
import { NativeMetaSearch, HuggingFaceEngine, type SearchEngine } from '../src/search/index.js';

describe('NativeMetaSearch Aggregator', () => {
  it('aggregates and deduplicates results from multiple engines with consensus bonus', async () => {
    const engineA: SearchEngine = {
      id: 'engine-a',
      name: 'Engine A',
      enabled: true,
      weight: 1.5,
      categories: ['general'],
      search: vi.fn().mockResolvedValue([
        {
          title: 'Shared Hit',
          url: 'https://example.com/shared?utm_source=ad',
          content: 'Short snippet',
        },
        {
          title: 'Only A',
          url: 'https://example.com/a',
          content: 'Snippet A',
        },
      ]),
    };

    const engineB: SearchEngine = {
      id: 'engine-b',
      name: 'Engine B',
      enabled: true,
      weight: 1.0,
      categories: ['general'],
      search: vi.fn().mockResolvedValue([
        {
          title: 'Shared Hit',
          url: 'https://example.com/shared',
          content: 'Longer and much more comprehensive snippet from engine B',
        },
      ]),
    };

    const meta = new NativeMetaSearch({
      enabled: true,
      engines: [engineA, engineB],
    });

    const res = await meta.search('Shared Hit');
    expect(res).not.toBeNull();
    expect(res?.results).toHaveLength(2);

    // The shared hit should rank #1 due to consensus bonus
    const top = res!.results[0]!;
    expect(top.url).toBe('https://example.com/shared');
    expect(top.content).toContain('Longer and much more comprehensive');
    expect(top.score).toBeGreaterThan(res!.results[1]!.score!);
  });

  it('detects model/AI intent and boosts Hugging Face results', async () => {
    const hfEngine: SearchEngine = {
      id: 'huggingface',
      name: 'Hugging Face',
      enabled: true,
      weight: 1.8,
      categories: ['it', 'general'],
      search: vi.fn().mockResolvedValue([
        {
          title: 'Hugging Face: Qwen/Qwen-Image-2.1',
          url: 'https://huggingface.co/Qwen/Qwen-Image-2.1',
          content: 'Downloads: 250,000 | Likes: 1,200',
        },
      ]),
    };

    const generalEngine: SearchEngine = {
      id: 'general',
      name: 'General',
      enabled: true,
      weight: 1.0,
      categories: ['general'],
      search: vi.fn().mockResolvedValue([
        {
          title: 'Random News Article',
          url: 'https://news.example.com/article',
          content: 'Some random article',
        },
      ]),
    };

    const meta = new NativeMetaSearch({
      enabled: true,
      engines: [hfEngine, generalEngine],
    });

    const res = await meta.search('Qwen Image 2.1 model huggingface');
    expect(res).not.toBeNull();
    expect(res?.results[0]?.url).toBe('https://huggingface.co/Qwen/Qwen-Image-2.1');
    expect(res?.results[0]?.engine).toBe('huggingface');
  });

  it('resilient against failing engines without breaking the search response', async () => {
    const brokenEngine: SearchEngine = {
      id: 'broken',
      name: 'Broken',
      enabled: true,
      weight: 1.0,
      categories: ['general'],
      search: vi.fn().mockRejectedValue(new Error('Network socket hung up')),
    };

    const workingEngine: SearchEngine = {
      id: 'working',
      name: 'Working',
      enabled: true,
      weight: 1.2,
      categories: ['general'],
      search: vi.fn().mockResolvedValue([
        {
          title: 'Resilient Result',
          url: 'https://reliable.example.com',
          content: 'Fetched smoothly despite sibling engine failure',
        },
      ]),
    };

    const meta = new NativeMetaSearch({
      enabled: true,
      engines: [brokenEngine, workingEngine],
    });

    const res = await meta.search('resilience test');
    expect(res).not.toBeNull();
    expect(res?.results).toHaveLength(1);
    expect(res?.results[0]?.title).toBe('Resilient Result');
  });

  it('searchImages collects and deduplicates images from image-capable engines', async () => {
    const imgEngine1: SearchEngine = {
      id: 'img1',
      name: 'Img 1',
      enabled: true,
      weight: 1.0,
      categories: ['images'],
      search: vi.fn().mockResolvedValue([]),
      searchImages: vi
        .fn()
        .mockResolvedValue(['https://img.example.com/1.png', 'https://img.example.com/shared.png']),
    };

    const imgEngine2: SearchEngine = {
      id: 'img2',
      name: 'Img 2',
      enabled: true,
      weight: 1.0,
      categories: ['images'],
      search: vi.fn().mockResolvedValue([]),
      searchImages: vi
        .fn()
        .mockResolvedValue(['https://img.example.com/shared.png', 'https://img.example.com/2.png']),
    };

    const meta = new NativeMetaSearch({
      enabled: true,
      engines: [imgEngine1, imgEngine2],
    });

    const images = await meta.searchImages('cute anime waifu');
    expect(images).toHaveLength(3);
    expect(images).toEqual([
      'https://img.example.com/1.png',
      'https://img.example.com/shared.png',
      'https://img.example.com/2.png',
    ]);
  });
});

describe('Native HuggingFaceEngine', () => {
  it('parses models from HF API response correctly', async () => {
    const engine = new HuggingFaceEngine({ enabled: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: 'Qwen/Qwen-Image-2.1',
            likes: 1250,
            downloads: 350000,
            tags: ['diffusers', 'text-to-image'],
            description: 'State-of-the-art open-weights image model',
          },
        ],
      }),
    );

    const hits = await engine.search('Qwen Image 2.1');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: 'Hugging Face: Qwen/Qwen-Image-2.1',
      url: 'https://huggingface.co/Qwen/Qwen-Image-2.1',
      engine: 'huggingface',
    });
    expect(hits[0]?.content).toContain('Likes: 1250');
    expect(hits[0]?.content).toContain('Downloads: 350,000');
    expect(hits[0]?.content).toContain('diffusers');

    vi.unstubAllGlobals();
  });
});
