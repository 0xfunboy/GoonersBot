import { childLogger } from '../../utils/logger.js';
import { createAbortScope } from '../../utils/abort.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  SearchCategory,
  WebSearchResult,
} from '../types.js';

const log = childLogger('search-engine-huggingface');

export interface HuggingFaceEngineConfig {
  enabled?: boolean;
  weight?: number;
  timeoutMs?: number;
}

interface HfModelItem {
  id: string;
  likes?: number;
  downloads?: number;
  tags?: string[];
  description?: string;
  createdAt?: string;
}

interface HfDatasetItem {
  id: string;
  likes?: number;
  downloads?: number;
  description?: string;
}

/**
 * Native Hugging Face Hub search engine.
 * Direct official API integration for AI models, weights, datasets and spaces.
 */
export class HuggingFaceEngine implements SearchEngine {
  readonly id = 'huggingface';
  readonly name = 'Hugging Face';
  readonly weight: number;
  readonly categories: SearchCategory[] = ['it', 'general', 'science'];
  private readonly isEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(cfg: HuggingFaceEngineConfig = {}) {
    this.isEnabled = cfg.enabled ?? true;
    this.weight = cfg.weight ?? 1.8;
    this.timeoutMs = cfg.timeoutMs ?? 6000;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async search(query: string, opts: SearchEngineOptions = {}): Promise<WebSearchResult[]> {
    if (!this.enabled || !query.trim()) return [];
    const cleanQuery = query.trim().replace(/^https?:\/\/huggingface\.co\//i, '');
    const max = opts.max ?? 8;
    const scope = createAbortScope(this.timeoutMs, opts.signal, 'HuggingFace Hub search');

    try {
      // 1. Search Models
      const modelsUrl = new URL('https://huggingface.co/api/models');
      modelsUrl.searchParams.set('search', cleanQuery);
      modelsUrl.searchParams.set('limit', String(max));
      modelsUrl.searchParams.set('full', 'false');

      const headers = {
        'User-Agent': 'GoonerBot/2.0 (HuggingFace Client)',
        Accept: 'application/json',
      };

      const res = await fetch(modelsUrl, { signal: scope.signal, headers });
      if (!res.ok) {
        log.warn({ status: res.status }, 'HuggingFace models API request failed');
        return [];
      }

      const data = (await res.json()) as HfModelItem[];
      const results: WebSearchResult[] = [];

      for (const entry of data) {
        if (!entry.id) continue;
        const url = `https://huggingface.co/${entry.id}`;
        const parts: string[] = [];
        if (typeof entry.likes === 'number') parts.push(`Likes: ${entry.likes}`);
        if (typeof entry.downloads === 'number')
          parts.push(`Downloads: ${entry.downloads.toLocaleString()}`);
        if (Array.isArray(entry.tags) && entry.tags.length > 0) {
          parts.push(`Tags: ${entry.tags.slice(0, 5).join(', ')}`);
        }
        if (entry.description) parts.push(entry.description.slice(0, 160));

        results.push({
          title: `Hugging Face: ${entry.id}`,
          url,
          content: parts.join(' | ') || `Official repository for ${entry.id} on Hugging Face Hub.`,
          engine: this.id,
        });
      }

      // If query looks like a dataset or no models found, check datasets as well
      if (results.length < max && /dataset|data|corpus/i.test(cleanQuery)) {
        try {
          const datasetsUrl = new URL('https://huggingface.co/api/datasets');
          datasetsUrl.searchParams.set('search', cleanQuery);
          datasetsUrl.searchParams.set('limit', String(max - results.length));
          const dRes = await fetch(datasetsUrl, { signal: scope.signal, headers });
          if (dRes.ok) {
            const dData = (await dRes.json()) as HfDatasetItem[];
            for (const item of dData) {
              if (!item.id) continue;
              results.push({
                title: `Hugging Face Dataset: ${item.id}`,
                url: `https://huggingface.co/datasets/${item.id}`,
                content: item.description || `Dataset repository for ${item.id} on Hugging Face.`,
                engine: this.id,
              });
            }
          }
        } catch {
          /* ignore dataset fallback error */
        }
      }

      return results.slice(0, max);
    } catch (err) {
      log.warn({ err, query: cleanQuery }, 'HuggingFace engine query error');
      return [];
    } finally {
      scope.dispose();
    }
  }
}
