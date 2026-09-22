import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-arxiv');

export interface ArXivEngineConfig {
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

/** Decode common XML entities */
function decodeXml(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Native ArXiv search engine.
 * Discovers scientific papers, machine learning research, and preprints.
 */
export class ArXivEngine implements SearchEngine {
  readonly id = 'arxiv';
  readonly name = 'ArXiv';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['science', 'it', 'general'];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: ArXivEngineConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.weight = cfg.weight ?? 1.7;
    this.timeoutMs = cfg.timeoutMs ?? 6000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query
      .trim()
      .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, '')
      .replace(/\.pdf$/i, '');
    const max = opts.max ?? 5;
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'ArXiv API search');

    try {
      const url = new URL('https://export.arxiv.org/api/query');
      url.searchParams.set('search_query', `all:${cleanQuery}`);
      url.searchParams.set('start', '0');
      url.searchParams.set('max_results', String(Math.min(8, max)));
      url.searchParams.set('sortBy', 'relevance');

      const headers = {
        'User-Agent': 'GoonerBot/2.0 (ArXiv Research Client)',
        Accept: 'application/atom+xml, application/xml',
      };

      const res = await fetch(url, { signal: scope.signal, headers });
      if (!res.ok) {
        log.warn({ status: res.status }, 'ArXiv API request failed');
        return [];
      }

      const xml = await res.text();
      const results: WebSearchResult[] = [];

      // Parse <entry> blocks from Atom feed
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
      let match: RegExpExecArray | null;

      while ((match = entryRegex.exec(xml)) !== null && results.length < max) {
        const entryContent = match[1];
        if (!entryContent) continue;

        const idMatch = entryContent.match(/<id>(https?:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/);
        const titleMatch = entryContent.match(/<title>([\s\S]*?)<\/title>/);
        const summaryMatch = entryContent.match(/<summary>([\s\S]*?)<\/summary>/);
        const publishedMatch = entryContent.match(/<published>([^<]+)<\/published>/);

        const rawTitle = titleMatch?.[1];
        const rawUrl = idMatch?.[1];
        if (!rawTitle || !rawUrl) continue;

        const title = decodeXml(rawTitle);
        const paperUrl = rawUrl.trim();
        const summary = summaryMatch?.[1] ? decodeXml(summaryMatch[1]).slice(0, 240) : '';

        // Extract author names
        const authors: string[] = [];
        const authorRegex = /<author>\s*<name>([^<]+)<\/name>/g;
        let authorMatch: RegExpExecArray | null;
        while ((authorMatch = authorRegex.exec(entryContent)) !== null && authors.length < 3) {
          const authorName = authorMatch[1];
          if (authorName) {
            authors.push(decodeXml(authorName));
          }
        }

        const publishedYear = publishedMatch?.[1] ? publishedMatch[1].slice(0, 4) : '';
        const authorStr = authors.length > 0 ? authors.join(', ') : 'Unknown';

        results.push({
          title: `ArXiv: ${title}`,
          url: paperUrl,
          content: `[ARXIV PAPER] ${title} | Authors: ${authorStr}${publishedYear ? ` (${publishedYear})` : ''} | ${summary}`,
          engine: this.id,
        });
      }

      return results;
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'ArXiv search request failed');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
