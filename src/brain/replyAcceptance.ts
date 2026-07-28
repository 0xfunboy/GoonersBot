import type { RankedReply, RepetitionCheck } from './types.js';

/**
 * Phrases that do not answer the turn and merely expose an internal generation/ranking failure.
 * These must never beat an actual answer during last-resort recovery.
 */
const INTERNAL_DEFLECTION_RE =
  /\b(stava (?:riciclando|uscendo)|risposta generata|non te la rifilo|riformul(?:a|ami|amelo|amene)|stavolta passo|mi tengo la dignit[aà]|dignit[aà] residua|battuta (?:gi[aà] )?morta)\b/i;

export interface AssessedReplyCandidate {
  text: string;
  rank: RankedReply;
  repetition: RepetitionCheck;
  violatesSocialFloor: boolean;
}

export interface ReplyAcceptanceDecision {
  /** Normal outcome: the best ranked candidate that passed every hard floor. */
  accepted: AssessedReplyCandidate | null;
  /**
   * A socially safe, substantive candidate retained across retries. It may be repetitive, but is
   * still preferable to exposing an internal failure or returning no answer.
   */
  recovery: AssessedReplyCandidate | null;
  /** A retry is useful only when candidates existed but every one hit a hard floor. */
  shouldRegenerate: boolean;
}

export function isInternalDeflection(text: string): boolean {
  return INTERNAL_DEFLECTION_RE.test(text);
}

/**
 * Decide without another LLM call. Advisory novelty findings are already reflected in ranking and
 * must not veto a useful candidate.
 */
export function decideReplyAcceptance(
  candidates: AssessedReplyCandidate[],
): ReplyAcceptanceDecision {
  const accepted =
    candidates.find(
      (candidate) => candidate.repetition.allowed && !candidate.violatesSocialFloor,
    ) ?? null;
  const recovery =
    candidates.find(
      (candidate) =>
        !candidate.violatesSocialFloor &&
        candidate.repetition.overusedMemoryIds.length === 0 &&
        candidate.text.trim().length > 0 &&
        !isInternalDeflection(candidate.text),
    ) ?? null;

  return {
    accepted,
    recovery,
    shouldRegenerate: accepted === null && candidates.length > 0,
  };
}
