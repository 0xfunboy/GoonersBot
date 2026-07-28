/**
 * Non-negotiable media-generation boundary.
 *
 * Keep this detector outside persona/model prompts: every route (commands, agent DAG, prompt
 * fallbacks and providers) can apply the same deterministic rule before spending quota or calling
 * a generator. We intentionally reject age-ambiguous youth wording as well as explicit ages below
 * 18. Italian and English are first-class because they are the bot's main chat languages.
 */
const MINOR_TERM_RE =
  /(?:^|[^\p{L}\p{N}])(?:child(?:ren)?|kid(?:s)?|minor(?:s)?|under[\s-]?age(?:d)?|under\s+18|below\s+18|younger\s+than\s+18|loli(?:con)?|shota(?:con)?|toddler(?:s)?|infant(?:s)?|baby|babies|pre[\s-]?teen(?:s)?|teen(?:ager)?(?:s)?|school[\s-]?(?:girl|boy)|bambin[oaie]|bimb[oaie]|minore(?:nni)?|minori|minorenne|minorenni|sotto\s+(?:i\s+)?18|meno\s+di\s+18|pi[uù]\s+giovane\s+di\s+18|neonat[oaie]|infant[ei]|preadolescent[ei]|ragazzin[oaie]|adolescent[ei])(?=$|[^\p{L}\p{N}])/iu;

const MINOR_AGE_RE =
  /(?:^|[^\p{L}\p{N}])(?:[0-9]|1[0-7])\s*[\s-]?(?:years?[\s-]?old|y\/?o|yo|anni|enne)(?=$|[^\p{L}\p{N}])/iu;

export interface MinorMediaReference {
  matched: string;
  kind: 'term' | 'age';
}

export class MediaSafetyError extends Error {
  readonly code = 'MEDIA_MINOR_BLOCKED';

  constructor(readonly reference?: MinorMediaReference) {
    super('media generation involving or implying a minor is not allowed');
    this.name = 'MediaSafetyError';
  }
}

export function detectMinorMediaReference(text: string): MinorMediaReference | null {
  const normalized = text.normalize('NFKC');
  const age = normalized.match(MINOR_AGE_RE)?.[0]?.trim();
  if (age) return { matched: age, kind: 'age' };
  const term = normalized.match(MINOR_TERM_RE)?.[0]?.trim();
  return term ? { matched: term, kind: 'term' } : null;
}

export function containsMinorMediaReference(text: string): boolean {
  return detectMinorMediaReference(text) !== null;
}

export function assertMediaGenerationSafe(text: string): void {
  const reference = detectMinorMediaReference(text);
  if (reference) throw new MediaSafetyError(reference);
}
