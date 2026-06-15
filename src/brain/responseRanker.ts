import { jaccard } from '../memory/memoryDeduper.js';
import type { RetrievedMemory } from '../memory/types.js';
import type { BotReplyRecord, RankedReply, ReplyPlan } from './types.js';

const ASSISTANT_TELLS = [
  /^\s*(certo|sure|of course|ecco|here'?s|come posso|how can i|spero (questo )?aiuti|hope this helps)/i,
  /\bas an ai\b/i,
  /\bnon posso aiutarti\b/i,
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Heuristic ranker: picks the best candidate without an extra LLM call. Rewards brevity, novelty
 * and group-native punch; penalizes assistant tells, repeated openings, banned phrases, verbatim
 * memory, and over-length.
 */
export class ResponseRanker {
  rank(
    candidates: string[],
    opts: {
      recent: BotReplyRecord[];
      plan: ReplyPlan;
      memories: RetrievedMemory[];
      maxChars: number;
    },
  ): RankedReply[] {
    const recentNorms = opts.recent.slice(0, 8).map((r) => r.normalizedText || normalize(r.text));
    const ranked = candidates.map((text, index) => {
      const problems: string[] = [];
      let score = 1;
      const norm = normalize(text);
      const len = text.length;

      // brevity sweet spot
      if (len === 0) {
        score -= 1;
        problems.push('empty');
      } else if (len <= opts.maxChars) {
        score += 0.3;
      } else {
        score -= 0.4 + Math.min(0.5, (len - opts.maxChars) / opts.maxChars);
        problems.push('too long');
      }

      // novelty vs recent replies
      let maxSim = 0;
      for (const r of recentNorms) maxSim = Math.max(maxSim, jaccard(norm, r));
      score += (1 - maxSim) * 0.6;
      if (maxSim > 0.6) problems.push('repetitive');

      // assistant tells
      if (ASSISTANT_TELLS.some((re) => re.test(text))) {
        score -= 0.8;
        problems.push('assistant tone');
      }

      // banned phrases
      if (opts.plan.bannedPhrases.some((p) => norm.includes(normalize(p)))) {
        score -= 0.5;
        problems.push('banned phrase');
      }

      // verbatim memory not allowed
      for (const m of opts.memories) {
        if (!m.allowedToUseExplicitly && norm.includes(normalize(m.item.text))) {
          score -= 0.5;
          problems.push('verbatim memory');
          break;
        }
      }

      // punch: short and ends without trailing fluff
      if (len > 0 && len < 200) score += 0.2;

      return { index, score, reason: problems.length ? problems.join(', ') : 'clean', problems };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }
}
