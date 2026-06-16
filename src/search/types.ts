/**
 * Search/grounding abstraction. The free, self-hosted backend that powers the bot's "culture":
 *   - WebSearchProvider → SearXNG (self-hosted metasearch, no API key, no browser).
 *
 * Image questions ("who is this character", "what product is this") are grounded by having the
 * vision model IDENTIFY the subject and then searching that identification on SearXNG — this is
 * the robust free equivalent of Google Lens (which is now client-rendered and needs a headless
 * browser + a public image URL). Everything degrades to null so a broken backend never breaks a reply.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  /** short snippet/abstract */
  content: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  /** instant answer / infobox text when the engine provides one */
  answer?: string;
}

export interface WebSearchProvider {
  readonly enabled: boolean;
  search(
    query: string,
    opts?: { language?: string; max?: number },
  ): Promise<WebSearchResponse | null>;
}
