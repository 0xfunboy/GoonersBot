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

export const ITALIAN_ORDINALS_MAP: ReadonlyMap<string, string> = new Map([
  ['primo', '1'],
  ['prima', '1'],
  ['primi', '1'],
  ['prime', '1'],
  ['1°', '1'],
  ['1a', '1'],
  ['uno', '1'],
  ['secondo', '2'],
  ['seconda', '2'],
  ['secondi', '2'],
  ['seconde', '2'],
  ['2°', '2'],
  ['2a', '2'],
  ['due', '2'],
  ['terzo', '3'],
  ['terza', '3'],
  ['terzi', '3'],
  ['terze', '3'],
  ['3°', '3'],
  ['3a', '3'],
  ['tre', '3'],
  ['quarto', '4'],
  ['quarta', '4'],
  ['quarti', '4'],
  ['quarte', '4'],
  ['4°', '4'],
  ['4a', '4'],
  ['quattro', '4'],
  ['quinto', '5'],
  ['quinta', '5'],
  ['quinti', '5'],
  ['quinte', '5'],
  ['5°', '5'],
  ['5a', '5'],
  ['cinque', '5'],
  ['sesto', '6'],
  ['sesta', '6'],
  ['6°', '6'],
  ['6a', '6'],
  ['sei', '6'],
  ['settimo', '7'],
  ['settima', '7'],
  ['7°', '7'],
  ['7a', '7'],
  ['sette', '7'],
  ['ottavo', '8'],
  ['ottava', '8'],
  ['8°', '8'],
  ['8a', '8'],
  ['otto', '8'],
  ['nono', '9'],
  ['nona', '9'],
  ['9°', '9'],
  ['9a', '9'],
  ['nove', '9'],
  ['decimo', '10'],
  ['decima', '10'],
  ['10°', '10'],
  ['10a', '10'],
  ['dieci', '10'],
  ['undicesimo', '11'],
  ['undicesima', '11'],
  ['undici', '11'],
  ['dodicesimo', '12'],
  ['dodicesima', '12'],
  ['dodici', '12'],
  ['tredicesimo', '13'],
  ['tredici', '13'],
  ['quattordicesimo', '14'],
  ['quattordici', '14'],
  ['quindicesimo', '15'],
  ['quindici', '15'],
  ['sedicesimo', '16'],
  ['sedici', '16'],
  ['diciassettesimo', '17'],
  ['diciassette', '17'],
  ['diciottesimo', '18'],
  ['diciotto', '18'],
  ['diciannovesimo', '19'],
  ['diciannove', '19'],
  ['ventesimo', '20'],
  ['ventesima', '20'],
  ['venti', '20'],
  ['ventunesimo', '21'],
  ['ventunesima', '21'],
  ['ventuno', '21'],
  ['ventiduesimo', '22'],
  ['ventiduesima', '22'],
  ['ventidue', '22'],
  ['ventitreesimo', '23'],
  ['ventitreesima', '23'],
  ['ventitre', '23'],
  ['ventitré', '23'],
  ['ventiquattresimo', '24'],
  ['ventiquattresima', '24'],
  ['ventiquattro', '24'],
  ['venticinquesimo', '25'],
  ['venticinquesima', '25'],
  ['venticinque', '25'],
  ['ventiseiesimo', '26'],
  ['ventiseiesima', '26'],
  ['ventisei', '26'],
  ['ventisettesimo', '27'],
  ['ventisettesima', '27'],
  ['ventisette', '27'],
  ['ventottesimo', '28'],
  ['ventottesima', '28'],
  ['ventotto', '28'],
  ['ventinovesimo', '29'],
  ['ventinovesima', '29'],
  ['ventinove', '29'],
  ['trentesimo', '30'],
  ['trentesima', '30'],
  ['trenta', '30'],
  ['trentunesimo', '31'],
  ['trentunesima', '31'],
  ['trentuno', '31'],
  ['trentaduesimo', '32'],
  ['trentaduesima', '32'],
  ['trentadue', '32'],
  ['trentatreesimo', '33'],
  ['trentatreesima', '33'],
  ['trentatre', '33'],
  ['trentatré', '33'],
  ['trentaquattresimo', '34'],
  ['trentaquattresima', '34'],
  ['trentaquattro', '34'],
  ['trentacinquesimo', '35'],
  ['trentacinquesima', '35'],
  ['trentacinque', '35'],
  ['trentaseiesimo', '36'],
  ['trentaseiesima', '36'],
  ['trentasei', '36'],
  ['trentasettesimo', '37'],
  ['trentasettesima', '37'],
  ['trentasette', '37'],
  ['trentottesimo', '38'],
  ['trentottesima', '38'],
  ['trentotto', '38'],
  ['trentanovesimo', '39'],
  ['trentanovesima', '39'],
  ['trentanove', '39'],
  ['quarantesimo', '40'],
  ['quarantesima', '40'],
  ['quaranta', '40'],
  ['quarantunesimo', '41'],
  ['quarantunesima', '41'],
  ['quarantuno', '41'],
  ['quarantaduesimo', '42'],
  ['quarantaduesima', '42'],
  ['quarantadue', '42'],
  ['quarantatreesimo', '43'],
  ['quarantatreesima', '43'],
  ['quarantatre', '43'],
  ['quarantatré', '43'],
  ['quarantaquattresimo', '44'],
  ['quarantaquattresima', '44'],
  ['quarantaquattro', '44'],
  ['quarantacinquesimo', '45'],
  ['quarantacinquesima', '45'],
  ['quarantacinque', '45'],
  ['quarantaseiesimo', '46'],
  ['quarantaseiesima', '46'],
  ['quarantasei', '46'],
  ['quarantasettesimo', '47'],
  ['quarantasettesima', '47'],
  ['quarantasette', '47'],
  ['quarantottesimo', '48'],
  ['quarantottesima', '48'],
  ['quarantotto', '48'],
  ['quarantanovesimo', '49'],
  ['quarantanovesima', '49'],
  ['quarantanove', '49'],
  ['cinquantesimo', '50'],
  ['cinquantesima', '50'],
  ['cinquanta', '50'],
]);

