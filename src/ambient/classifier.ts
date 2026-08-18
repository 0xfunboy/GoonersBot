import {
  AMBIENT_DOMAINS,
  DOMAIN_LEXICON,
  DOMAIN_VOLATILITY,
  RECENCY_MARKERS,
  type AmbientDomain,
  type AmbientVolatility,
} from './domains.js';

/**
 * Fold text for word matching.
 *
 * Unlike title normalization, an apostrophe becomes a **separator** rather than vanishing: Italian
 * elides constantly ("l'ultimo", "un'altra", "dell'anime"), and collapsing those into "lultimo"
 * would hide the very words the lexicon is looking for.
 */
export function normalizeWords(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Deterministic topic disambiguation.
 *
 * No LLM call: deciding that "ansia da prestazione" is psychology and "patch note" is gaming is a
 * lexicon problem, and spending a model call on it on every single turn would make ambient recall
 * too expensive to run always - which is exactly what makes it ambient.
 *
 * The classifier is deliberately permissive about returning *nothing*: most group messages are
 * about no domain at all, and the correct output for those is an empty list, not a guess.
 */

/** A phrase scores higher than a bare word: "guerra fredda" is a stronger signal than "guerra". */
function phraseWeight(phrase: string): number {
  return phrase.includes(' ') ? 2.5 : 1;
}

/** Precomputed matchers, built once at module load rather than per message. */
const DOMAIN_MATCHERS: ReadonlyArray<{
  domain: AmbientDomain;
  entries: ReadonlyArray<{ needle: string; weight: number }>;
}> = AMBIENT_DOMAINS.map((domain) => ({
  domain,
  entries: DOMAIN_LEXICON[domain].map((phrase) => ({
    needle: ` ${normalizeWords(phrase)} `,
    weight: phraseWeight(phrase),
  })),
}));

const RECENCY_MATCHERS: readonly string[] = RECENCY_MARKERS.map(
  (marker) => ` ${normalizeWords(marker)} `,
);

export interface DomainSignal {
  domain: AmbientDomain;
  /** Unbounded evidence weight; only meaningful relative to the other domains in the same turn. */
  score: number;
  /** Base volatility, raised to `live` when the message explicitly asks for what is current. */
  volatility: AmbientVolatility;
  /** Lexicon entries that fired, for logging and for explaining a wrong classification. */
  matched: string[];
}

export interface AmbientClassification {
  /** Domains with real evidence, strongest first. Empty for ordinary chatter. */
  domains: DomainSignal[];
  /** True when the message asks for the current state of something, not for background. */
  wantsCurrent: boolean;
  /** Normalized message; reused downstream so nobody normalizes twice. */
  normalized: string;
}

export interface ClassifyOptions {
  /** Domains below this score are dropped. */
  minScore?: number;
  /** Maximum domains reported; ambient recall must not turn into a research report. */
  maxDomains?: number;
}

/**
 * Classify one message into zero or more domains.
 *
 * Multiple domains are allowed on purpose: "l'IA e cosciente?" is genuinely technology *and*
 * philosophy, and answering it well needs both.
 */
export function classifyMessage(
  message: string,
  opts: ClassifyOptions = {},
): AmbientClassification {
  const minScore = opts.minScore ?? 1;
  const maxDomains = opts.maxDomains ?? 2;
  const normalized = normalizeWords(message);
  const haystack = ` ${normalized} `;
  if (normalized.length < 3) return { domains: [], wantsCurrent: false, normalized };

  const wantsCurrent = RECENCY_MATCHERS.some((marker) => haystack.includes(marker));

  const signals: DomainSignal[] = [];
  for (const { domain, entries } of DOMAIN_MATCHERS) {
    let score = 0;
    const matched: string[] = [];
    for (const entry of entries) {
      if (!haystack.includes(entry.needle)) continue;
      score += entry.weight;
      matched.push(entry.needle.trim());
    }
    if (score < minScore) continue;
    const base = DOMAIN_VOLATILITY[domain];
    signals.push({
      domain,
      score,
      // A recency marker cannot make philosophy volatile, but it does turn a slow domain
      // ("che film mi consigli") into a live one ("che film esce ora").
      volatility: wantsCurrent && base === 'slow' ? 'live' : base,
      matched,
    });
  }

  signals.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
  return { domains: signals.slice(0, maxDomains), wantsCurrent, normalized };
}

/** The single best domain, or null when the message is ordinary chatter. */
export function primaryDomain(classification: AmbientClassification): AmbientDomain | null {
  return classification.domains[0]?.domain ?? null;
}

/**
 * True when one domain clearly dominates.
 *
 * Callers that must pick exactly one provider use this instead of blindly taking the top signal,
 * so a genuinely cross-domain message is handled as cross-domain.
 */
export function isDominant(classification: AmbientClassification): boolean {
  const [top, second] = classification.domains;
  if (!top) return false;
  if (!second) return true;
  return top.score >= second.score * 1.5;
}
