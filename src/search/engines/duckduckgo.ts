import * as cheerio from 'cheerio';
import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-duckduckgo');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

export interface DuckDuckGoEngineConfig {
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

function extractActualUrl(rawHref: string): string {
  if (!rawHref) return '';
  try {
    const fullUrl = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref;
    if (fullUrl.includes('duckduckgo.com/l/?') || fullUrl.includes('/l/?uddg=')) {
      const parsed = new URL(fullUrl);
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
    return fullUrl;
  } catch {
    return rawHref;
  }
}

/**
 * Native DuckDuckGo web & image search engine.
 */
export class DuckDuckGoEngine implements SearchEngine {
  readonly id = 'duckduckgo';
  readonly name = 'DuckDuckGo';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['general', 'images'];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: DuckDuckGoEngineConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.weight = cfg.weight ?? 1.5;
    this.timeoutMs = cfg.timeoutMs ?? 7000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim();
    const max = opts.max ?? 8;

    // First attempt: HTML endpoint
    const htmlResults = await this.searchHtml(cleanQuery, max, opts.signal);
    if (htmlResults.length > 0) return htmlResults;

    // Fallback attempt: Lite endpoint
    log.debug({ query: cleanQuery }, 'DDG HTML yielded 0 hits, trying Lite endpoint');
    return this.searchLite(cleanQuery, max, opts.signal);
  }

  async searchImages(query: string, opts: SearchEngineOptions = {}): Promise<string[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim();
    const max = opts.max ?? 20;
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'DDG Image Search');

    try {
      // Step 1: obtain VQD token from search page
      const ua = USER_AGENTS[0]!;
      const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}`, {
        headers: { 'User-Agent': ua },
        signal: scope.signal,
      });
      if (!tokenRes.ok) return [];

      const tokenText = await tokenRes.text();
      const vqdMatch = tokenText.match(/vqd=(["']?)([\d-]+)\1/) || tokenText.match(/vqd=([\d-]+)/);
      const vqd = vqdMatch?.[2] || vqdMatch?.[1];
      if (!vqd) return [];

      // Step 2: query image API
      const imgUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(cleanQuery)}&vqd=${vqd}&f=,,,&p=1`;
      const imgRes = await fetch(imgUrl, {
        headers: {
          'User-Agent': ua,
          Accept: 'application/json',
          Referer: 'https://duckduckgo.com/',
        },
        signal: scope.signal,
      });

      if (!imgRes.ok) return [];
      const data = (await imgRes.json()) as {
        results?: Array<{ image?: string; thumbnail?: string }>;
      };
      const urls = (data.results ?? [])
        .map((r) => r.image || r.thumbnail)
        .filter((u): u is string => Boolean(u && /^https?:\/\//i.test(u)));

      return urls.slice(0, max);
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'DDG image search failed');
      return [];
    } finally {
      scope.dispose();
    }
  }

  private async searchHtml(
    query: string,
    max: number,
    parentSignal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    const scope = createAbortScope(this.timeoutMs, parentSignal, 'DDG HTML search');
    try {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
      const params = new URLSearchParams({ q: query, b: '' });
      const res = await fetch('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: {
          'User-Agent': ua,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        body: params.toString(),
        signal: scope.signal,
      });

      if (!res.ok) return [];
      const html = await res.text();
      const $ = cheerio.load(html);
      const results: WebSearchResult[] = [];

      $('.result').each((_, elem) => {
        if (results.length >= max) return false;
        const $el = $(elem);
        if ($el.hasClass('result--ad')) return;

        const titleAnchor = $el.find('a.result__a');
        const title = titleAnchor.text().trim();
        const rawHref = titleAnchor.attr('href') || '';
        const url = extractActualUrl(rawHref);
        const snippet = $el.find('.result__snippet').text().trim().slice(0, 320);

        if (title && url && /^https?:\/\//i.test(url)) {
          results.push({ title, url, content: snippet, engine: this.id });
        }
      });

      return results;
    } catch (err) {
      log.warn({ err }, 'DDG HTML search error');
      return [];
    } finally {
      scope.dispose();
    }
  }

  private async searchLite(
    query: string,
    max: number,
    parentSignal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    const scope = createAbortScope(this.timeoutMs, parentSignal, 'DDG Lite search');
    try {
      const ua = USER_AGENTS[0]!;
      const params = new URLSearchParams({ q: query });
      const res = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        headers: {
          'User-Agent': ua,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        body: params.toString(),
        signal: scope.signal,
      });

      if (!res.ok) return [];
      const html = await res.text();
      const $ = cheerio.load(html);
      const results: WebSearchResult[] = [];

      $('table tr').each((_, tr) => {
        if (results.length >= max) return false;
        const $tr = $(tr);
        const linkAnchor = $tr.find('a.result-link');
        if (linkAnchor.length > 0) {
          const title = linkAnchor.text().trim();
          const rawHref = linkAnchor.attr('href') || '';
          const url = extractActualUrl(rawHref);
          const snippet = $tr.next('tr').find('td.result-snippet').text().trim().slice(0, 320);
          if (title && url && /^https?:\/\//i.test(url)) {
            results.push({ title, url, content: snippet, engine: this.id });
          }
        }
      });

      return results;
    } catch (err) {
      log.warn({ err }, 'DDG Lite search error');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
