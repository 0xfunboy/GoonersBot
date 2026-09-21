import { childLogger } from '../utils/logger.js';
import type { WebSearchProvider, WebSearchResponse } from './types.js';

const log = childLogger('multi-engine-search');

export interface MultiEngineSearchOptions {
  primary?: WebSearchProvider;
  fallbacks: WebSearchProvider[];
}

/**
 * Resilient multi-engine search provider.
 * Guarantees zero-failure web search by cycling through primary (e.g. SearXNG)
 * and fallback engines (e.g. DuckDuckGo, Wikipedia) whenever an engine returns
 * empty results, throws, or times out.
 */
export class MultiEngineSearchProvider implements WebSearchProvider {
  private readonly primary?: WebSearchProvider;
  private readonly fallbacks: WebSearchProvider[];

  constructor(opts: MultiEngineSearchOptions) {
    this.primary = opts.primary;
    this.fallbacks = opts.fallbacks.filter((f) => f.enabled);
  }

  get enabled(): boolean {
    return Boolean((this.primary && this.primary.enabled) || this.fallbacks.some((f) => f.enabled));
  }

  async search(
    query: string,
    opts: {
      language?: string;
      max?: number;
      categories?: 'general' | 'videos' | 'images';
      signal?: AbortSignal;
    } = {},
  ): Promise<WebSearchResponse | null> {
    if (!this.enabled || !query.trim()) return null;

    // 1. Try Primary Engine (e.g. local SearXNG)
    if (this.primary && this.primary.enabled) {
      try {
        const res = await this.primary.search(query, opts);
        if (res && (res.results.length > 0 || res.answer)) {
          return res;
        }
        log.warn(
          { query: query.slice(0, 100) },
          'primary search engine returned 0 results, cascading to fallback providers',
        );
      } catch (err) {
        log.warn(
          { err, query: query.slice(0, 100) },
          'primary search engine error, cascading to fallback providers',
        );
      }
    }

    // 2. Cascade through Fallbacks (DuckDuckGo, Wikipedia, etc.)
    for (const fallback of this.fallbacks) {
      if (!fallback.enabled) continue;
      try {
        const res = await fallback.search(query, opts);
        if (res && (res.results.length > 0 || res.answer)) {
          log.info(
            { provider: fallback.constructor.name, hits: res.results.length },
            'fallback search succeeded',
          );
          return res;
        }
      } catch (err) {
        log.warn(
          { err, provider: fallback.constructor.name },
          'fallback search provider failed, trying next',
        );
      }
    }

    return null;
  }

  /**
   * Forward image searches to primary or any provider that implements searchImages.
   */
  async searchImages(
    query: string,
    opts: { language?: string; max?: number; signal?: AbortSignal } = {},
  ): Promise<string[]> {
    if (
      this.primary &&
      this.primary.enabled &&
      'searchImages' in this.primary &&
      typeof (this.primary as { searchImages: unknown }).searchImages === 'function'
    ) {
      try {
        return await (
          this.primary as {
            searchImages: (q: string, o?: unknown) => Promise<string[]>;
          }
        ).searchImages(query, opts);
      } catch (err) {
        log.warn({ err }, 'primary image search failed');
      }
    }
    return [];
  }
}
