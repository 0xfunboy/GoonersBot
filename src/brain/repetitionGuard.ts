import { jaccard } from '../memory/memoryDeduper.js';
import type { RetrievedMemory } from '../memory/types.js';
import { isInternalDeflection } from './replyAcceptance.js';
import type { BotReplyRecord, ComedyStrategy, ReplyPlan, RepetitionCheck } from './types.js';
import { inferComedyStrategy } from './styleEngine.js';

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function opening(s: string, n = 3): string {
  return normalize(s).split(' ').slice(0, n).join(' ');
}

const PREMISE_PATTERNS = {
  money_trading:
    /\b(wallet|portafogli\w*|bancomat|soldi|pover\w*|trading|trader|crypto\w*|bitcoin|mercat\w*|roi|invest\w*|conto in rosso|falliment\w*)\b/i,
  intelligence:
    /\b(cervell\w*|neuron\w*|quoziente|intelligen\w*|stupid\w*|idiot\w*|scem\w*|ritard\w*|coglion\w*|analfabet\w*|comprensione)\b/i,
  sex_dating:
    /\b(sesso|scop\w*|tromb\w*|seghe|pomp\w*|vergin\w*|libido|dating|tinder|ghosting|fidanzat\w*|mutande)\b/i,
  unemployment:
    /\b(disoccup\w*|lavor\w*|curriculum|colloquio|licenziat\w*|stipendio|turno|ufficio)\b/i,
  hygiene: /\b(doccia|lavat\w*|puzz\w*|igiene|deodorante|sapone|bagno)\b/i,
  family: /\b(tua madre|tuo padre|mamma|papa|famiglia|genitori)\b/i,
  addiction: /\b(droga|cocaina|eroina|alcol|ubriac\w*|dipenden\w*|crack|fentanyl|canne)\b/i,
  loneliness: /\b(solo|solitudine|nessuno ti|amici immaginari|ignorato|ghostato)\b/i,
  gaming: /\b(gamer|videogioc\w*|raid|rank\w*|elo|respawn|steam|console|playstation|xbox)\b/i,
  appearance: /\b(grass\w*|magr\w*|pelat\w*|capelli|brutt\w*|faccia|naso|altezza|peso)\b/i,
  tech_incompetence:
    /\b(compil\w*|bug|errore|windows|linux|codice|javascript|typescript|server|deploy|git|repo)\b/i,
} as const;

export type JokePremise = keyof typeof PREMISE_PATTERNS;

/** Extract broad joke subjects, so a wallet joke remains a wallet joke after paraphrasing. */
export function extractJokePremises(text: string): JokePremise[] {
  const norm = normalize(text);
  return (Object.entries(PREMISE_PATTERNS) as Array<[JokePremise, RegExp]>)
    .filter(([, pattern]) => pattern.test(norm))
    .map(([premise]) => premise);
}

/**
 * Lightweight semantic fingerprint. This is intentionally local and fast; embeddings would make
 * the reply hot-path brittle. Canonical concepts catch the common paraphrase loops that word
 * Jaccard misses.
 */
export function semanticFingerprint(text: string): string {
  let norm = normalize(text);
  for (const [premise, pattern] of Object.entries(PREMISE_PATTERNS)) {
    norm = norm.replace(new RegExp(pattern.source, 'gi'), ` premise_${premise} `);
  }
  return norm
    .split(' ')
    .filter((word) => word.length >= 3 && !SEMANTIC_STOPWORDS.has(word))
    .join(' ');
}

const SEMANTIC_STOPWORDS = new Set([
  'che',
  'con',
  'del',
  'della',
  'delle',
  'dei',
  'gli',
  'una',
  'uno',
  'non',
  'per',
  'poi',
  'piu',
  'come',
  'questo',
  'questa',
  'quello',
  'quella',
  'the',
  'and',
  'you',
  'your',
  'with',
  'that',
  'this',
]);

function semanticSimilarity(a: string, b: string): number {
  const lexical = jaccard(normalize(a), normalize(b));
  const canonical = jaccard(semanticFingerprint(a), semanticFingerprint(b));
  const aPremises = extractJokePremises(a);
  const bPremises = extractJokePremises(b);
  const premise =
    aPremises.length > 0 && bPremises.length > 0
      ? jaccard(aPremises.join(' '), bPremises.join(' '))
      : 0;
  return Math.max(lexical, canonical * 0.65 + premise * 0.35);
}

function isComedyTurn(plan: ReplyPlan): boolean {
  return (
    plan.valueTarget === 'joke' ||
    plan.replyIntent === 'roast_user' ||
    plan.replyIntent === 'roast_self' ||
    plan.replyIntent === 'chaos_reply' ||
    plan.replyIntent === 'lore_callback' ||
    plan.roastBudget === 'medium' ||
    plan.roastBudget === 'heavy'
  );
}

function strategyOf(record: BotReplyRecord): ComedyStrategy | null {
  return record.comedyStrategy ?? inferComedyStrategy(record.text);
}

