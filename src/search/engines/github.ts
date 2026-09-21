import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-github');

export interface GitHubEngineConfig {
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

interface GhRepoItem {
  full_name: string;
  html_url: string;
  description?: string;
  stargazers_count?: number;
  language?: string;
}

export class GitHubEngine implements SearchEngine {
  readonly id = 'github';
  readonly name = 'GitHub';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['it', 'general'];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: GitHubEngineConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.weight = cfg.weight ?? 1.3;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim().replace(/^https?:\/\/github\.com\//i, '');
    const max = opts.max ?? 5;
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'GitHub repository search');

    try {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(cleanQuery)}&per_page=${max}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'GoonerBot/2.0 (Open-Source Research)',
          Accept: 'application/vnd.github.v3+json',
        },
        signal: scope.signal,
      });

      if (!res.ok) return [];
      const data = (await res.json()) as { items?: GhRepoItem[] };
      const results: WebSearchResult[] = [];

      for (const item of data.items ?? []) {
        if (!item.full_name || !item.html_url) continue;
        const parts: string[] = [];
        if (item.language) parts.push(`[${item.language}]`);
        if (typeof item.stargazers_count === 'number') {
          parts.push(`★ ${item.stargazers_count.toLocaleString()}`);
        }
        if (item.description) parts.push(item.description.slice(0, 200));

        results.push({
          title: `GitHub: ${item.full_name}`,
          url: item.html_url,
          content: `[GITHUB REPOSITORY] ${item.full_name} | ${parts.join(' | ')}`,
          engine: this.id,
        });
      }

      return results;
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'GitHub search failed');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
