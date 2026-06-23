import type { EmbeddingsConfig } from '../config/index.js';
import type { LLMProvider } from '../providers/llm/types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('embedder');

export interface Embedder {
  readonly enabled: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

export class LLMEmbedder implements Embedder {
  private disabledAfterError = false;

  constructor(
    private readonly llm: LLMProvider,
    private readonly cfg: Pick<EmbeddingsConfig, 'enabled' | 'dim'>,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled && !this.disabledAfterError && this.llm.capabilities.embeddings;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.enabled || !this.llm.embed || texts.length === 0) return [];
    try {
      const vectors = await this.llm.embed(texts);
      return vectors.map((v) => (v.length === this.cfg.dim ? v : []));
    } catch (err) {
      this.disabledAfterError = true;
      log.warn({ err }, 'embedding endpoint unavailable; falling back to keyword retrieval');
      return [];
    }
  }
}

export class NullEmbedder implements Embedder {
  readonly enabled = false;

  async embed(): Promise<number[][]> {
    return [];
  }
}

export class QueryVectorCache {
  private readonly cache = new Map<string, Promise<number[]>>();

  constructor(private readonly embedder: Embedder) {}

  async vector(text: string): Promise<number[]> {
    const key = text.trim();
    if (!key || !this.embedder.enabled) return [];
    const existing = this.cache.get(key);
    if (existing) return existing;
    const promise = this.embedder.embed([key]).then((vectors) => vectors[0] ?? []);
    this.cache.set(key, promise);
    return promise;
  }
}

export function createEmbedder(llm: LLMProvider, cfg: EmbeddingsConfig): Embedder {
  if (!cfg.enabled || !llm.capabilities.embeddings) return new NullEmbedder();
  return new LLMEmbedder(llm, cfg);
}
