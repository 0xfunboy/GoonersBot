/**
 * Search and grounding abstraction.
 * Native, resilient meta-search embedded directly within GoonerBot:
 *   - Native engines: DuckDuckGo, HuggingFace, Wikipedia, Mojeek, GitHub, Reddit, ArXiv
 *   - NativeMetaSearch aggregator: parallel execution, circuit breakers, deduplication, consensus ranking
 *   - Optional external bridge: legacy SearXNG instances if configured
 */

export interface WebSearchResult {
  title: string;
  url: string;
  /** short snippet/abstract */
  content: string;
  /** engine identifier that discovered this result */
  engine?: string;
  /** relevance score calculated during meta-search aggregation */
  score?: number;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  /** instant answer / infobox text when available */
  answer?: string;
}

export interface WebSearchProvider {
  readonly enabled: boolean;
  search(
    query: string,
    opts?: {
      language?: string;
      max?: number;
      categories?: 'general' | 'videos' | 'images' | 'it' | 'science' | 'social';
      signal?: AbortSignal;
    },
  ): Promise<WebSearchResponse | null>;

  searchImages?(
    query: string,
    opts?: {
      language?: string;
      max?: number;
      signal?: AbortSignal;
    },
  ): Promise<string[]>;
}

export type SearchCategory = 'general' | 'it' | 'images' | 'videos' | 'science' | 'social';

export interface SearchEngineOptions {
  language?: string;
  max?: number;
  categories?: SearchCategory[];
  signal?: AbortSignal;
}

/**
 * Modular native search engine contract.
 * Each engine encapsulates fetching, parsing, and normalizing results from a single provider.
 */
export interface SearchEngine {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly weight: number;
  readonly categories: SearchCategory[];

  search(query: string, opts?: SearchEngineOptions): Promise<WebSearchResult[]>;
  searchImages?(query: string, opts?: SearchEngineOptions): Promise<string[]>;
}
