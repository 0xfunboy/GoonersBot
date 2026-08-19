import type { AmbientFact } from '../ambient/types.js';

/**
 * How well a disputed claim is actually supported.
 *
 * The grade is the whole safety mechanism. "Champion the truth when it is incontrovertible" only
 * works if the bot can tell when it is not: a bot that plants a flag on things it cannot verify is
 * not principled, it is a confident liar. `settled` therefore means *a source is in hand right
 * now*, never *the model feels sure*.
 */
export type StanceTier = 'settled' | 'contested' | 'opinion' | 'unknown';

export interface StanceEvidence {
  claim: string;
  source: string;
  url?: string | undefined;
}

export interface Stance {
  tier: StanceTier;
  /** Evidence actually held, at most a few items. */
  evidence: StanceEvidence[];
  /** Compact directive for the prompt, or '' when there is nothing to say. */
  block: string;
}

/** Markers that a message is a value judgement rather than a factual claim. */
const OPINION_RE =
  /\b(secondo me|per me|penso che|credo che|preferisco|mi piace|non mi piace|meglio|peggio|piu bello|brutto|sopravvalutat|sottovalutat|imho|i think|in my opinion)\b/i;

/** Markers that two people are actually disagreeing, not merely talking. */
const DISPUTE_RE =
  /\b(no,? |non e vero|non e cosi|ti sbagli|sbagliato|falso|e il contrario|invece|non e affatto|ma va|assolutamente no|that'?s wrong|not true|actually)\b/i;

export interface StanceInput {
  /** The message that may contain a disputed claim. */
  message: string;
  /** Whatever ambient recall or grounding had in hand this turn. */
  facts: readonly AmbientFact[];
  /** Sources gathered by grounding, when any. */
  sources?: readonly string[];
}

/**
 * Decide what the bot is entitled to assert this turn.
 *
 * Nothing here consults a model: whether evidence exists is a fact about the process, and letting
 * an LLM judge its own certainty is exactly how a bot ends up confidently backing a friend.
 */
export function resolveStance(input: StanceInput): Stance {
  const message = input.message ?? '';
  const disputing = DISPUTE_RE.test(message);

  // A value judgement has no "wrong" to find, so no amount of evidence promotes it.
  if (OPINION_RE.test(message) && !disputing) {
    return { tier: 'opinion', evidence: [], block: renderOpinion() };
  }

  const evidence = [
    ...input.facts
      .filter((fact) => Boolean(fact.url))
      .map((fact) => ({ claim: fact.text, source: fact.subject, url: fact.url })),
    ...(input.sources ?? [])
      .filter((url) => /^https?:\/\//i.test(url))
      .map((url) => ({ claim: '', source: hostOf(url), url })),
  ].slice(0, 6);

  const tier = gradeEvidence(evidence);

  if (tier === 'unknown') {
    // No source in hand. If people are disagreeing, saying so is the honest contribution.
    return disputing
      ? { tier, evidence: [], block: renderUnknown() }
      : { tier, evidence: [], block: '' };
  }

  // Nobody is arguing: the facts speak for themselves and no flag needs planting.
  if (!disputing) return { tier, evidence, block: '' };

  return tier === 'settled'
    ? { tier, evidence, block: renderSettled(evidence) }
    : { tier, evidence, block: renderContested(evidence) };
}

/**
 * Grade the evidence by how many *independent* sources back it.
 *
 * Corroboration is the bar, because a single page is not "incontrovertible" no matter how
 * confident it sounds - and confidence is precisely what a language model cannot be trusted to
 * measure about itself. Independence is counted by host: three pages on one site are one site.
 *
 * Honest limitation: this measures corroboration, not agreement. Two independent sources that
 * genuinely contradict each other are indistinguishable here from two that concur, so `settled`
 * means "several sources speak to this", not "several sources were checked against each other".
 * Detecting semantic contradiction is not something deterministic code can do, and pretending
 * otherwise would put the over-confidence straight back in.
 */
export function gradeEvidence(evidence: readonly StanceEvidence[]): StanceTier {
  const hosts = new Set(
    evidence.map((item) => (item.url ? hostOf(item.url) : item.source.toLowerCase())),
  );
  if (hosts.size === 0) return 'unknown';
  // One source is thin: enough to bring to the table, never enough to tell someone they are wrong.
  return hosts.size >= 2 ? 'settled' : 'contested';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return url.toLowerCase();
  }
}

function renderSettled(evidence: readonly StanceEvidence[]): string {
  return [
    'STANCE: SETTLED — several independent sources speak to the point being disputed.',
    ...evidence.map(
      (item) => `  • ${item.source}: ${item.claim}${item.url ? ` (${item.url})` : ''}`,
    ),
    '  Back whoever holds this position and say why, citing the link.',
    '  Back it REGARDLESS of who you like: standing decides your tone, never your side.',
    '  Correct the other person on the fact only. Do not mock them for being wrong.',
  ].join('\n');
}

function renderContested(evidence: readonly StanceEvidence[]): string {
  return [
    'STANCE: CONTESTED — you hold ONE source on a disputed point. That is not enough to settle it.',
    ...evidence.map(
      (item) =>
        `  • ${item.source}${item.claim ? `: ${item.claim}` : ''}${item.url ? ` (${item.url})` : ''}`,
    ),
    '  Offer what you have and say where it comes from. Do NOT tell anyone they are wrong.',
    '  Naming what would actually settle it is a better contribution than picking a side.',
  ].join('\n');
}

function renderUnknown(): string {
  return [
    'STANCE: UNKNOWN — people are disagreeing and you hold no source.',
    '  Do not pick a side. Say plainly what you do not know, or what would settle it.',
  ].join('\n');
}

function renderOpinion(): string {
  return [
    'STANCE: OPINION — this is taste or values, not a factual claim.',
    '  You may hold and defend a view in character, but state it as a view, never as a fact.',
  ].join('\n');
}
