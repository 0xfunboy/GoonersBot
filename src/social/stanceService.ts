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

  const evidence = input.facts
    .filter((fact) => Boolean(fact.url))
    .slice(0, 3)
    .map((fact) => ({ claim: fact.text, source: fact.subject, url: fact.url }));

  if (evidence.length === 0) {
    // No source in hand. If people are disagreeing, saying so is the honest contribution.
    return disputing
      ? { tier: 'unknown', evidence: [], block: renderUnknown() }
      : { tier: 'unknown', evidence: [], block: '' };
  }

  // A single corroborating source on a disputed point is what "settled" means here.
  if (disputing) return { tier: 'settled', evidence, block: renderSettled(evidence) };

  // Evidence exists but nobody is arguing: no stance needed, the facts speak on their own.
  return { tier: 'settled', evidence, block: '' };
}

function renderSettled(evidence: readonly StanceEvidence[]): string {
  return [
    'STANCE: SETTLED — you hold a source on the point being disputed.',
    ...evidence.map(
      (item) => `  • ${item.source}: ${item.claim}${item.url ? ` (${item.url})` : ''}`,
    ),
    '  Back whoever holds this position and say why, citing the link.',
    '  Back it REGARDLESS of who you like: standing decides your tone, never your side.',
    '  Correct the other person on the fact only. Do not mock them for being wrong.',
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
