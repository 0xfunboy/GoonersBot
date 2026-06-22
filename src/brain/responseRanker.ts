import { jaccard } from '../memory/memoryDeduper.js';
import type { RetrievedMemory } from '../memory/types.js';
import type { BotReplyRecord, RankedReply, ReplyPlan } from './types.js';

const ASSISTANT_TELLS = [
  /^\s*(certo|sure|of course|ecco|here'?s|come posso|how can i|spero (questo )?aiuti|hope this helps)/i,
  /\bas an ai\b/i,
  /\bnon posso aiutarti\b/i,
];

const STOPWORDS = new Set([
  'come',
  'cosa',
  'che',
  'chi',
  'quando',
  'dove',
  'perche',
  'perché',
  'fare',
  'faccio',
  'fai',
  'una',
  'uno',
  'del',
  'della',
  'the',
  'how',
  'what',
  'why',
  'make',
  'tell',
  'you',
]);

const FACTUAL_MARKERS =
  /\b(è|sono|significa|vuol dire|in pratica|tipicamente|di solito|risch|pericol|overdose|dose|legale|illegale|farmac|oppioid|codeina|prometazina|destrometorfano|dextromethorphan|respir|mix|mischi|mescol)\b/i;

const VALUE_MARKERS =
  /\b(perché|perche|infatti|in realtà|in realta|il punto|significa|dipende|fonte|risulta|secondo|dati|contesto|tecnicamente|corretto|sbagliato|non è|non e'|vero|falso|wrong|false|actually|because|means|context|source|according)\b/i;

const ROAST_ONLY_RE =
  /\b(coglione|stronzo|suca|scemo|idiota|cesso|pagliaccio|rosica|ritardat|porco|minchia|fesso)\b/i;

const CORRECTION_RE =
  /\b(non è così|non e' cosi|in realtà|in realta|sbagli|sbagliato|falso|no,|actually|wrong|false|not quite)\b/i;

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
      userMessage?: string;
    },
  ): RankedReply[] {
    const recentNorms = opts.recent.slice(0, 8).map((r) => r.normalizedText || normalize(r.text));
    const questionTerms = extractTerms(opts.userMessage ?? '');
    const mustAnswer = opts.plan.replyIntent === 'answer_question';
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

      // Serious/technical turns must not win with pure banter or empty deflection.
      if (mustAnswer || opts.plan.mustBringValue) {
        const overlap = coverage(norm, questionTerms);
        const minOverlap = opts.plan.action === 'challenge_claim' ? 0.22 : 0.34;
        if (questionTerms.length > 0 && overlap < minOverlap) {
          score -= 0.9;
          problems.push('misses question');
        } else if (overlap >= minOverlap) {
          score += 0.35;
        }
        if (FACTUAL_MARKERS.test(text) || VALUE_MARKERS.test(text)) score += 0.35;
        else {
          score -= 0.45;
          problems.push('low factual content');
        }
        if (opts.plan.mustBringValue && ROAST_ONLY_RE.test(text) && !VALUE_MARKERS.test(text)) {
          score -= 0.75;
          problems.push('roast-only');
        }
        if (opts.plan.action === 'challenge_claim') {
          if (CORRECTION_RE.test(text)) score += 0.45;
          else {
            score -= 0.35;
            problems.push('weak correction');
          }
        }
      }

      return { index, score, reason: problems.length ? problems.join(', ') : 'clean', problems };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }
}

function extractTerms(text: string): string[] {
  return [
    ...new Set(
      normalize(text)
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .split(/[^a-z0-9_]+/i)
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    ),
  ].slice(0, 8);
}

function coverage(candidateNorm: string, terms: string[]): number {
  if (terms.length === 0) return 1;
  let hits = 0;
  for (const term of terms) {
    if (candidateNorm.includes(term)) hits += 1;
  }
  return hits / terms.length;
}
