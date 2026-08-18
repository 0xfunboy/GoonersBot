/**
 * Deterministic extraction of the *subjects* a message is talking about.
 *
 * Ambient providers need something to look up, and the whole message is a poor query: "ieri sera
 * ho visto Frieren e mi sono addormentato" should look up `Frieren`, not the sentence. This does
 * that with three orthogonal signals - quotation, capitalisation and prepositional attachment -
 * because each one catches cases the others miss, and none of them needs a model call.
 */

/** Words that never start a real subject even when capitalised at the beginning of a sentence. */
const STOPWORDS = new Set([
  // Italian
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'un',
  'uno',
  'una',
  'del',
  'dello',
  'della',
  'dei',
  'degli',
  'delle',
  'e',
  'ed',
  'o',
  'ma',
  'se',
  'che',
  'chi',
  'cosa',
  'come',
  'quando',
  'dove',
  'perche',
  'quale',
  'quali',
  'ho',
  'hai',
  'ha',
  'abbiamo',
  'avete',
  'hanno',
  'sono',
  'sei',
  'siamo',
  'siete',
  'era',
  'erano',
  'essere',
  'visto',
  'vista',
  'guardato',
  'letto',
  'sentito',
  'detto',
  'fatto',
  'uscito',
  'uscita',
  'esce',
  'escono',
  'ieri',
  'oggi',
  'domani',
  'stasera',
  'stamattina',
  'ancora',
  'anche',
  'solo',
  'molto',
  'poco',
  'tutto',
  'questo',
  'questa',
  'questi',
  'queste',
  'quello',
  'quella',
  'quelli',
  'quelle',
  'mi',
  'ti',
  'ci',
  'vi',
  'si',
  'ne',
  'non',
  'piu',
  'meno',
  'gia',
  'forse',
  'magari',
  'pero',
  'quindi',
  'allora',
  'beh',
  'vabbe',
  'raga',
  'ragazzi',
  'bro',
  'oh',
  'ah',
  'eh',
  'boh',
  'mah',
  'cazzo',
  'merda',
  // English
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'but',
  'if',
  'that',
  'who',
  'what',
  'how',
  'when',
  'where',
  'why',
  'which',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'have',
  'has',
  'had',
  'is',
  'are',
  'was',
  'were',
  'be',
  'seen',
  'watched',
  'read',
  'heard',
  'said',
  'done',
  'out',
  'yesterday',
  'today',
  'tomorrow',
  'tonight',
  'just',
  'also',
  'only',
  'very',
  'this',
  'these',
  'those',
  'not',
  'more',
  'less',
  'already',
  'maybe',
  'so',
]);

/** Prepositions after which a subject commonly follows: "episodio **di** X", "parlami **di** Y". */
const SUBJECT_PREPOSITIONS = [
  'di',
  'su',
  'riguardo a',
  'riguardo',
  'a proposito di',
  'about',
  'of',
  'on',
];

export interface ExtractSubjectsOptions {
  /** Maximum subjects returned, best first. */
  limit?: number;
  /** Minimum characters for a subject to be worth looking up. */
  minLength?: number;
}

/**
 * Candidate subjects, most specific first.
 *
 * Order matters: a quoted string is an explicit act of naming, a capitalised run is a strong
 * implicit one, and a prepositional phrase is the weakest, so providers that stop at the first
 * hit stop at the best one.
 */
export function extractSubjects(message: string, opts: ExtractSubjectsOptions = {}): string[] {
  const limit = opts.limit ?? 3;
  const minLength = opts.minLength ?? 3;
  const text = message.replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const out: string[] = [];
  const push = (candidate: string): void => {
    const cleaned = candidate
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/[^\p{L}\p{N}!?]+$/u, '')
      .trim();
    if (cleaned.length < minLength) return;
    if (STOPWORDS.has(cleaned.toLowerCase())) return;
    if (out.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) return;
    out.push(cleaned);
  };

  for (const match of text.matchAll(/["“”'«»]([^"“”'«»]{3,80})["“”'«»]/gu)) {
    const value = match[1];
    if (value) push(value);
  }

  // Runs of capitalised words, ignoring a capital that is merely the start of the sentence.
  // Each repetition consumes its own leading whitespace, so a lowercase connector inside a title
  // ("Tanya **the** Evil") extends the run instead of terminating it one word early.
  for (const match of text.matchAll(
    /(?<![.!?]\s|^)\b(\p{Lu}[\p{L}\p{N}'’-]*(?:\s+(?:\p{Lu}[\p{L}\p{N}'’-]*|the|of|no|ni|de|della|dei|del))*)/gu,
  )) {
    const value = match[1]?.trim();
    if (value && !STOPWORDS.has(value.toLowerCase())) push(trimTrailingStopwords(value));
  }

  for (const preposition of SUBJECT_PREPOSITIONS) {
    const pattern = new RegExp(
      `\\b${preposition.replace(/ /g, '\\s+')}\\s+((?:[\\p{L}\\p{N}'’-]+(?:\\s+|$)){1,5})`,
      'giu',
    );
    for (const match of text.matchAll(pattern)) {
      const phrase = match[1]?.trim();
      if (!phrase) continue;
      push(trimTrailingStopwords(phrase));
    }
  }

  // A short message with no internal structure is itself the subject ("dissonanza cognitiva?").
  // Word count, not character count, is the right guard: a six-word sentence is a sentence, and
  // looking it up as if it were a title only produces misses.
  const words = text.split(' ').filter(Boolean);
  if (out.length === 0 && words.length <= 4 && text.length <= 60) push(text);

  return out.slice(0, limit);
}

/** Drop trailing filler so "di Tanya the Evil che è" becomes "Tanya the Evil". */
function trimTrailingStopwords(phrase: string): string {
  const words = phrase.split(' ').filter(Boolean);
  while (words.length > 0) {
    const last = words[words.length - 1]?.toLowerCase() ?? '';
    if (!STOPWORDS.has(last)) break;
    words.pop();
  }
  return words.join(' ');
}
