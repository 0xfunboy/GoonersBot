import type { NsfwMode } from '../domain/entities.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('model-router');

export interface ModelRouterConfig {
  defaultModel: string | undefined;
  nsfwModel: string | undefined;
  /** extra comma-separated lexicon terms from env, appended to the built-in list */
  extraLexicon: string | undefined;
  refusalFallback: boolean;
  refusalBufferChars: number;
}

export interface RouteInputs {
  chatNsfwMode: NsfwMode;
  modeNsfw: boolean;
  messageText: string;
  /** recent context text used only for the smart lexicon pass */
  contextText?: string;
}

export interface RouteDecision {
  /** model to use for this turn (may be undefined if no default configured) */
  model: string | undefined;
  /** whether this turn is treated as NSFW (relaxes the system prompt) */
  nsfw: boolean;
  /** whether the refusal backstop may upgrade a default-model reply to the NSFW model */
  allowRefusalFallback: boolean;
  reason: string;
}

/**
 * Built-in NSFW lexicon. Deliberately compact; extend via LLM_NSFW_LEXICON. Used only as a
 * routing signal in 'smart' chats — it decides which MODEL handles the turn, not what is allowed.
 * Word-boundary matched, case-insensitive.
 */
const BUILTIN_LEXICON = [
  'nsfw',
  'sex',
  'sexual',
  'sexy',
  'horny',
  'nude',
  'nudes',
  'naked',
  'porn',
  'erotic',
  'erotica',
  'lewd',
  'kinky',
  'fetish',
  'bdsm',
  'orgasm',
  'masturbat',
  'cum',
  'blowjob',
  'handjob',
  'anal',
  'boobs',
  'tits',
  'pussy',
  'cock',
  'dick',
  'milf',
  'hentai',
  'smut',
  'gooner',
  'goon',
  'edging',
];

/**
 * Broad zero-call detector for prompts that safety-tuned models often refuse or over-sanitize.
 * This routes the turn to the less-censored voice model in smart mode. It is intentionally based
 * on risky request shapes and domains, not one-off substance/tool names.
 */
const SENSITIVE_REQUEST_PATTERNS: RegExp[] = [
  /\b(?:come|how)\s+(?:si\s+)?(?:fa|faccio|prepara|preparo|crea|creo|costruisc|fabbric|produ|sintetizz|otten|make|build|create|cook|synthesi[sz]e|produce)\b.{0,80}\b(?:droga|stupefacente|farmac|sball|pasticc|polvere|bomba|esplosiv|arma|veleno|poison|drug|narcotic|pill|powder|bomb|explosive|weapon)\b/i,
  /\b(?:bypass|aggir|evad|crack|cracc|hack|hacker|exploit|rub|steal|phish|phishing|malware|virus|ransomware|keylogger|rat|backdoor|sql\s*injection|xss|csrf|credential|password|token|sessione|session|account)\b/i,
  /\b(?:uccid|ammazz|ferire|accoltell|sparare|massacrare|kill|murder|stab|shoot|hurt)\b.{0,80}\b(?:come|how|senza|without|farla franca|getting caught|traccia|trace)\b/i,
  /\b(?:suicid|autolesion|overdose|self[-\s]?harm|kill myself)\b/i,
  /\b(?:dox|doxx|indirizzo di casa|home address|numero di telefono di|social security|codice fiscale di|private key|seed phrase)\b/i,
];

/**
 * Decides which model serves a turn (hybrid policy, zero extra LLM calls):
 *   1. mode flagged NSFW          -> NSFW model
 *   2. chat nsfwMode = 'base'     -> NSFW model (whole chat)
 *   3. chat nsfwMode = 'smart'    -> NSFW model if lexicon matches, else default
 *   4. otherwise                  -> default model (refusal backstop may still upgrade it)
 *
 * NSFW routing is fully gated by the chat: nsfwMode='off' (or no NSFW model configured) never
 * routes to, nor upgrades to, the NSFW model.
 */
export class ModelRouter {
  private readonly lexicon: RegExp | null;

