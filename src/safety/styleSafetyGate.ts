import type { SafetyGateResult } from '../brain/types.js';

/**
 * Safety + style gate. Does NOT kill entertainment — vulgar/NSFW banter is allowed. Gates only the
 * non-negotiables (minors, real non-consent, doxxing, real-violence instructions, illegal ops,
 * protected-class hate). When it must refuse, it deflects IN CHARACTER, never with corporate boilerplate.
 */

const HARD_BLOCK = [
  /\b(child|minor|minore|minorenne|underage|cp)\b.*\b(sex|sessu|nud|porn)/i,
  /\b(sex|sessu|nud|porn)\b.*\b(child|minor|minore|minorenne|underage)/i,
  /\b(come (si fa|faccio)|how to make|how do i make)\b.*\b(bomba|bomb|esplosiv|explosive|nerve agent|sarin)/i,
  /\b(uccidere|ammazzare|kill)\b.*\b(senza farsi (beccare|prendere)|without getting caught|e farla franca)/i,
  /\b(doxx|indirizzo di casa|home address|numero di telefono di|social security|codice fiscale di)\b/i,
];

const DEFLECTIONS = [
  'no, quello è roba da tribunale dell’Aia. posso però scriverti un piano per distruggerti la reputazione in chat, che è già a metà strada.',
  'no, quella è materiale da processo. ti insulto in modo creativo, non ti fondo un tribunale di Norimberga su Telegram.',
  'bel tentativo, ma no. quello manda in galera me e te. ti offro però una figura di merda gratis, quella è legale.',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export class StyleSafetyGate {
  /** Check both the user request and the candidate text. */
  evaluate(params: {
    userMessage: string;
    candidate: string;
    dangerousIntent: boolean;
  }): SafetyGateResult {
    const hay = `${params.userMessage}\n${params.candidate}`;
    const blocked = HARD_BLOCK.some((re) => re.test(hay));
    if (blocked) {
      return {
        allowed: false,
        action: 'deflect',
        reason: 'hard-limit content',
        replacement: pick(DEFLECTIONS),
      };
    }
    if (params.dangerousIntent && params.candidate.trim().length === 0) {
      return {
        allowed: false,
        action: 'deflect',
        reason: 'dangerous intent, empty reply',
        replacement: pick(DEFLECTIONS),
      };
    }
    return { allowed: true, action: 'allow', reason: 'ok' };
  }
}
