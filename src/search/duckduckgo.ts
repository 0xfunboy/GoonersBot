import * as cheerio from 'cheerio';
import { childLogger } from '../utils/logger.js';
import type { WebSearchProvider, WebSearchResponse, WebSearchResult } from './types.js';
import { createAbortScope } from '../utils/abort.js';

const log = childLogger('duckduckgo-search');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

export interface DuckDuckGoConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxResults?: number;
}

/**
 * Extract true target URL from DuckDuckGo redirect link:
 * e.g. //duckduckgo.com/l/?uddg=https%3A%2F%2Fhuggingface.co%2FQwen...&rut=...
 */
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
 * Standalone, direct DuckDuckGo search provider.
 * Uses html.duckduckgo.com and lite.duckduckgo.com to guarantee web search capability
 * even if local SearXNG is unavailable or returns 0 results.
 */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly isEnabled: boolean;

  constructor(cfg: DuckDuckGoConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.timeoutMs = cfg.timeoutMs ?? 7000;
    this.maxResults = cfg.maxResults ?? 8;
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

    // First attempt: HTML endpoint
    const htmlResults = await this.searchHtml(cleanQuery, max, opts.signal);
    if (htmlResults && htmlResults.results.length > 0) {
      return htmlResults;
    }

    // Fallback attempt: Lite endpoint
    log.debug({ query: cleanQuery }, 'DuckDuckGo HTML returned no results, trying Lite endpoint');
    const liteResults = await this.searchLite(cleanQuery, max, opts.signal);
    if (liteResults && liteResults.results.length > 0) {
      return liteResults;
    }

    return null;
  }

  private async searchHtml(
    query: string,
    max: number,
    parentSignal?: AbortSignal,
  ): Promise<WebSearchResponse | null> {
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

      if (!res.ok) {
        log.warn({ status: res.status }, 'DDG HTML request failed');
        return null;
      }

      const html = await res.text();
      const $ = cheerio.load(html);
      const results: WebSearchResult[] = [];

      $('.result').each((_, elem) => {
        if (results.length >= max) return false;
        const $el = $(elem);
        // Ignore ads
        if ($el.hasClass('result--ad')) return;

        const titleAnchor = $el.find('a.result__a');
        const title = titleAnchor.text().trim();
        const rawHref = titleAnchor.attr('href') || '';
        const url = extractActualUrl(rawHref);
        const snippet = $el.find('.result__snippet').text().trim().slice(0, 320);

        if (title && url && /^https?:\/\//i.test(url)) {
          results.push({ title, url, content: snippet });
        }
      });

      if (results.length === 0) return null;
      return { query, results };
    } catch (err) {
      log.warn({ err }, 'DDG HTML search failed');
      return null;
    } finally {
      scope.dispose();
    }
  }

  private async searchLite(
    query: string,
    max: number,
    parentSignal?: AbortSignal,
  ): Promise<WebSearchResponse | null> {
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

      if (!res.ok) return null;
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
          // The next row usually holds the snippet
          const snippet = $tr.next('tr').find('td.result-snippet').text().trim().slice(0, 320);
          if (title && url && /^https?:\/\//i.test(url)) {
            results.push({ title, url, content: snippet });
          }
        }
      });

      if (results.length === 0) return null;
      return { query, results };
    } catch (err) {
      log.warn({ err }, 'DDG Lite search failed');
      return null;
    } finally {
      scope.dispose();
    }
  }
}
