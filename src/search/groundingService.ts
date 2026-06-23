import { childLogger } from '../utils/logger.js';
import type { MediaProcessor } from '../providers/media/index.js';
import type { WebSearchProvider, WebSearchResponse } from './types.js';
import type { PageScanner, PageSummary } from './pageScanner.js';

const log = childLogger('grounding');

export interface GroundingConfig {
  webEnabled: boolean;
  imageEnabled: boolean;
  maxResults: number;
}

export interface GroundingResult {
  kind: 'web' | 'image';
  /** formatted context block injected into the generator prompt */
  block: string;
  query: string;
  sources: string[];
}

export interface GroundImageInput {
  imageBuffer: Buffer;
  imageMime: string;
  question: string;
  language?: string;
}

// Identity / product / "what is this" questions about an image → reverse-image grounding.
// No trailing \b: matches can end in accented chars (es. "chi è") where ASCII \b would fail.
const IMAGE_INTENT_RE =
  /\b(chi (è|e'|sarebbe)|chi sono|che personaggio|quale (anime|personaggio|gioco|film|serie)|che (cos|cosa)('?è| e'| è)|cos(a)?('?è| e'| è)|che prodotto|che modello|che marca|quale prodotto|dove (lo |la |li |si )?(compr|acquist|trov)|quanto costa|who (is|are|s) (this|that|she|he|it)|what('?s| is) (this|that|it)|which (anime|character|game|movie|show|product|model|brand)|what (anime|character|product|model|brand|game|movie)|where (can i |to )?(buy|get|find)|how much (is|does)|identify|reverse image)/i;

// Recency / factual questions a model can't know from training → web search grounding.
const WEB_INTENT_RE =
  /\b(oggi|ieri|stamattina|stasera|adesso|ultim[oaie]|recent[ei]|notizi[ae]|news|appena uscit|è uscit|quando esce|in uscita|prezzo|quanto costa|quotazione|classifica|chi ha vinto|risultat[oi]|meteo|aggiornament|versione|20(2[5-9]|3\d)|today|yesterday|latest|recent|breaking|just (released|announced|dropped)|release date|price of|how much (is|are|does)|who won|current|right now|stock|score|weather|update|version)/i;

const WHERE_TO_BUY_RE =
  /\b(dove (lo |la |si )?(compr|acquist|trov)|quanto costa|where (to |can i )?buy|price|how much)\b/i;

/**
 * GroundingService: decides (heuristic gating) whether a reply needs fresh web facts or a
 * reverse-image lookup, runs the free SearXNG backend, and returns an LLM-ready context block.
 * The persona model still writes the final reply - this only adds grounding, never a voice.
 */
export class GroundingService {
  constructor(
    private readonly web: WebSearchProvider,
    private readonly media: MediaProcessor,
    private readonly cfg: GroundingConfig,
    private readonly scanner?: PageScanner,
  ) {}

  get enabled(): boolean {
    // Both paths use the web backend (image lookup = vision identify + web search).
    return this.web.enabled && (this.cfg.webEnabled || this.cfg.imageEnabled);
  }

  /** True if the text looks like a "what/who is this image" or product question. */
  wantsImageLookup(question: string): boolean {
    return this.cfg.imageEnabled && this.web.enabled && IMAGE_INTENT_RE.test(question);
  }

  /** True if the text looks like it needs fresh/factual web info. */
  wantsWebSearch(question: string): boolean {
    return this.cfg.webEnabled && this.web.enabled && WEB_INTENT_RE.test(question);
  }

  /** Identify the pictured subject via the vision model, then enrich it with a web search. */
  async groundImage(input: GroundImageInput): Promise<GroundingResult | null> {
    if (!this.cfg.imageEnabled || !this.web.enabled) return null;
    const label = await this.media.identifyImage(input.imageBuffer, input.imageMime);
    if (!label) return null;
    const query = WHERE_TO_BUY_RE.test(input.question) ? `${label} prezzo acquisto` : label;
    const res = await this.web.search(query, {
      language: input.language,
      max: this.cfg.maxResults,
    });
    const block = this.formatImage(label, res);
    const sources = res?.results.map((r) => r.url) ?? [];
    log.debug({ label, hits: sources.length }, 'image grounding');
    return { kind: 'image', block, query, sources };
  }

  /** Run a web search for the given query and format the result block. */
  async groundWeb(query: string, language?: string): Promise<GroundingResult | null> {
    if (!this.cfg.webEnabled || !this.web.enabled || !query.trim()) return null;
    const res = await this.web.search(query, { language, max: this.cfg.maxResults });
    if (!res || (res.results.length === 0 && !res.answer)) return null;
    const pages = this.scanner
      ? await this.scanner.scan(res.results.slice(0, 3).map((r) => r.url))
      : [];
    log.debug({ query, hits: res.results.length }, 'web grounding');
    return {
      kind: 'web',
      block: this.formatWeb(res, pages),
      query,
      sources: [...new Set([...res.results.map((r) => r.url), ...pages.map((p) => p.url)])],
    };
  }

  async findMediaUrl(query: string, language?: string): Promise<string | null> {
    if (!this.cfg.webEnabled || !this.web.enabled || !query.trim()) return null;
    const res = await this.web.search(query, {
      language,
      max: Math.max(5, this.cfg.maxResults),
      categories: 'videos',
    });
    return res?.results.find((r) => /^https?:\/\//i.test(r.url))?.url ?? null;
  }

  private formatWeb(res: WebSearchResponse, pages: PageSummary[] = []): string {
    const lines = [
      `WEB CONTEXT (fresh results from a web search for "${res.query}" - use these facts to be ` +
        'accurate; include direct links when the user asks for links, sources, prices, listings, ' +
        'availability, or "what you found"; never say you "searched the web"):',
    ];
    if (res.answer) lines.push(`answer: ${res.answer}`);
    for (const r of res.results) {
      lines.push(`- ${r.title}: ${r.content} [${domainOf(r.url)}] ${r.url}`);
    }
    if (pages.length) {
      lines.push('SCANNED PAGES (opened result pages; prefer these concrete details over snippets):');
      for (const p of pages) {
        const facts = p.facts.length ? ` facts=${p.facts.join(' | ')}` : '';
        lines.push(`- ${p.title || domainOf(p.url)} ${p.url}: ${p.text}${facts}`);
      }
    }
    return lines.join('\n');
  }

  private formatImage(label: string, res: WebSearchResponse | null): string {
    const lines = [
      'IMAGE LOOKUP (what the pictured subject most likely is + web results - use it to say ' +
        'who/what it is; give a product link only if they ask where to buy):',
      `best guess: ${label}`,
    ];
    if (res?.answer) lines.push(`answer: ${res.answer}`);
    for (const r of res?.results ?? []) {
      lines.push(`- ${r.title}: ${r.content} [${domainOf(r.url)}] ${r.url}`);
    }
    return lines.join('\n');
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
