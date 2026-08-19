import { AnimeUnityAdapter } from './animeUnity.js';
import {
  SafeAnimeArchiveHttpClient,
  type AnimeArchiveHttpClient,
  type SafeAnimeArchiveHttpClientOptions,
} from './http.js';
import { HentaiSaturnAdapter } from './hentaiSaturn.js';
import {
  AnimeArchiveError,
  type AnimeArchiveSearchResult,
  type AnimeArchiveSource,
  type AnimeSourceAdapter,
  type AnimeUrlClassification,
} from './types.js';

export interface ResolvedAnimeSource {
  adapter: AnimeSourceAdapter;
  classification: AnimeUrlClassification;
}

export interface DefaultAnimeSourceRegistryOptions extends SafeAnimeArchiveHttpClientOptions {
  /** Injectable transport for deterministic tests or a process-wide safe client. */
  http?: AnimeArchiveHttpClient | undefined;
}

/** Registry for URL dispatch and small, live, non-persisted availability searches. */
export class AnimeSourceRegistry {
  readonly adapters: readonly AnimeSourceAdapter[];
  private readonly bySource: ReadonlyMap<AnimeArchiveSource, AnimeSourceAdapter>;

  constructor(adapters: readonly AnimeSourceAdapter[]) {
    const bySource = new Map<AnimeArchiveSource, AnimeSourceAdapter>();
    for (const adapter of adapters) {
      if (bySource.has(adapter.source)) {
        throw new Error(`duplicate anime source adapter: ${adapter.source}`);
      }
      bySource.set(adapter.source, adapter);
    }
    this.adapters = Object.freeze([...adapters]);
    this.bySource = bySource;
  }

  get(source: AnimeArchiveSource): AnimeSourceAdapter {
    const adapter = this.bySource.get(source);
    if (!adapter) {
      throw new AnimeArchiveError(
        'unsupported_url',
        `anime source adapter is not registered: ${source}`,
      );
    }
    return adapter;
  }

  classify(url: string | URL): AnimeUrlClassification | null {
    for (const adapter of this.adapters) {
      const classification = adapter.classify(url);
      if (classification) return classification;
    }
    return null;
  }

  resolve(url: string | URL): ResolvedAnimeSource {
    for (const adapter of this.adapters) {
      const classification = adapter.classify(url);
      if (classification) return { adapter, classification };
    }
    throw new AnimeArchiveError('unsupported_url', 'unsupported anime archive URL');
  }

  /**
   * Queries every searchable adapter concurrently. Individual source failures are isolated and
   * successful result sets are interleaved so one source cannot monopolise a small limit.
   */
  async search(
    query: string,
    limit = 5,
    signal?: AbortSignal,
  ): Promise<AnimeArchiveSearchResult[]> {
    const normalized = query.trim().replace(/\s+/g, ' ');
    if (normalized.length < 2) return [];
    signal?.throwIfAborted();
    const boundedLimit = Math.min(10, Math.max(1, Math.trunc(limit) || 1));
    const searchable = this.adapters.filter(
      (adapter): adapter is AnimeSourceAdapter & Required<Pick<AnimeSourceAdapter, 'search'>> =>
        typeof adapter.search === 'function',
    );
    const settled = await Promise.allSettled(
      searchable.map((adapter) => adapter.search(normalized, boundedLimit, signal)),
    );
    signal?.throwIfAborted();

    const buckets = settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : []));
    const results: AnimeArchiveSearchResult[] = [];
    const seen = new Set<string>();
    for (let offset = 0; results.length < boundedLimit; offset += 1) {
      let consumed = false;
      for (const bucket of buckets) {
        const result = bucket[offset];
        if (!result) continue;
        consumed = true;
        const key = `${result.source}\u0000${result.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(result);
        if (results.length >= boundedLimit) break;
      }
      if (!consumed) break;
    }
    return results;
  }
}

export function createDefaultAnimeSourceRegistry(
  options: DefaultAnimeSourceRegistryOptions = {},
): AnimeSourceRegistry {
  const { http, ...httpOptions } = options;
  const client = http ?? new SafeAnimeArchiveHttpClient(httpOptions);
  return new AnimeSourceRegistry([new AnimeUnityAdapter(client), new HentaiSaturnAdapter(client)]);
}