/** Precompiled regular expressions for high-throughput natural language anime matching */
const SXX_EXX_RE = /\b[sS](\d{1,2})\s*(?:[eE]|ep|\s*ep(?:isodio)?\.?\s*)\s*(\d{1,3})\b/iu;

const NUM_WORDS_PATTERN =
  'primo|prima|secondo|seconda|terzo|terza|quarto|quarta|quinto|quinta|sesto|sesta|settimo|settima|ottavo|ottava|nono|nona|decimo|decima|undicesimo|undicesima|dodicesimo|dodicesima|tredicesimo|quattordicesimo|quindicesimo|sedicesimo|diciassettesimo|diciottesimo|diciannovesimo|ventesimo|ventunesimo|ventiduesimo|ventitreesimo|ventiquattresimo|venticinquesimo|ventiseiesimo|ventisettesimo|ventottesimo|ventinovesimo|trentesimo|quarantesimo|cinquantesimo|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti|ventuno|ventidue|ventitre|ventitré|ventiquattro|venticinque|ventisei|ventisette|ventotto|ventinove|trenta|quaranta|cinquanta|\\d+';

const EPISODE_REQUEST_RE = new RegExp(
  `\\b(?:il|l|la|lo|l['’])?\\s*(?:(${NUM_WORDS_PATTERN})(?:[°a]|esimo|esima)?\\s*(?:episodio|puntata|ep\\b)|(?:episodio|puntata|ep\\b)\\s*(?:numero\\s*)?(${NUM_WORDS_PATTERN}))`,
  'iu',
);

