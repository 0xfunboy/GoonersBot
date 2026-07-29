/**
 * Non-negotiable media-generation boundary.
 *
 * Keep this detector outside persona/model prompts: every route (commands, agent DAG, prompt
 * fallbacks and providers) can apply the same deterministic rule before spending quota or calling
 * a generator. We intentionally reject age-ambiguous youth wording as well as explicit ages below
 * 18. Italian and English are first-class because they are the bot's main chat languages.
 */
const MINOR_TERM_RE =
  /(?:^|[^\p{L}\p{N}])(?:child(?:ren)?|kid(?:s)?|minor(?:s)?|under[\s-]?age(?:d)?|under\s+18|below\s+18|younger\s+than\s+18|loli(?:con)?|shota(?:con)?|toddler(?:s)?|infant(?:s)?|baby|babies|pre[\s-]?teen(?:s)?|teen(?:ager)?(?:s)?|school[\s-]?(?:girl|boy|student)|high[\s-]?school(?:er|[\s-]?student)?|bambin[oaie]|bimb[oaie]|minore(?:nni)?|minori|minorenne|minorenni|sotto\s+(?:i\s+)?18|meno\s+di\s+18|pi[uù]\s+giovane\s+di\s+18|neonat[oaie]|infant[ei]|preadolescent[ei]|ragazzin[oaie]|adolescent[ei]|liceal[ei]|student(?:e|essa|i|esse)\s+(?:delle|di\s+scuola)\s+superiori?)(?=$|[^\p{L}\p{N}])/iu;

const MINOR_AGE_RE =
  /(?:^|[^\p{L}\p{N}])(?:(?:[0-9]|1[0-7])\s*[\s-]?(?:years?[\s-]?old|y\/?o|yo|anni|enne)|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[\s-]+years?[\s-]+old|(?:zero|uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette)\s+anni|(?:un|du|tre|quattr|cinqu|sei|sett|ott|nov|diec|undic|dodic|tredic|quattordic|quindic|sedic|diciassett)enne)(?=$|[^\p{L}\p{N}])/iu;

const EXPLICIT_MEDIA_RE =
  /\b(?:nsfw|explicit|esplicit[oa]|sessualmente\s+esplicit[oa]|porn(?:o|ographic)?|pornograf\w*|hentai|nudes?|nudity|naked|nud[aoei]|topless|bottomless|senza\s+(?:vestiti|abiti|veli)|spogliat[oaie]|svestit[oaie]|sex|sexual|sesso|sessuale|intercourse|rapport[oi]\s+sessual[ei]|blowjob|handjob|oral\s+sex|fellatio|pompino|bocchino|bdsm|bondage|fetish|genitals?|genitali|vulva|nipples?|capezzoli|breasts?|boobs?|tits?|pussy|vagina|penis|cock|dick|cazzo|figa|fica|pene|sborra|sperma|cum|orgasm|orgasmo|masturb\w*|seghe?|scopare|scopata|incul\w*|penetrat\w*|penetrazion\w*|anal(?:e)?|orgia|orgy|erect\w*|erezion\w*|culo|tette|tettona)\b/i;

const SUGGESTIVE_MEDIA_RE =
  /\b(?:suggestive|sensual|sexy|lingerie|bikini|swimsuit|provocante|ammiccante|ecchi|lewd|erotic[oa]?)\b/i;

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

function normalizeSafetyText(text: string): string {
  // NFKC closes compatibility-spelling tricks; removing Unicode format controls also closes
  // zero-width joiner/non-joiner insertions such as "l\u200Boli" without changing visible text.
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '');
}

export function detectMinorMediaReference(text: string): MinorMediaReference | null {
  const normalized = normalizeSafetyText(text);
  const age = normalized.match(MINOR_AGE_RE)?.[0]?.trim();
  if (age) return { matched: age, kind: 'age' };
  const term = normalized.match(MINOR_TERM_RE)?.[0]?.trim();
  return term ? { matched: term, kind: 'term' } : null;
}

export function containsMinorMediaReference(text: string): boolean {
  return detectMinorMediaReference(text) !== null;
}

export function containsExplicitMediaReference(text: string): boolean {
  return EXPLICIT_MEDIA_RE.test(normalizeSafetyText(text));
}

export function containsSuggestiveMediaReference(text: string): boolean {
  return SUGGESTIVE_MEDIA_RE.test(normalizeSafetyText(text));
}

export function assertMediaGenerationSafe(text: string): void {
  const reference = detectMinorMediaReference(text);
  if (reference) throw new MediaSafetyError(reference);
}
