import * as cheerio from 'cheerio';
import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-mojeek');

export interface MojeekEngineConfig {
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

/**
 * Mojeek search engine.
 * Independent privacy web index with complete crawler independence.
 */
export class MojeekEngine implements SearchEngine {
  readonly id = 'mojeek';
  readonly name = 'Mojeek';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['general'];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: MojeekEngineConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.weight = cfg.weight ?? 1.2;
    this.timeoutMs = cfg.timeoutMs ?? 6000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim();
    const max = opts.max ?? 8;
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'Mojeek search');

    try {
      const url = `https://www.mojeek.com/search?q=${encodeURIComponent(cleanQuery)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: scope.signal,
      });

      if (!res.ok) return [];
      const html = await res.text();
      const $ = cheerio.load(html);
      const results: WebSearchResult[] = [];

      $('.results-standard > li, .results > li').each((_, elem) => {
        if (results.length >= max) return false;
        const $li = $(elem);
        const titleAnchor = $li.find('a.ob, a.title, h2 a').first();
        const title = titleAnchor.text().trim();
        const rawUrl = titleAnchor.attr('href') || '';
        const snippet = $li.find('p.s, .snippet, p').first().text().trim().slice(0, 320);

        if (title && rawUrl && /^https?:\/\//i.test(rawUrl)) {
          results.push({
            title,
            url: rawUrl,
            content: snippet || title,
            engine: this.id,
          });
        }
      });

      return results;
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'Mojeek search failed');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