const SEASON_REQUEST_RE = new RegExp(
  `\\b(?:della|del|di|il|l|la|lo|l['’])?\\s*(?:(${NUM_WORDS_PATTERN})(?:[°a]|esimo|esima)?\\s*(?:serie|stagione|season)|(?:serie|stagione|season)\\s*(?:numero\\s*)?(${NUM_WORDS_PATTERN}))`,
  'iu',
);

const CONVERSATIONAL_STRIP_RE =
  /\b(?:hey|ciao|scaricami|scarica|scaricare|rehostami|rehosta|passami|mandami|cercami|cerca|trova|trovami|guarda|per favore|please)\b/giu;

const PREPOSITIONS_STRIP_RE = /\b(?:di|del|della|dei|degli)\b/giu;

/**
 * Fold a raw title into a comparable key: lowercase, Unicode NFKD, accents stripped, punctuation
 * and apostrophes collapsed to spaces, whitespace squeezed.
 *
 * Punctuation becomes a separator rather than disappearing, so "re:zero" and "re zero" converge
 * while "sword art" never silently fuses into "swordart".
 */
export function normalizeTitle(raw: string): string {
  let text = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[‘’ʼ`']/g, '');

  // Normalize phrases like "seconda serie", "stagione 2", "seconda stagione", "2a serie"
  text = text.replace(
    /\b(?:seconda|2a?|due)\s+(?:serie|stagione|season)\b|\b(?:serie|stagione|season)\s+(?:seconda|2a?|due)\b/gu,
    ' 2 ',
  );
  text = text.replace(
    /\b(?:terza|3a?|tre)\s+(?:serie|stagione|season)\b|\b(?:serie|stagione|season)\s+(?:terza|3a?|tre)\b/gu,
    ' 3 ',
  );
  text = text.replace(
    /\b(?:quarta|4a?|quattro)\s+(?:serie|stagione|season)\b|\b(?:serie|stagione|season)\s+(?:quarta|4a?|quattro)\b/gu,
    ' 4 ',
  );
  text = text.replace(
    /\b(?:quinta|5a?|cinque)\s+(?:serie|stagione|season)\b|\b(?:serie|stagione|season)\s+(?:quinta|5a?|cinque)\b/gu,
    ' 5 ',
  );
  text = text.replace(
    /\b(?:prima|1a?|una?)\s+(?:serie|stagione|season)\b|\b(?:serie|stagione|season)\s+(?:prima|1a?|una?)\b/gu,
    ' 1 ',
  );
  text = text.replace(/\b(?:season|stagione|serie)\s*([0-9]{1,2})\b/gu, ' $1 ');

  return text
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
  const mapped = tokens.map((token) => ROMAN_NUMERALS.get(token) ?? ITALIAN_ORDINALS_MAP.get(token) ?? token);
  const meaningful = mapped.filter((token) => !NOISE_TOKENS.has(token));
  const kept = meaningful.length > 0 ? meaningful : mapped;
  return kept.join(' ');
}

/**
 * Semantically extract an episode number from free-form user input or model arguments.
 * Handles digits, Italian words ("terzo", "primo"), and typos like "terzo episo dio".
 */
export function parseSemanticEpisodeNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;

  const raw = value.trim().toLowerCase();
  if (raw === 'latest' || raw === 'ultimo' || raw === 'ultima') return null;

  // Direct SXXEXX check (e.g. s02e03 -> episode 3)
  const sxxMatch = raw.match(SXX_EXX_RE);
  if (sxxMatch?.[2]) {
    const num = Number(sxxMatch[2]);
    if (Number.isFinite(num) && num >= 0) return num;
  }

  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bepiso\s+dio\b/giu, 'episodio')
    .replace(/\b(?:episodio|puntata|ep(?:isodio)?\.?|parte|p\.|cap(?:itolo)?\.?|e(?=\d)|ep(?=\d))\s*/giu, ' ')
    .trim();

  const directMatch = normalized.match(/^(\d+(?:[.,]\d+)?)(?:[°a]|esimo|esima|mo|ma)?$/iu);
  if (directMatch?.[1]) {
    const num = Number(directMatch[1].replace(',', '.'));
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  const embeddedDigit = normalized.match(/\b(\d+(?:[.,]\d+)?)(?:[°a]|esimo|esima|mo|ma)?\b/iu);
  if (embeddedDigit?.[1]) {
    const num = Number(embeddedDigit[1].replace(',', '.'));
    if (Number.isFinite(num) && num >= 0) return num;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const cleanToken = token.replace(/[^a-z0-9°]/gu, '');
    const mapped = ITALIAN_ORDINALS_MAP.get(cleanToken);
    if (mapped) {
      const num = Number(mapped);
      if (Number.isFinite(num) && num >= 0) return num;
    }
  }

  return null;
}

export interface ParsedNaturalAnimeRequest {
  cleanQuery: string;
  season?: number;
  episode?: number;
  seasonTitle?: string;
}

/**
 * Semantically parse free-form Italian requests like:
 * "hey scaricami il terzo episo dio della seconda serie di mushoku tensei"
 * or "scaricami jujutsu kaisen s02e03"
 */
export function parseNaturalAnimeRequest(raw: string): ParsedNaturalAnimeRequest {
  let text = raw.trim();
  let episode: number | undefined;
  let season: number | undefined;

  text = text.replace(/\bepiso\s+dio\b/giu, 'episodio');

  // Fast path for standard release notation (e.g. S02E03, s1 ep 4)
  const sxxMatch = text.match(SXX_EXX_RE);
  if (sxxMatch?.[1] && sxxMatch?.[2]) {
    season = Number(sxxMatch[1]);
    episode = Number(sxxMatch[2]);
    text = text.replace(sxxMatch[0], ' ');
  }

  if (episode === undefined) {
    const epMatch = text.match(EPISODE_REQUEST_RE);
    if (epMatch) {
      const matchedVal = epMatch[1] || epMatch[2];
      const parsed = parseSemanticEpisodeNumber(matchedVal);
      if (parsed !== null) {
        episode = parsed;
        text = text.replace(epMatch[0], ' ');
      }
    }
  }

  if (season === undefined) {
    const seasonMatch = text.match(SEASON_REQUEST_RE);
    if (seasonMatch) {
      const matchedSeason = seasonMatch[1] || seasonMatch[2];
      const parsed = parseSemanticEpisodeNumber(matchedSeason);
      if (parsed !== null) {
        season = parsed;
        text = text.replace(seasonMatch[0], ' ');
      }
    }
  }

  const cleanTitle = text
    .replace(CONVERSATIONAL_STRIP_RE, ' ')
    .replace(PREPOSITIONS_STRIP_RE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  const seasonTitle = cleanTitle && season ? `${cleanTitle} ${season}` : cleanTitle;

  return {
    cleanQuery: cleanTitle,
    ...(season !== undefined ? { season } : {}),
    ...(episode !== undefined ? { episode } : {}),
    ...(seasonTitle ? { seasonTitle } : {}),
  };
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

/** Score returned only when a query key equals a candidate key outright. */
export const EXACT_MATCH_SCORE = 0.999;

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

  // An exact key match is title equality, not similarity, so it outranks anything merely close -
  // otherwise a *different* series carrying a near-identical alias ("Chainsmoker Cat Minis"
  // against "Chainsmoker Cat") drags a perfect hit below the ambiguity threshold. Two exact hits
  // stay ambiguous: that is genuinely two entries sharing one title.
  const exact = ranked.filter((entry) => entry.score >= EXACT_MATCH_SCORE);
  if (exact.length === 1) return true;
  if (exact.length > 1) return false;

  const runnerUp = ranked[1];
  if (!runnerUp) return top.score >= 0.6;
  // A tie at the top is the ambiguous case, not a certainty.
  return top.score >= 0.6 && top.score - runnerUp.score >= 0.12;
}
