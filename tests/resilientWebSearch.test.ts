import { describe, expect, it, vi } from 'vitest';
import {
  DuckDuckGoSearchProvider,
  WikipediaSearchProvider,
  MultiEngineSearchProvider,
  type WebSearchProvider,
} from '../src/search/index.js';

describe('MultiEngineSearchProvider', () => {
  it('returns primary results when primary engine succeeds with hits', async () => {
    const primary: WebSearchProvider = {
      enabled: true,
      search: vi.fn().mockResolvedValue({
        query: 'test query',
        results: [{ title: 'Primary Hit', url: 'https://example.com', content: 'Info' }],
      }),
    };
    const fallback: WebSearchProvider = {
      enabled: true,
      search: vi.fn(),
    };

    const multi = new MultiEngineSearchProvider({
      primary,
      fallbacks: [fallback],
    });

    const res = await multi.search('test query');
    expect(res).not.toBeNull();
    expect(res?.results[0]?.title).toBe('Primary Hit');
    expect(fallback.search).not.toHaveBeenCalled();
  });

  it('cascades to fallback when primary returns 0 results', async () => {
    const primary: WebSearchProvider = {
      enabled: true,
      search: vi.fn().mockResolvedValue({
        query: 'qwen image 2.1',
        results: [],
      }),
    };
    const fallback: WebSearchProvider = {
      enabled: true,
      search: vi.fn().mockResolvedValue({
        query: 'qwen image 2.1',
        results: [
          {
            title: 'Qwen/Qwen-Image-2.1',
            url: 'https://huggingface.co/Qwen/Qwen-Image-2.1',
            content: 'HuggingFace weights',
          },
        ],
      }),
    };

    const multi = new MultiEngineSearchProvider({
      primary,
      fallbacks: [fallback],
    });

    const res = await multi.search('qwen image 2.1');
    expect(res).not.toBeNull();
    expect(res?.results).toHaveLength(1);
    expect(res?.results[0]?.url).toBe('https://huggingface.co/Qwen/Qwen-Image-2.1');
    expect(fallback.search).toHaveBeenCalledWith('qwen image 2.1', {});
  });

  it('cascades to fallback when primary throws an error or times out', async () => {
    const primary: WebSearchProvider = {
      enabled: true,
      search: vi.fn().mockRejectedValue(new Error('Connection timeout')),
    };
    const fallback: WebSearchProvider = {
      enabled: true,
      search: vi.fn().mockResolvedValue({
        query: 'anything',
        results: [{ title: 'DuckDuckGo Hit', url: 'https://duckduckgo.com', content: 'Safe' }],
      }),
    };

    const multi = new MultiEngineSearchProvider({
      primary,
      fallbacks: [fallback],
    });

    const res = await multi.search('anything');
    expect(res?.results[0]?.title).toBe('DuckDuckGo Hit');
  });

  it('cascades through multiple fallbacks until one succeeds', async () => {
    const primary: WebSearchProvider = {
      enabled: true,
      search: vi.fn().mockResolvedValue(null),
    };
    const fallback1: WebSearchProvider = {
      enabled: true,
      search: vi.fn().mockResolvedValue({ query: 'x', results: [] }),
    };
    const fallback2: WebSearchProvider = {
      enabled: true,
      search: vi.fn().mockResolvedValue({
        query: 'x',
        results: [
          { title: 'Wikipedia Hit', url: 'https://en.wikipedia.org/wiki/X', content: 'Fact' },
        ],
      }),
    };

    const multi = new MultiEngineSearchProvider({
      primary,
      fallbacks: [fallback1, fallback2],
    });

    const res = await multi.search('x');
    expect(res?.results[0]?.title).toBe('Wikipedia Hit');
  });
});

describe('DuckDuckGoSearchProvider & WikipediaSearchProvider configuration', () => {
  it('instantiates correctly and respects enabled flag', () => {
    const ddg = new DuckDuckGoSearchProvider({ enabled: false });
    expect(ddg.enabled).toBe(false);

    const wiki = new WikipediaSearchProvider({ enabled: true });
    expect(wiki.enabled).toBe(true);
  });
});
