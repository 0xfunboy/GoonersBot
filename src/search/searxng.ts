import { childLogger } from '../utils/logger.js';
import type { WebSearchProvider, WebSearchResponse, WebSearchResult } from './types.js';

const log = childLogger('searxng');

export interface SearxngConfig {
  enabled: boolean;
  baseUrl: string | undefined;
  timeoutMs: number;
  maxResults: number;
}

/** Chat language NAME → SearXNG language code (unknown → 'all'). */
function langToSearx(name?: string): string {
  switch (name) {
    case 'italian':
      return 'it';
    case 'english':
      return 'en';
    case 'russian':
      return 'ru';
    case 'spanish':
      return 'es';
    default:
      return 'all';
  }
}

/**
 * SearXNG text search via the JSON API (`/search?format=json`). Self-hosted, free, no key.
 * Returns ranked results + an instant answer/infobox when SearXNG aggregates one.
 */
export class SearxngProvider implements WebSearchProvider {
  constructor(private readonly cfg: SearxngConfig) {}

  get enabled(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.baseUrl);
  }

  async search(
    query: string,
    opts: { language?: string; max?: number } = {},
  ): Promise<WebSearchResponse | null> {
    if (!this.enabled || !this.cfg.baseUrl || !query.trim()) return null;
    const max = opts.max ?? this.cfg.maxResults;
    const url = new URL('/search', this.cfg.baseUrl);
    url.searchParams.set('q', query.trim());
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '0');
    const lang = langToSearx(opts.language);
    if (lang !== 'all') url.searchParams.set('language', lang);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        log.warn({ status: res.status }, 'searxng request failed');
        return null;
      }
      const json = (await res.json()) as SearxngResponse;
      const results: WebSearchResult[] = (json.results ?? [])
        .filter((r): r is { title?: string; url: string; content?: string } =>
          Boolean(r.url && (r.title || r.content)),
        )
        .slice(0, max)
        .map((r) => ({
          title: (r.title ?? '').trim(),
          url: r.url,
          content: (r.content ?? '').trim().slice(0, 320),
        }));
      const out: WebSearchResponse = { query, results };
      const answer = extractAnswer(json);
      if (answer) out.answer = answer;
      if (results.length === 0 && !answer) return null;
      return out;
    } catch (err) {
      log.warn({ err }, 'searxng search failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Image search → candidate image URLs (largest/original src first). */
  async searchImages(
    query: string,
    opts: { language?: string; max?: number } = {},
  ): Promise<string[]> {
    if (!this.enabled || !this.cfg.baseUrl || !query.trim()) return [];
    const url = new URL('/search', this.cfg.baseUrl);
    url.searchParams.set('q', query.trim());
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'images');
    url.searchParams.set('safesearch', '1');
    const lang = langToSearx(opts.language);
    if (lang !== 'all') url.searchParams.set('language', lang);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        results?: Array<{ img_src?: string; thumbnail_src?: string }>;
      };
      const urls = (json.results ?? [])
        .map((r) => r.img_src || r.thumbnail_src)
        .filter((u): u is string => Boolean(u && /^https?:\/\//.test(u)));
      return urls.slice(0, opts.max ?? 20);
    } catch (err) {
      log.warn({ err }, 'searxng image search failed');
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

/** SearXNG answers/infoboxes vary by version (string or object); normalize to one line. */
function extractAnswer(json: SearxngResponse): string | undefined {
  const ans = json.answers?.[0];
  if (typeof ans === 'string' && ans.trim()) return ans.trim().slice(0, 400);
  if (ans && typeof ans === 'object' && typeof ans.answer === 'string' && ans.answer.trim()) {
    return ans.answer.trim().slice(0, 400);
  }
  const box = json.infoboxes?.[0];
  if (box && typeof box.content === 'string' && box.content.trim()) {
    return box.content.trim().slice(0, 400);
  }
  return undefined;
}

interface SearxngResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
  answers?: Array<string | { answer?: string }>;
  infoboxes?: Array<{ content?: string }>;
}
