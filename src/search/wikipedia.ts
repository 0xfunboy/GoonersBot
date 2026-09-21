import { childLogger } from '../utils/logger.js';
import type { WebSearchProvider, WebSearchResponse, WebSearchResult } from './types.js';
import { createAbortScope } from '../utils/abort.js';

const log = childLogger('wikipedia-search');

export interface WikipediaConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxResults?: number;
}

export class WikipediaSearchProvider implements WebSearchProvider {
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;
  private readonly maxResults: number;

  constructor(cfg: WikipediaConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
    this.maxResults = cfg.maxResults ?? 5;
  }

  get enabled(): boolean {
    return this.isEnabled;
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
    const cleanQuery = query.trim();
    const max = opts.max ?? this.maxResults;
    const lang = opts.language === 'english' ? 'en' : 'it';

    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'opensearch');
    url.searchParams.set('search', cleanQuery);
    url.searchParams.set('limit', String(max));
    url.searchParams.set('namespace', '0');
    url.searchParams.set('format', 'json');

    const scope = createAbortScope(this.timeoutMs, opts.signal, 'Wikipedia OpenSearch');
    try {
      const res = await fetch(url, {
        signal: scope.signal,
        headers: {
          'User-Agent': 'GoonerBot/2.0 (search-grounding; contact@goonersbot.org)',
          Accept: 'application/json',
        },
      });

      if (!res.ok) return null;
      const data = (await res.json()) as [string, string[], string[], string[]];
      const [, titles, descriptions, urls] = data;

      if (!titles || titles.length === 0) {
        // Fallback to English if Italian yielded no hits and requested language wasn't English
        if (lang !== 'en') {
          return this.search(cleanQuery, { ...opts, language: 'english' });
        }
        return null;
      }

      const results: WebSearchResult[] = [];
      for (let i = 0; i < titles.length; i++) {
        const title = titles[i]?.trim();
        const snippet = (descriptions[i] ?? '').trim().slice(0, 320);
        const link = urls[i]?.trim();
        if (title && link) {
          results.push({
            title,
            content: snippet || title,
            url: link,
          });
        }
      }

      if (results.length === 0) return null;
      return {
        query: cleanQuery,
        results,
        answer: results[0]?.content ? `${results[0].title}: ${results[0].content}` : undefined,
      };
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'wikipedia search failed');
      return null;
    } finally {
      scope.dispose();
    }
  }
}
