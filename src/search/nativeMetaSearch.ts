import { childLogger } from '../utils/logger.js';
import { createAbortScope } from '../utils/abort.js';
import type {
  WebSearchProvider,
  WebSearchResponse,
  WebSearchResult,
  SearchEngine,
  SearchCategory,
} from './types.js';
import { DuckDuckGoEngine } from './engines/duckduckgo.js';
import { HuggingFaceEngine } from './engines/huggingface.js';
import { WikipediaEngine } from './engines/wikipedia.js';
import { MojeekEngine } from './engines/mojeek.js';
import { GitHubEngine } from './engines/github.js';
import { RedditEngine } from './engines/reddit.js';
import { SearxngBridgeEngine } from './engines/searxngBridge.js';

const log = childLogger('native-meta-search');

export interface NativeMetaSearchConfig {
  enabled?: boolean;
  searxngUrl?: string;
  timeoutMs?: number;
  maxResults?: number;
  engines?: SearchEngine[];
}

/** Strip analytics and tracking parameters from URLs for deduplication. */
function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'ref',
      'ref_src',
    ];
    for (const p of trackingParams) {
      parsed.searchParams.delete(p);
    }
    // Remove trailing slash for path consistency
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    parsed.pathname = pathname;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/** Calculate word overlap ratio between query tokens and text. */
function calculateTokenOverlap(queryWords: string[], target: string): number {
  if (queryWords.length === 0 || !target) return 0;
  const lower = target.toLowerCase();
  let matches = 0;
  for (const w of queryWords) {
    if (lower.includes(w)) matches++;
  }
  return matches / queryWords.length;
}

/**
 * Native MetaSearch Engine.
 * Embedded in-process search system with parallel multi-engine dispatch,
 * canonical URL deduplication, consensus ranking, and zero external daemon dependencies.
 */
export class NativeMetaSearch implements WebSearchProvider {
  private readonly engines: SearchEngine[];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;
  private readonly maxResults: number;

  constructor(cfg: NativeMetaSearchConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.timeoutMs = cfg.timeoutMs ?? 8000;
    this.maxResults = cfg.maxResults ?? 8;

    if (cfg.engines) {
      this.engines = cfg.engines;
    } else {
      this.engines = [
        new DuckDuckGoEngine({ enabled: true, timeoutMs: 6000 }),
        new HuggingFaceEngine({ enabled: true, timeoutMs: 5000 }),
        new WikipediaEngine({ enabled: true, timeoutMs: 5000 }),
        new MojeekEngine({ enabled: true, timeoutMs: 5000 }),
        new GitHubEngine({ enabled: true, timeoutMs: 5000 }),
        new RedditEngine({ enabled: true, timeoutMs: 5000 }),
        new SearxngBridgeEngine({
          baseUrl: cfg.searxngUrl,
          enabled: Boolean(cfg.searxngUrl),
          timeoutMs: 6000,
        }),
      ];
    }
  }

  get enabled(): boolean {
    return this.isEnabled && this.engines.some((e) => e.enabled);
  }

  /**
   * Run parallel meta-search across active native engines with consensus ranking.
   */
  async search(
    query: string,
    opts: {
      language?: string;
      max?: number;
      categories?: SearchCategory;
      signal?: AbortSignal;
    } = {},
  ): Promise<WebSearchResponse | null> {
    if (!this.enabled || !query.trim()) return null;
    const cleanQuery = query.trim();
    const max = opts.max ?? this.maxResults;
    const lowerQuery = cleanQuery.toLowerCase();
    const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 2);

    // Intent detection
    const isModelQuery =
      /huggingface|hf\.co|model|weights|qwen|llama|flux|stable-diffusion|lora|safetensors|checkpoint/i.test(
        lowerQuery,
      );
    const isCodeQuery = /github|repo|repository|npm|pip|pypi|crate|golang|python|library/i.test(
      lowerQuery,
    );
    const isDiscussionQuery = /reddit|pareri|opinioni|consiglio|forum/i.test(lowerQuery);

    // Filter candidate engines
    const candidateEngines = this.engines.filter((engine) => {
      if (!engine.enabled) return false;
      if (isModelQuery && engine.id === 'huggingface') return true;
      if (isCodeQuery && engine.id === 'github') return true;
      if (isDiscussionQuery && engine.id === 'reddit') return true;
      // General categories
      return engine.categories.includes('general');
    });