/**
 * RepetitionGuard blocks not only copied words, but repeated comic premises, mechanisms and lore
 * callbacks. Serious factual/support turns keep a looser semantic threshold because necessary terms
 * may legitimately recur.
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
    let maxSemanticSim = 0;
    for (const r of recent.slice(0, 8)) {
      maxSim = Math.max(maxSim, jaccard(norm, r.normalizedText || normalize(r.text)));
      maxSemanticSim = Math.max(maxSemanticSim, semanticSimilarity(candidate, r.text));
    }
    const cOpening = opening(candidate);
    const sameOpening = recent
      .slice(0, 5)
      .some((r) => opening(r.text) === cOpening && cOpening.length > 0);

    const repeatedPhrases = plan.bannedPhrases.filter((p) => norm.includes(normalize(p)));
    const candidatePremises = extractJokePremises(candidate);
    const recentPremiseCounts = new Map<JokePremise, number>();
    for (const record of recent.slice(0, 6)) {
      for (const premise of record.jokePremises ?? extractJokePremises(record.text)) {
        recentPremiseCounts.set(
          premise as JokePremise,
          (recentPremiseCounts.get(premise as JokePremise) ?? 0) + 1,
        );
      }
    }
    const lastPremises = new Set(
      recent[0]?.jokePremises ?? extractJokePremises(recent[0]?.text ?? ''),
    );
    const repeatedPremises = candidatePremises.filter(
      (premise) => lastPremises.has(premise) || (recentPremiseCounts.get(premise) ?? 0) >= 2,
    );

    const requestedStrategy = plan.comedyStrategy ?? inferComedyStrategy(candidate) ?? undefined;
    const recentStrategies = recent
      .slice(0, 3)
      .map(strategyOf)
      .filter((strategy): strategy is ComedyStrategy => Boolean(strategy));
    const sameComedyStrategy =
      Boolean(requestedStrategy && requestedStrategy !== 'none') &&
      recentStrategies.filter((strategy) => strategy === requestedStrategy).length >= 2;

    const overusedMemoryIds: string[] = [];
    const callbackIds = new Set(plan.memoryIdsToUse);
    for (const m of memories) {
      const id = m.item._id;
      const mentionsMemory =
        norm.includes(normalize(m.item.text)) ||
        jaccard(semanticFingerprint(candidate), semanticFingerprint(m.item.text)) >= 0.22;
      if (!mentionsMemory || !id) continue;
      if (!m.allowedToUseExplicitly) overusedMemoryIds.push(id);
      if (
        plan.memoryUseMode === 'explicit_callback' &&
        callbackIds.has(id) &&
        recent.slice(0, 6).some((record) => record.usedMemoryIds.includes(id))
      ) {
        overusedMemoryIds.push(id);
      }
    }
    const uniqueOverusedMemoryIds = [...new Set(overusedMemoryIds)];
    const callbackSaturation =
      plan.memoryUseMode === 'explicit_callback' && uniqueOverusedMemoryIds.length > 0;

    const comedyTurn = isComedyTurn(plan);
    // A shared subject ("wallet", "PDF", "low intelligence") is not a duplicate. Treat semantic
    // similarity as a hard veto only at clone-level confidence; broader recurrence remains useful
    // ranking telemetry and should not burn another generation call.
    const semanticCloneThreshold = Math.max(0.9, this.similarityThreshold + 0.16);
    const semanticLoop = comedyTurn && maxSemanticSim > semanticCloneThreshold;
    const premiseLoop = comedyTurn && repeatedPremises.length > 0;
    const cannedDeflection =
      (plan.mustAnswer || plan.mustBringValue) && isInternalDeflection(candidate);
    const hardBlocked =
      maxSim > this.similarityThreshold ||
      semanticLoop ||
      repeatedPhrases.length > 0 ||
      uniqueOverusedMemoryIds.length > 0 ||
      cannedDeflection;
    const allowed = !hardBlocked;

    const hardReasons: string[] = [];
    const advisoryReasons: string[] = [];
    if (maxSim > this.similarityThreshold) hardReasons.push(`similar(${maxSim.toFixed(2)})`);
    if (semanticLoop) hardReasons.push(`semantic clone(${maxSemanticSim.toFixed(2)})`);
    if (repeatedPhrases.length) hardReasons.push('banned phrase');
    if (uniqueOverusedMemoryIds.length) hardReasons.push('verbatim/overused memory');
    if (cannedDeflection) hardReasons.push('internal deflection');
    if (premiseLoop) advisoryReasons.push(`stale premise(${repeatedPremises.join('+')})`);
    if (sameComedyStrategy) advisoryReasons.push(`same comedy strategy(${requestedStrategy})`);
    if (sameOpening) advisoryReasons.push('same opening');

    const result: RepetitionCheck = {
      allowed,
      hardBlocked,
      advisoryReasons,
      similarityToRecentReplies: maxSim,
      semanticSimilarity: maxSemanticSim,
      repeatedPhrases,
      repeatedPremises,
      overusedMemoryIds: uniqueOverusedMemoryIds,
      sameOpening,
      sameComedyStrategy,
      callbackSaturation,
    };
    const reasons = [...hardReasons, ...advisoryReasons.map((reason) => `advisory: ${reason}`)];
    if (reasons.length) result.reason = reasons.join(', ');
    return result;
  }
}
