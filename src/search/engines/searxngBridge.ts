import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-searxng-bridge');

export interface SearxngBridgeConfig {
  baseUrl?: string;
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

/**
 * Optional bridge to an external/legacy SearXNG daemon or public instance.
 */
export class SearxngBridgeEngine implements SearchEngine {
  readonly id = 'searxng';
  readonly name = 'SearXNG Bridge';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['general', 'images', 'it'];
  private readonly baseUrl?: string;
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: SearxngBridgeConfig = {}) {
    this.baseUrl = cfg.baseUrl?.replace(/\/+$/, '');
    this.isEnabled = Boolean(cfg.enabled && this.baseUrl);
    this.weight = cfg.weight ?? 1.2;
    this.timeoutMs = cfg.timeoutMs ?? 6000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !this.baseUrl || !query.trim()) return [];
    const cleanQuery = query.trim();
    const max = opts.max ?? 8;
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', cleanQuery);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '0');

    const scope = createAbortScope(this.timeoutMs, opts.signal, 'SearXNG Bridge');
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: scope.signal,
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        results?: Array<{ title?: string; url: string; content?: string }>;
      };

      const results: WebSearchResult[] = [];
      for (const r of json.results ?? []) {
        if (!r.url || (!r.title && !r.content)) continue;
        results.push({
          title: (r.title ?? '').trim(),
          url: r.url,
          content: (r.content ?? '').trim().slice(0, 320),
          engine: this.id,
        });
        if (results.length >= max) break;
      }
      return results;
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'SearXNG bridge request failed');
      return [];
    } finally {
      scope.dispose();
    }
  }

  async searchImages(query: string, opts: SearchEngineOptions = {}): Promise<string[]> {
    if (!this.enabled || !this.baseUrl || !query.trim()) return [];
    const cleanQuery = query.trim();
    const max = opts.max ?? 20;
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', cleanQuery);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'images');
    url.searchParams.set('safesearch', '0');

    const scope = createAbortScope(this.timeoutMs, opts.signal, 'SearXNG Bridge Images');
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: scope.signal,
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        results?: Array<{ img_src?: string; thumbnail_src?: string }>;
      };
      const urls = (json.results ?? [])
        .map((r) => r.img_src || r.thumbnail_src)
        .filter((u): u is string => Boolean(u && /^https?:\/\//i.test(u)));

      return urls.slice(0, max);
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'SearXNG bridge image search failed');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