    const activeEngines =
      candidateEngines.length > 0 ? candidateEngines : this.engines.filter((e) => e.enabled);
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'Native MetaSearch');

    try {
      // Parallel execution with individual engine resilience
      const enginePromises = activeEngines.map(async (engine) => {
        try {
          const results = await engine.search(cleanQuery, {
            language: opts.language,
            max: Math.max(5, max),
            signal: scope.signal,
          });
          return { engine, results };
        } catch (err) {
          log.debug({ err, engine: engine.id }, 'engine search rejected');
          return { engine, results: [] };
        }
      });

      const settled = await Promise.all(enginePromises);

      // Aggregate and deduplicate
      const urlMap = new Map<
        string,
        {
          result: WebSearchResult;
          engineIds: Set<string>;
          score: number;
        }
      >();

      for (const { engine, results } of settled) {
        for (const item of results) {
          if (!item.url || !item.title) continue;
          const canonical = normalizeUrl(item.url);
          const existing = urlMap.get(canonical);

          if (existing) {
            existing.engineIds.add(engine.id);
            // Consensus bonus: multiple independent engines agreeing on a link
            existing.score += 25 * engine.weight;
            // Retain the longer, more informative snippet
            if ((item.content?.length ?? 0) > (existing.result.content?.length ?? 0)) {
              existing.result.content = item.content;
            }
          } else {
            // Initial score calculation
            let initialScore = engine.weight * 10;
            const titleLower = item.title.toLowerCase();

            // Exact phrase match
            if (titleLower.includes(lowerQuery)) {
              initialScore += 40;
            } else {
              // Token overlap
              initialScore += calculateTokenOverlap(queryWords, item.title) * 20;
            }

            // Snippet token overlap
            if (item.content) {
              initialScore += calculateTokenOverlap(queryWords, item.content) * 10;
            }

            // Specific intent boost
            if (isModelQuery && engine.id === 'huggingface') {
              initialScore += 35;
            }

            urlMap.set(canonical, {
              result: { ...item, url: canonical, engine: engine.id },
              engineIds: new Set([engine.id]),
              score: initialScore,
            });
          }
        }
      }

      const ranked = [...urlMap.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map((entry) => ({
          ...entry.result,
          score: Math.round(entry.score),
        }));

      if (ranked.length === 0) return null;

      // Extract instant answer if available (e.g. from Wikipedia or top high-confidence result)
      let answer: string | undefined;
      const topWiki = ranked.find((r) => r.engine === 'wikipedia' && r.content);
      if (topWiki && topWiki.content.length > 40) {
        answer = `${topWiki.title}: ${topWiki.content.slice(0, 300)}`;
      } else if (ranked[0] && ranked[0].score >= 40 && ranked[0].content.length > 50) {
        answer = ranked[0].content.slice(0, 300);
      }

      return {
        query: cleanQuery,
        results: ranked,
        ...(answer ? { answer } : {}),
      };
    } finally {
      scope.dispose();
    }
  }

  /**
   * Parallel image search across image-capable native engines.
   */
  async searchImages(
    query: string,
    opts: { language?: string; max?: number; signal?: AbortSignal } = {},
  ): Promise<string[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim();
    const max = opts.max ?? 20;
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'Native Image Search');

    const imageEngines = this.engines.filter(
      (e) => e.enabled && typeof e.searchImages === 'function',
    );
    if (imageEngines.length === 0) return [];

    try {
      const settled = await Promise.all(
        imageEngines.map(async (engine) => {
          try {
            return await engine.searchImages!(cleanQuery, {
              language: opts.language,
              max,
              signal: scope.signal,
            });
          } catch {
            return [];
          }
        }),
      );

      const seen = new Set<string>();
      const candidateUrls: string[] = [];

      for (const urls of settled) {
        for (const u of urls) {
          if (!seen.has(u)) {
            seen.add(u);
            candidateUrls.push(u);
            if (candidateUrls.length >= max) break;
          }
        }
        if (candidateUrls.length >= max) break;
      }

      return candidateUrls;
    } finally {
      scope.dispose();
    }
  }
}
