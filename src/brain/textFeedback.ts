const POSITIVE_RE =
  /(\bah+ah+\b|\blol\b|\blmao\b|\bmuoio\b|\bperfetto\b|\bgenio\b|\btop\b|\bbased\b|😂|🤣|😭|💀|❤️|🔥|👏|👍)/i;

const NEGATIVE_FEEDBACK: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'repetitive_or_cringe',
    /\b(ripetitiv\w*|noios\w*|stupid\w*|non fa ridere|bot rotto|npc|sempre uguale|che cazzo dici|cringe|scemo)\b|👎/i,
  ],
  [
    'unwanted_intervention',
    /\b(fatti (?:i |li )?cazzi (?:tuoi|tua)|chi te l['’]?ha chiesto|non ti ho chiesto|non (?:ti )?intromettere|ma fatti gli affari tuoi|mind your own business)\b/i,
  ],
  [
    'too_performative_or_verbose',
    /\b(si ma basta|sì ma basta|basta(?: così)?|ma come parli|parla normale|troppo lungo|papiro|monologo|falla breve|meno parole|too much|too long)\b/i,
  ],
  [
    'forced_roast',
    /\b(accetta (?:un|il) complimento|senza fare lo stronzo|non fare (?:sempre )?lo stronzo|non devi roastare|non fare il satiro)\b/i,
  ],
  [
    'unsupported_personal_claim',
    /\b(che ne sai|senza dati|te lo sei inventat\w*|non inventare|non sai niente di me|non sai (?:un cazzo|nulla) di me)\b/i,
  ],
];

/**
 * Deterministic feedback from text explicitly replying to a bot message. This is intentionally
 * narrow: it is not sentiment analysis and must never score random group chatter as feedback.
 */
export function inferTextFeedback(texts: string[]): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const text of texts) {
    if (POSITIVE_RE.test(text)) {
      score += 1;
      reasons.push('positive');
    }
    for (const [reason, pattern] of NEGATIVE_FEEDBACK) {
      if (!pattern.test(text)) continue;
      score -= 1;
      reasons.push(reason);
    }
  }
  return {
    score: Math.max(-1, Math.min(1, score)),
    reasons: [...new Set(reasons)],
  };
}
