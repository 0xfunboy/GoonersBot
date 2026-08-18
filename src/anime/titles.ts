/**
 * Deterministic title normalization and ranking for the anime catalog.
 *
 * Everything here is pure and synchronous on purpose: resolving "tanya the evil" to
 * "Youjo Senki" is a string problem, not a reasoning problem, so it never costs an LLM call and
 * always produces the same answer for the same input. The agent layer only decides how to phrase
 * the result.
 */

/** Season/format noise that source catalogs append to otherwise identical titles. */
const NOISE_TOKENS = new Set([
  'ita',
  'sub',
  'subita',
  'dub',
  'dubbed',
  'subbed',
  'vostfr',
  'raw',
  'bd',
  'bluray',
  'uncensored',
  'censored',
  'tv',
  'ova',
  'ona',
  'special',
  'specials',
  'movie',
  'film',
]);

/** Roman numerals up to 12 cover effectively every sequel numbering in practice. */
const ROMAN_NUMERALS: ReadonlyMap<string, string> = new Map([
  ['i', '1'],
  ['ii', '2'],
  ['iii', '3'],
  ['iv', '4'],
  ['v', '5'],
  ['vi', '6'],
  ['vii', '7'],
  ['viii', '8'],
  ['ix', '9'],
  ['x', '10'],
  ['xi', '11'],
  ['xii', '12'],
]);

/**
 * Fold a raw title into a comparable key: lowercase, Unicode NFKD, accents stripped, punctuation
 * and apostrophes collapsed to spaces, whitespace squeezed.
 *
 * Punctuation becomes a separator rather than disappearing, so "re:zero" and "re zero" converge
 * while "sword art" never silently fuses into "swordart".
 */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[‘’ʼ`']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Normalized form with source noise removed and sequel numbering unified.
 *
 * Noise stripping is deliberately conservative: a token is only dropped when at least one
 * meaningful token survives, so legitimate titles such as "Ova" or "Monster" are never erased
 * into an empty key.
 */
export function canonicalTitleKey(raw: string): string {
  const tokens = normalizeTitle(raw).split(' ').filter(Boolean);
  const mapped = tokens.map((token) => ROMAN_NUMERALS.get(token) ?? token);
  const meaningful = mapped.filter((token) => !NOISE_TOKENS.has(token));
  const kept = meaningful.length > 0 ? meaningful : mapped;
  return kept.join(' ');
}

/** Every distinct comparable key for a series, in a stable order (canonical form first). */
export function titleKeys(titles: readonly (string | null | undefined)[]): string[] {
  const keys: string[] = [];
  for (const title of titles) {
    if (!title || !title.trim()) continue;
    for (const key of [canonicalTitleKey(title), normalizeTitle(title)]) {
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * Bigram Dice coefficient in [0,1].
 *
 * Dice is used rather than edit distance because catalog titles differ by whole inserted or
 * reordered words far more often than by typos, and it is O(n) without an allocation per cell.
 */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

/**
 * Similarity between a user query and one candidate title key.
 *
 * A full containment bonus keeps short colloquial queries ("tanya the evil") ranked above longer
 * titles that merely share character bigrams, which raw Dice alone gets wrong.
 */
export function titleSimilarity(queryKey: string, candidateKey: string): number {
  if (!queryKey || !candidateKey) return 0;
  if (queryKey === candidateKey) return 1;
  const dice = diceSimilarity(queryKey, candidateKey);
  const queryTokens = queryKey.split(' ').filter(Boolean);
  const candidateTokens = new Set(candidateKey.split(' ').filter(Boolean));
  if (queryTokens.length === 0) return dice;
  const covered = queryTokens.filter((token) => candidateTokens.has(token)).length;
  const coverage = covered / queryTokens.length;
  // Weighted so exact token coverage dominates, but never reaches the 1.0 reserved for an
  // exact key match.
  return Math.min(0.99, Math.max(dice, coverage * 0.75 + dice * 0.25));
}

export interface TitleCandidate {
  /** Every known title/alias for this candidate. */
  titles: readonly (string | null | undefined)[];
}

export interface RankedTitle<T> {
  item: T;
  score: number;
  /** The candidate key that produced the score; useful for logging why a match won. */
  matchedKey: string;
}

/**
 * Rank candidates against a free-text query, best first.
 *
 * Ties are broken by the candidate's own order, so a caller that pre-sorts by popularity keeps
 * that intent instead of getting an arbitrary Array.sort permutation.
 */
export function rankByTitle<T extends TitleCandidate>(
  query: string,
  candidates: readonly T[],
  opts: { minScore?: number; limit?: number } = {},
): RankedTitle<T>[] {
  const minScore = opts.minScore ?? 0.45;
  const queryKey = canonicalTitleKey(query);
  if (!queryKey) return [];
  const ranked: Array<RankedTitle<T> & { index: number }> = [];
  for (const [index, item] of candidates.entries()) {
    let best = 0;
    let bestKey = '';
    for (const key of titleKeys(item.titles)) {
      const score = titleSimilarity(queryKey, key);
      if (score > best) {
        best = score;
        bestKey = key;
      }
    }
    if (best >= minScore) ranked.push({ item, score: best, matchedKey: bestKey, index });
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  const limited = opts.limit === undefined ? ranked : ranked.slice(0, Math.max(0, opts.limit));
  return limited.map(({ item, score, matchedKey }) => ({ item, score, matchedKey }));
}

/**
 * True when the top match is clearly ahead of the runner-up.
 *
 * Callers use this to decide between answering with certainty and showing a short ranked list,
 * which is the difference between a correct answer and a confident wrong one.
 */
export function isDecisiveMatch(ranked: readonly RankedTitle<unknown>[]): boolean {
  const top = ranked[0];
  if (!top) return false;
  const runnerUp = ranked[1];
  if (!runnerUp) return top.score >= 0.6;
  // A tie at the top - two catalog entries sharing a title - is the ambiguous case, not a
  // certainty, so the score gap is checked even when the leader matched exactly.
  return top.score >= 0.6 && top.score - runnerUp.score >= 0.12;
}
