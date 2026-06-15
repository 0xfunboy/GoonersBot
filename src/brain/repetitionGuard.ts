import { jaccard } from '../memory/memoryDeduper.js';
import type { RetrievedMemory } from '../memory/types.js';
import type { BotReplyRecord, ReplyPlan, RepetitionCheck } from './types.js';

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
function opening(s: string, n = 3): string {
  return normalize(s).split(' ').slice(0, n).join(' ');
}

/**
 * RepetitionGuard: blocks replies that repeat recent bot behaviour — high text similarity, reused
 * opening, banned phrases, or verbatim memory that wasn't cleared for an explicit callback.
 */
export class RepetitionGuard {
  constructor(private readonly similarityThreshold: number) {}

  check(
    candidate: string,
    recent: BotReplyRecord[],
    plan: ReplyPlan,
    memories: RetrievedMemory[],
  ): RepetitionCheck {
    const norm = normalize(candidate);
    let maxSim = 0;
    for (const r of recent.slice(0, 8)) {
      maxSim = Math.max(maxSim, jaccard(norm, r.normalizedText || normalize(r.text)));
    }
    const cOpening = opening(candidate);
    const sameOpening = recent
      .slice(0, 5)
      .some((r) => opening(r.text) === cOpening && cOpening.length > 0);

    const repeatedPhrases = plan.bannedPhrases.filter((p) => norm.includes(normalize(p)));

    const overusedMemoryIds: string[] = [];
    for (const m of memories) {
      if (m.allowedToUseExplicitly) continue;
      if (norm.includes(normalize(m.item.text)) && m.item._id) overusedMemoryIds.push(m.item._id);
    }

    const allowed =
      maxSim <= this.similarityThreshold &&
      !sameOpening &&
      repeatedPhrases.length === 0 &&
      overusedMemoryIds.length === 0;

    const reasons: string[] = [];
    if (maxSim > this.similarityThreshold) reasons.push(`similar(${maxSim.toFixed(2)})`);
    if (sameOpening) reasons.push('same opening');
    if (repeatedPhrases.length) reasons.push('banned phrase');
    if (overusedMemoryIds.length) reasons.push('verbatim memory');

    const result: RepetitionCheck = {
      allowed,
      similarityToRecentReplies: maxSim,
      repeatedPhrases,
      overusedMemoryIds,
      sameOpening,
    };
    if (reasons.length) result.reason = reasons.join(', ');
    return result;
  }
}
