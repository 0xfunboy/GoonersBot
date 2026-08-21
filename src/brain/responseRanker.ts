import { jaccard } from '../memory/memoryDeduper.js';
import type { RetrievedMemory } from '../memory/types.js';
import type { BotReplyRecord, RankedReply, ReplyPlan } from './types.js';
import { extractJokePremises } from './repetitionGuard.js';
import { isSeriousSupport, violatesSocialFloor } from './socialAwareness.js';
import { inferComedyStrategy, inferConceptClusters } from './styleEngine.js';

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

const SUPPORT_ACK_RE =
  /\b(mi dispiace|ti credo|capisco|dev'essere|deve essere|fa male|resto qui|ci sono|non sei sol[oa]|sono con te|i'?m sorry|i believe you|i'?m here|that hurts)\b/i;
const SUPPORT_ACTION_RE =
  /\b(respira|chiama|scrivi|parla|allontanati|siediti|bevi|contatta|andiamo|facciamo|dimmi|call|text|tell|contact|breathe|step away)\b/i;
const DISMISSIVE_SUPPORT_RE =
  /\b(fai meno drama|piantala|smettila di frign|chissenefrega|problemi veri|sei patetic|attention seeker|get over it|stop whining|nobody cares)\b/i;
const GRATITUDE_ACK_RE =
  /\b(figurati|prego|di niente|ci sono|quando vuoi|volentieri|grazie a te|anytime|you'?re welcome|no problem|de nada)\b/i;

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
    const recentPremises = new Set(
      opts.recent.slice(0, 5).flatMap((r) => r.jokePremises ?? extractJokePremises(r.text)),
    );
    const recentStrategies = opts.recent
      .slice(0, 4)
      .map((r) => r.comedyStrategy ?? inferComedyStrategy(r.text))
      .filter(Boolean);
    const recentConceptCounts = new Map<string, number>();
    for (const reply of opts.recent.slice(0, 6)) {
      for (const concept of inferConceptClusters(reply.text)) {
        recentConceptCounts.set(concept, (recentConceptCounts.get(concept) ?? 0) + 1);
      }
    }
    const questionTerms = extractTerms(opts.userMessage ?? '');
    const mustAnswer = opts.plan.replyIntent === 'answer_question';
    const seriousSupport = isSeriousSupport(opts.plan.socialSignal);
    const gratitudeTurn = opts.plan.socialSignal?.situation === 'gratitude';
    const shortSocial =
      opts.plan.action === 'acknowledge' ||
      opts.plan.action === 'react_short' ||
      opts.plan.action === 'disagree_briefly';
    const comedyTurn =
      opts.plan.valueTarget === 'joke' ||
      opts.plan.roastBudget === 'medium' ||
      opts.plan.roastBudget === 'heavy';
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
        score += shortSocial ? 0.65 : 0.3;
      } else {
        score -= (shortSocial ? 1.8 : 0.4) + Math.min(0.8, (len - opts.maxChars) / opts.maxChars);
        problems.push(shortSocial ? 'violates short social contract' : 'too long');
      }
      if (
        shortSocial &&
        /^(?:\*\*)?(?:report|rapporto|verbale|bollettino|diagnosi|ministero|comitato|reparto)\b/i.test(
          text,
        )
      ) {
        score -= 1.2;
        problems.push('performative fake-heading on social turn');
      }

      // novelty vs recent replies
      let maxSim = 0;
      for (const r of recentNorms) maxSim = Math.max(maxSim, jaccard(norm, r));
      score += (1 - maxSim) * 0.6;
      if (maxSim > 0.6) problems.push('repetitive');

      const repeatedPremises = extractJokePremises(text).filter((premise) =>
        recentPremises.has(premise),
      );
      const repeatedConcepts = inferConceptClusters(text).filter(
        (concept) => (recentConceptCounts.get(concept) ?? 0) >= 2,
      );
      if (
        repeatedConcepts.length > 0 &&
        (shortSocial || opts.plan.valueTarget === 'social_glue' || comedyTurn)
      ) {
        score -= Math.min(1.2, repeatedConcepts.length * 0.65);
        problems.push(`stale semantic joke domain: ${repeatedConcepts.join('+')}`);
      }
      if (comedyTurn && repeatedPremises.length > 0) {
        score -= 0.75;
        problems.push(`stale joke premise: ${repeatedPremises.join('+')}`);
      }
      const strategy = opts.plan.comedyStrategy ?? inferComedyStrategy(text);
      if (
        comedyTurn &&
        strategy &&
        strategy !== 'none' &&
        recentStrategies.filter((recent) => recent === strategy).length >= 2
      ) {
        score -= 0.55;
        problems.push(`stale comedy strategy: ${strategy}`);
      }

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

      // When someone is vulnerable, reliability outranks the character performance. A useful,
      // human answer may still swear at the situation, but never at the person asking for help.
      if (seriousSupport) {
        if (DISMISSIVE_SUPPORT_RE.test(text) || ROAST_ONLY_RE.test(text)) {
          score -= 2;
          problems.push('hostile during support');
        }
        if (SUPPORT_ACK_RE.test(text)) score += 0.45;
        else {
          score -= 0.25;
          problems.push('does not acknowledge distress');
        }
        if (SUPPORT_ACTION_RE.test(text)) score += 0.5;
        else {
          score -= 0.2;
          problems.push('no practical next step');
        }
      }

      // `humorAllowed=false` is a hard floor, not a soft style preference. It also covers gratitude,
      // where a backhanded "you're welcome" was the concrete repetition bug that prompted v2.
      if (violatesSocialFloor(text, opts.plan.socialSignal)) {
        score -= 5;
        problems.push('violates social floor');
      }
      if (gratitudeTurn) {
        if (GRATITUDE_ACK_RE.test(text)) score += 0.6;
        else {
          score -= 0.35;
          problems.push('does not acknowledge gratitude');
        }
      }

      return { index, score, reason: problems.length ? problems.join(', ') : 'clean', problems };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }
}

export type ResponseRankOptions = Parameters<ResponseRanker['rank']>[1];

/**
 * Ranking is deliberately an optimization, never a single point of failure. If a future ranker
 * implementation or malformed telemetry throws, preserve generation order and let the hard
 * acceptance floors make the final decision.
 */
export function rankCandidatesSafely(
  ranker: Pick<ResponseRanker, 'rank'>,
  candidates: string[],
  options: ResponseRankOptions,
  onError?: (error: unknown) => void,
): RankedReply[] {
  try {
    const ranked = ranker.rank(candidates, options);
    const valid = ranked.filter(
      (candidate) =>
        Number.isInteger(candidate.index) &&
        candidate.index >= 0 &&
        candidate.index < candidates.length,
    );
    if (
      valid.length === candidates.length &&
      new Set(valid.map((candidate) => candidate.index)).size === candidates.length
    ) {
      return valid;
    }
    throw new Error('ranker returned an incomplete or invalid candidate set');
  } catch (error) {
    onError?.(error);
    return candidates.map((_, index) => ({
      index,
      score: 0,
      reason: 'generation-order fallback',
      problems: ['ranker unavailable'],
    }));
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