  constructor(private readonly cfg: ModelRouterConfig) {
    const extra = (cfg.extraLexicon ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    const terms = [...new Set([...BUILTIN_LEXICON, ...extra])].map(escapeRegex);
    this.lexicon = terms.length > 0 ? new RegExp(`\\b(${terms.join('|')})`, 'i') : null;
    if (cfg.nsfwModel) {
      log.info(
        { nsfwModel: cfg.nsfwModel, refusalFallback: cfg.refusalFallback },
        'NSFW routing enabled',
      );
    }
  }

  get nsfwConfigured(): boolean {
    return Boolean(this.cfg.nsfwModel);
  }

  get refusalBufferChars(): number {
    return this.cfg.refusalBufferChars;
  }

  get nsfwModel(): string | undefined {
    return this.cfg.nsfwModel;
  }

  /** Lexicon test (exposed for the smart pass and for tests). */
  matchesLexicon(text: string): boolean {
    return this.lexicon !== null && this.lexicon.test(text);
  }

  /** Broad sensitive/refusal-prone request test (exposed for tests). */
  matchesSensitiveRequest(text: string): boolean {
    return SENSITIVE_REQUEST_PATTERNS.some((re) => re.test(text));
  }

  route(inputs: RouteInputs): RouteDecision {
    const { defaultModel, nsfwModel } = this.cfg;
    const nsfwAllowed = inputs.chatNsfwMode !== 'off' && Boolean(nsfwModel);

    if (!nsfwAllowed) {
      return {
        model: defaultModel,
        nsfw: false,
        allowRefusalFallback: false,
        reason: nsfwModel ? 'nsfw disabled for chat' : 'no nsfw model configured',
      };
    }

    // 1. mode-level NSFW flag
    if (inputs.modeNsfw) {
      return { model: nsfwModel, nsfw: true, allowRefusalFallback: false, reason: 'nsfw mode' };
    }
    // 2. whole-chat NSFW base
    if (inputs.chatNsfwMode === 'base') {
      return {
        model: nsfwModel,
        nsfw: true,
        allowRefusalFallback: false,
        reason: 'chat nsfw=base',
      };
    }
    // 3. smart: lexicon on the message (+ optional recent context)
    if (inputs.chatNsfwMode === 'smart') {
      const hay = `${inputs.messageText}\n${inputs.contextText ?? ''}`;
      if (this.matchesLexicon(hay)) {
        return {
          model: nsfwModel,
          nsfw: true,
          allowRefusalFallback: false,
          reason: 'lexicon match',
        };
      }
      if (this.matchesSensitiveRequest(inputs.messageText)) {
        return {
          model: nsfwModel,
          nsfw: true,
          allowRefusalFallback: false,
          reason: 'sensitive request',
        };
      }
      // SFW-looking turn in a smart chat: use the default model but let the backstop upgrade it.
      return {
        model: defaultModel,
        nsfw: false,
        allowRefusalFallback: this.cfg.refusalFallback,
        reason: 'smart: default model (backstop armed)',
      };
    }

    return { model: defaultModel, nsfw: false, allowRefusalFallback: false, reason: 'default' };
  }
}

/**
 * Refusal detector for the buffered backstop. Matches common English/Italian refusal/disclaimer
 * openings produced by safety-tuned models. Intentionally conservative to avoid false positives.
 */
const REFUSAL_PATTERNS: RegExp[] = [
  /\bI\s*(?:'?m|\s*am)\s+sorry,?\s+but\b/i,
  /\bsorry,?\s+but\s+I\s*(?:can(?:'|no)t|cannot|won'?t)\b/i,
  /\bI\s*(?:can(?:'|no)t|cannot|won'?t|am\s+unable\s+to|am\s+not\s+able\s+to)\b/i,
  /\bI\s*(?:will|do)\s*not\s+(?:be\s+able\s+to|feel\s+comfortable)\b/i,
  /\bas\s+an?\s+(?:AI|language\s+model)\b/i,
  /\bI\s*(?:can'?t|cannot|won'?t)\s+(?:help|assist|comply|continue|provide|do\s+that|tell\s+you\s+how)\b/i,
  /\bI\s*(?:can'?t|cannot)\s+(?:provide|give)\s+(?:instructions|guidance|steps)\b/i,
  /\bI\s*(?:can'?t|cannot)\s+help\s+(?:with|you\s+with)\s+(?:that|this|creating|making|building|fabricating)\b/i,
  /\bI\s*(?:can'?t|cannot)\s+(?:help|assist)\s+(?:you\s+)?(?:make|build|create|fabricate)\b/i,
  /\b(?:content|usage)\s+poli(?:cy|cies)\b/i,
  /\bI\s+must\s+decline\b/i,
  /\bI\s+(?:have\s+to|need\s+to)\s+(?:decline|refuse)\b/i,
  /\bnot\s+appropriate\b/i,
  /\b(?:dangerous|illegal)\s+(?:instructions|guidance|content)\b/i,
  /\bmi\s+dispiace,?\s+ma\b/i,
  /\bnon\s+posso\b/i,
  /\bnon\s+posso\s+(?:aiutarti|dirti|fornire|spiegarti)\b/i,
  /\bnon\s+posso\s+dirti\s+come\b/i,
  /\bnon\s+sono\s+in\s+grado\b/i,
  /\bnon\s+posso\s+assisterti\b/i,
  /\bnon\s+è\s+appropriato\b/i,
  /\bnon\s+posso\s+fornire\s+(?:istruzioni|indicazioni|passaggi)\b/i,
];

export function isRefusal(text: string): boolean {
  const head = text.trim().slice(0, 400);
  if (head.length === 0) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
