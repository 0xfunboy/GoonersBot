import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-reddit');

export interface RedditEngineConfig {
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

interface RedditPostData {
  title: string;
  subreddit_name_prefixed: string;
  selftext?: string;
  permalink: string;
  score?: number;
  num_comments?: number;
}

export class RedditEngine implements SearchEngine {
  readonly id = 'reddit';
  readonly name = 'Reddit';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['social', 'general'];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: RedditEngineConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.weight = cfg.weight ?? 1.1;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim();
    const max = opts.max ?? 5;
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'Reddit search');

    try {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(cleanQuery)}&limit=${max}&sort=relevance`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GoonerBot/2.0 Research',
          Accept: 'application/json',
        },
        signal: scope.signal,
      });

      if (!res.ok) return [];
      const json = (await res.json()) as {
        data?: {
          children?: Array<{ data: RedditPostData }>;
        };
      };

      const results: WebSearchResult[] = [];
      for (const child of json.data?.children ?? []) {
        const post = child.data;
        if (!post?.title || !post.permalink) continue;
        const fullUrl = `https://www.reddit.com${post.permalink}`;
        const parts: string[] = [];
        if (post.subreddit_name_prefixed) parts.push(`[${post.subreddit_name_prefixed}]`);
        if (typeof post.score === 'number') parts.push(`↑${post.score}`);
        if (post.selftext) parts.push(post.selftext.slice(0, 180));

        results.push({
          title: `Reddit: ${post.title}`,
          url: fullUrl,
          content: parts.join(' ') || post.title,
          engine: this.id,
        });
      }

      return results;
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'Reddit search failed');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
