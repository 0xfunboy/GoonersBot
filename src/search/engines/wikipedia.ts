import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-wikipedia');

export interface WikipediaEngineConfig {
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

export class WikipediaEngine implements SearchEngine {
  readonly id = 'wikipedia';
  readonly name = 'Wikipedia & Wikimedia';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['general', 'science', 'images'];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: WikipediaEngineConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.weight = cfg.weight ?? 1.4;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim();
    const max = opts.max ?? 5;
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
          'User-Agent': 'GoonerBot/2.0 (Search Engine; contact@goonersbot.org)',
          Accept: 'application/json',
        },
      });

      if (!res.ok) return [];
      const data = (await res.json()) as [string, string[], string[], string[]];
      const [, titles, descriptions, urls] = data;

      if (!titles || titles.length === 0) {
        if (lang !== 'en') {
          return this.search(cleanQuery, { ...opts, language: 'english' });
        }
        return [];
      }

      const results: WebSearchResult[] = [];
      for (let i = 0; i < titles.length; i++) {
        const title = titles[i]?.trim();
        const snippet = (descriptions[i] ?? '').trim().slice(0, 320);
        const link = urls[i]?.trim();
        if (title && link) {
          results.push({
            title,
            content: snippet || `${title} on Wikipedia`,
            url: link,
            engine: this.id,
          });
        }
      }

      return results;
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'Wikipedia search failed');
      return [];
    } finally {
      scope.dispose();
    }
  }

  async searchImages(query: string, opts: SearchEngineOptions = {}): Promise<string[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim();
    const max = opts.max ?? 10;
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'Wikimedia Image Search');

    try {
      const url = new URL('https://commons.wikimedia.org/w/api.php');
      url.searchParams.set('action', 'query');
      url.searchParams.set('generator', 'search');
      url.searchParams.set('gsrnamespace', '6'); // File namespace
      url.searchParams.set('gsrsearch', cleanQuery);
      url.searchParams.set('gsrlimit', String(max));
      url.searchParams.set('prop', 'imageinfo');
      url.searchParams.set('iiprop', 'url');
      url.searchParams.set('format', 'json');

      const res = await fetch(url, {
        signal: scope.signal,
        headers: {
          'User-Agent': 'GoonerBot/2.0 (Wikimedia Client)',
          Accept: 'application/json',
        },
      });

      if (!res.ok) return [];
      const data = (await res.json()) as {
        query?: {
          pages?: Record<string, { imageinfo?: Array<{ url?: string }> }>;
        };
      };

      const pages = data.query?.pages ?? {};
      const urls: string[] = [];
      for (const page of Object.values(pages)) {
        const fileUrl = page.imageinfo?.[0]?.url;
        if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
          urls.push(fileUrl);
        }
      }

      return urls;
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'Wikimedia Commons image search failed');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
