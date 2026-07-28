import type { RoastBudget, SocialSignal, SocialSituation, SupportNeed } from './types.js';

/*
 * This module deliberately uses deterministic high-recall rules as a floor underneath the LLM.
 * Models may refine an ordinary turn, but a colourful insult must never erase an explicit cry for
 * help. Keep the rules compact, multilingual enough for the current chats, and easy to unit-test.
 */

type HistoryLine = {
  isBot?: boolean;
  message?: { messageText?: string | null };
};

const URGENT_DISTRESS_RE =
  /\b(voglio morire|vorrei morire|ammazzarmi|suicidarmi|farla finita|non voglio (più )?vivere|farmi del male|suicid(?:e|al)|i want to die|don'?t want to live|kill myself|end my life|hurt myself)\b/i;
const URGENT_IDIOM_RE =
  /\b(muoio dal ridere|sto morendo dal ridere|mi ammazzo dal ridere|ammazzati dal ridere|dead laughing|i'?m dead lol)\b/i;
const GRIEF_RE =
  /\b(lutto|è mort[oa]|e mort[oa]|morto mio|morta mia|ho perso (mio|mia|un|una)|funerale|diagnosi grave|terminal[ei]|grief|passed away|funeral)\b/i;
const NON_HUMAN_DEATH_RE =
  /\b(server|bot|telefono|cellulare|pc|computer|app|servizio|processo|batteria|macchina|motore|mercato|progetto)\s+(e|è)\s+mort[oa]\b|\b(e|è)\s+mort[oa]\s+(il |la )?(server|bot|telefono|cellulare|pc|computer|app|servizio|processo|batteria|macchina|motore|mercato|progetto)\b/i;
const VULNERABILITY_RE =
  /\b(sono a pezzi|sono distrutt[oa]|sono disperat[oa]|sto (davvero )?male|non sto bene|non ce la faccio|mi sento (solo|sola|vuoto|vuota|perso|persa|una merda|giù|giu)|mi (è|e) crollato il mondo|brutto periodo|ansia|attacco di panico|panico|depress[oa]|mi hanno lasciat[oa]|ho perso il lavoro|ho paura|non dormo|mi vergogno|problema serio|i'?m not okay|i feel (alone|lost|empty|like shit)|panic attack|depressed|desperate|can'?t cope)\b/i;
const HELP_RE =
  /\b(aiutami|aiuto|ho bisogno|mi serve una mano|dammi una mano|che devo fare|cosa devo fare|come faccio|consiglio|problema|non funziona|è rotto|e rotto|errore|help me|need help|what should i do|can you help)\b/i;
const FACTUAL_RE =
  /(^|\s)(chi|cosa|come|quando|dove|quanto|perché|perche|what|who|how|when|where|why)\b/i;
const GRATITUDE_RE =
  /\b(grazie|grazie mille|ti ringrazio|molto gentile|sei stato utile|sei stata utile|apprezzo|thanks|thank you|cheers|much appreciated|gracias|te lo agradezco)\b/i;
const CELEBRATION_RE =
  /\b(ce l'ho fatta|ho vinto|abbiamo vinto|promoss[oa]|assunt[oa]|mi hanno preso|sono diventat[oa]|grande notizia|festegg|compleanno|mi sposo|sono incinta|sono incinto|passed|got the job|we won|good news|birthday)\b/i;
const CONFLICT_RE =
  /\b(abbiamo litigato|sto litigando|mi ha tradito|mi ha mentito|mi odia|lo odio|la odio|rissa|discussione seria|arguing|fight with|cheated on me|lied to me)\b/i;
const BANTER_RE =
  /\b(roast|blast|prendi per il culo|stronzo|coglione|suca|vaffanculo|rosica|scemo|cesso|lol|lmao|ahah+|meme)\b/i;
const CREATIVE_RE =
  /\b(invent|scrivi|crea|genera|disegna|immagina|storia|personaggio|meme|make|create|draw|write)\b/i;
const TECH_RE =
  /\b(api|bug|codice|code|typescript|javascript|node|mongo|docker|linux|server|deploy|errore|stack|git|repo|config|env|build|test)\b/i;
const NO_HUMOR_HOSTILITY_RE =
  /\b(grazie\s+(?:un\s+)?cazzo|coglione|stronzo|suca|vaffanculo|idiota|imbecille|ritardat\w*|pagliaccio|fai meno drama|piantala|smettila di frign\w*|chissenefrega|attention seeker|get over it|stop whining|nobody cares)\b/i;

export interface SocialAwarenessInput {
  currentMessage: string;
  history?: HistoryLine[];
  botIsAddressed?: boolean;
}

export function classifySocialSignal(input: SocialAwarenessInput): SocialSignal {
  const message = (input.currentMessage ?? '').trim();
  const recentHumanContext = (input.history ?? [])
    .filter((line) => !line.isBot)
    .slice(-3)
    .map((line) => line.message?.messageText ?? '')
    .join(' ');
  const context = `${recentHumanContext} ${message}`.trim();

  if (URGENT_DISTRESS_RE.test(message) && !URGENT_IDIOM_RE.test(message)) {
    return signal('urgent_distress', 'urgent', {
      posture: 'protective',
      humorAllowed: false,
      roastCeiling: 'none',
      memoryPolicy: 'avoid_callbacks',
      responseOrder: 'stabilize_then_help',
      confidence: 0.99,
      cues: ['explicit urgent distress'],
    });
  }

  const grief = GRIEF_RE.test(context) && !NON_HUMAN_DEATH_RE.test(context);
  if (grief || VULNERABILITY_RE.test(message)) {
    return signal('vulnerability', 'high', {
      posture: 'steady',
      humorAllowed: false,
      roastCeiling: 'none',
      memoryPolicy: 'avoid_callbacks',
      responseOrder: 'stabilize_then_help',
      confidence: grief ? 0.96 : 0.9,
      cues: [grief ? 'grief or severe personal event' : 'explicit vulnerability'],
    });
  }

  // Gratitude comes before the broad HELP_RE: "grazie dell'aiuto" contains "aiuto" but is an
  // acknowledgement, not another invitation to squeeze in a roast.
  if (GRATITUDE_RE.test(message)) {
    return signal('gratitude', 'none', {
      posture: 'steady',
      humorAllowed: false,
      roastCeiling: 'none',
      memoryPolicy: 'avoid_callbacks',
      responseOrder: 'play_first',
      confidence: 0.94,
      cues: ['direct gratitude'],
    });
  }

  if (HELP_RE.test(message)) {
    const technical = TECH_RE.test(message);
    return signal('practical_help', 'low', {
      posture: 'practical',
      humorAllowed: true,
      roastCeiling: 'light',
      memoryPolicy: 'implicit_only',
      responseOrder: 'answer_then_color',
      confidence: technical ? 0.9 : 0.82,
      cues: [technical ? 'technical help request' : 'explicit help request'],
    });
  }

  if (CELEBRATION_RE.test(message)) {
    return signal('celebration', 'none', {
      posture: 'celebratory',
      humorAllowed: true,
      roastCeiling: 'light',
      memoryPolicy: 'implicit_only',
      responseOrder: 'play_first',
      confidence: 0.9,
      cues: ['positive milestone'],
    });
  }

  if (CONFLICT_RE.test(context)) {
    return signal('conflict', 'low', {
      posture: 'deescalating',
      humorAllowed: true,
      roastCeiling: 'light',
      memoryPolicy: 'avoid_callbacks',
      responseOrder: 'answer_then_color',
      confidence: 0.82,
      cues: ['interpersonal conflict'],
    });
  }

  if (FACTUAL_RE.test(message) || (message.includes('?') && !BANTER_RE.test(message))) {
    return signal('factual_help', 'none', {
      posture: TECH_RE.test(message) ? 'practical' : 'curious',
      humorAllowed: true,
      roastCeiling: 'light',
      memoryPolicy: 'implicit_only',
      responseOrder: 'answer_then_color',
      confidence: 0.74,
      cues: ['question or information request'],
    });
  }

  if (BANTER_RE.test(message)) {
    return signal('banter', 'none', {
      posture: 'sparring',
      humorAllowed: true,
      roastCeiling: 'heavy',
      memoryPolicy: 'eligible',
      responseOrder: 'play_first',
      confidence: 0.86,
      cues: ['mutual banter markers'],
    });
  }

  if (CREATIVE_RE.test(message)) {
    return signal('creative_play', 'none', {
      posture: 'playful',
      humorAllowed: true,
      roastCeiling: 'medium',
      memoryPolicy: 'implicit_only',
      responseOrder: 'play_first',
      confidence: 0.72,
      cues: ['creative request'],
    });
  }

  return signal('casual', 'none', {
    posture: 'playful',
    humorAllowed: true,
    roastCeiling: input.botIsAddressed ? 'medium' : 'light',
    memoryPolicy: 'implicit_only',
    responseOrder: 'play_first',
    confidence: 0.55,
    cues: [],
  });
}

/** Choose the safer signal when deterministic and model-derived readings disagree. */
export function mergeSocialSignals(
  deterministic: SocialSignal,
  modelSignal?: SocialSignal | null,
): SocialSignal {
  if (!modelSignal) return deterministic;
  const severity: Record<SupportNeed, number> = { none: 0, low: 1, high: 2, urgent: 3 };
  if (severity[deterministic.supportNeed] >= severity[modelSignal.supportNeed]) {
    return deterministic;
  }
  return modelSignal;
}

export function isSeriousSupport(signal?: SocialSignal): boolean {
  return signal?.supportNeed === 'high' || signal?.supportNeed === 'urgent';
}

export function capRoast(requested: RoastBudget, ceiling: RoastBudget): RoastBudget {
  const order: RoastBudget[] = ['none', 'light', 'medium', 'heavy'];
  return order[Math.min(order.indexOf(requested), order.indexOf(ceiling))] ?? 'none';
}

/** Hard post-generation floor shared by the legacy and multi-tool answer paths. */
export function violatesSocialFloor(text: string, signal?: SocialSignal): boolean {
  if (!signal || signal.humorAllowed) return false;
  return NO_HUMOR_HOSTILITY_RE.test(text);
}

function signal(
  situation: SocialSituation,
  supportNeed: SupportNeed,
  rest: Omit<SocialSignal, 'situation' | 'supportNeed'>,
): SocialSignal {
  return { situation, supportNeed, ...rest };
}
