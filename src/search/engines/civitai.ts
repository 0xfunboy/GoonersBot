import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-civitai');

export interface CivitaiEngineConfig {
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

interface CivitaiModelItem {
  id: number;
  name: string;
  type?: string;
  description?: string;
  creator?: {
    username?: string;
  };
  stats?: {
    downloadCount?: number;
    favoriteCount?: number;
    thumbsUpCount?: number;
  };
  modelVersions?: Array<{
    name?: string;
    trainedWords?: string[];
  }>;
}

interface CivitaiResponse {
  items?: CivitaiModelItem[];
}

/** Strip basic HTML tags for clean snippets */
function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Native Civitai search engine.
 * Discovers diffusion models, LoRAs, checkpoints, and trigger words for image generation.
 */
export class CivitaiEngine implements SearchEngine {
  readonly id = 'civitai';
  readonly name = 'Civitai';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['it', 'general', 'images'];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: CivitaiEngineConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.weight = cfg.weight ?? 1.8;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim().replace(/^https?:\/\/civitai\.com\/(?:models\/)?/i, '');
    const max = opts.max ?? 6;
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'Civitai API search');

    try {
      const url = new URL('https://civitai.com/api/v1/models');
      url.searchParams.set('query', cleanQuery);
      url.searchParams.set('limit', String(Math.min(10, max)));

      const headers = {
        'User-Agent': 'GoonerBot/2.0 (Mozilla/5.0; Civitai Integration)',
        Accept: 'application/json',
      };

      const res = await fetch(url, { signal: scope.signal, headers });
      if (!res.ok) {
        log.warn({ status: res.status }, 'Civitai API request failed');
        return [];
      }

      const data = (await res.json()) as CivitaiResponse;
      const items = Array.isArray(data?.items) ? data.items : [];
      const results: WebSearchResult[] = [];

      for (const entry of items) {
        if (!entry.id || !entry.name) continue;
        const pageUrl = `https://civitai.com/models/${entry.id}`;
        const parts: string[] = [];

        if (entry.type) parts.push(`Type: ${entry.type}`);
        if (entry.creator?.username) parts.push(`Creator: ${entry.creator.username}`);
        if (typeof entry.stats?.downloadCount === 'number') {
          parts.push(`Downloads: ${entry.stats.downloadCount.toLocaleString()}`);
        }

        // Collect trigger words from primary model version
        const trainedWords = entry.modelVersions?.[0]?.trainedWords;
        if (Array.isArray(trainedWords) && trainedWords.length > 0) {
          parts.push(`Triggers: ${trainedWords.slice(0, 5).join(', ')}`);
        }

        if (entry.description) {
          parts.push(stripHtml(entry.description).slice(0, 160));
        }

        results.push({
          title: `Civitai: ${entry.name} (${entry.type ?? 'Model'})`,
          url: pageUrl,
          content: `[CIVITAI ${entry.type?.toUpperCase() ?? 'MODEL'}] ${entry.name} | ${parts.join(' | ')}`,
          engine: this.id,
        });
      }

      return results;
    } catch (err) {
      log.debug({ err, query: cleanQuery }, 'Civitai search request failed');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
