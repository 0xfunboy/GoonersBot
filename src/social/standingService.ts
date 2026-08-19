import type { Storage } from '../storage/index.js';
import type { RoastBudget, SceneAnalysis, SocialSignal } from '../brain/types.js';
import {
  bandFor,
  type SocialStandingDoc,
  type StandingBand,
} from '../storage/repositories/socialStanding.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('standing');

/** Someone stepping in on the bot's behalf - the costliest signal available, so worth the most. */
const DEFENDS_BOT_RE =
  /\b(lascialo stare|lasciatelo stare|non e colpa sua|ha ragione (il bot|lui)|dai (che )?e bravo|stai calmo con|non merita|difendo|leave (him|it) alone|he'?s right)\b/i;

/** Explicit warmth toward the bot. */
const WARMTH_RE =
  /\b(grazie|grazie mille|sei (un |il )?(grande|mito|top|forte|bravo|carino|gentile|tesoro)|ti voglio bene|adoro|bravissimo|ottimo lavoro|sei simpatico|mi piaci|thanks|thank you|good bot|love you)\b/i;

export interface StandingObservation {
  chatId: number;
  handle: string;
  message: string;
  scene: SceneAnalysis;
  socialSignal?: SocialSignal | undefined;
  /** True when the bot was the target of the message at all. */
  addressed: boolean;
}

export interface StandingDirective {
  band: StandingBand;
  rapport: number;
  friend: boolean;
  /** Hard ceiling on roast toward this person, independent of the turn's own budget. */
  roastCeiling: RoastBudget;
  /** Compact block for the prompt, or '' when there is nothing worth saying. */
  block: string;
}

/**
 * Tracks how each person has treated the bot and turns that into a tone directive.
 *
 * The service decides *tone only*. Which side the bot takes in a disagreement is decided by
 * evidence elsewhere - a bot whose rapport chose its arguments would just be a sycophant.
 */
export class SocialStandingService {
  constructor(
    private readonly storage: Storage,
    private readonly cfg: { enabled: boolean },
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Observe this turn and return the directive for composing the reply. */
  async observe(input: StandingObservation): Promise<StandingDirective | null> {
    if (!this.enabled) return null;
    const { delta, conflict } = scoreTurn(input);
    try {
      const doc = await this.storage.socialStanding.record(
        input.chatId,
        input.handle,
        delta,
        conflict,
      );
      return this.directiveFor(doc);
    } catch (error) {
      // Standing is a nicety; never let it cost a reply.
      log.debug({ error, handle: input.handle }, 'standing update failed');
      return null;
    }
  }

  /** Read-only lookup, for surfaces that must not record an interaction. */
  async peek(chatId: number, handle: string): Promise<StandingDirective | null> {
    if (!this.enabled) return null;
    const doc = await this.storage.socialStanding.get(chatId, handle).catch(() => null);
    return doc ? this.directiveFor(doc) : null;
  }

  private directiveFor(doc: SocialStandingDoc): StandingDirective {
    const band = bandFor(doc);
    const roastCeiling = ceilingFor(band);
    return {
      band,
      rapport: doc.rapport,
      friend: doc.friend,
      roastCeiling,
      block: renderStanding(doc, band, roastCeiling),
    };
  }
}

/**
 * Per-turn rapport delta.
 *
 * The load-bearing decision is that **teasing scores zero**. This group communicates by insult; if
 * banter cost rapport nobody would ever be tagged a friend and the whole feature would be inert.
 * Only what the classifier calls a genuine conflict is negative.
 */
export function scoreTurn(input: StandingObservation): { delta: number; conflict: boolean } {
  const message = input.message ?? '';
  const situation = input.socialSignal?.situation ?? 'casual';
  const humorAllowed = input.socialSignal?.humorAllowed ?? true;

  if (DEFENDS_BOT_RE.test(message)) return { delta: 8, conflict: false };
  if (situation === 'gratitude') return { delta: 6, conflict: false };
  if (WARMTH_RE.test(message)) return { delta: 6, conflict: false };

  // Genuine hostility: the classifier calls it conflict AND humour is off the table. An insult
  // thrown inside a joking frame is how friends talk here, and must not count.
  const hostile =
    (situation === 'conflict' && !humorAllowed) ||
    (input.scene.userIntent === 'insult_bot' && !humorAllowed);
  if (hostile) return { delta: -10, conflict: true };

  // Banter, including a roast aimed at the bot, is explicitly worth nothing either way.
  if (situation === 'banter' || humorAllowed) return { delta: 0, conflict: false };

  return { delta: input.addressed ? 2 : 0, conflict: false };
}

/** A friend is teased, never savaged. */
export function ceilingFor(band: StandingBand): RoastBudget {
  switch (band) {
    case 'friend':
      return 'light';
    case 'warm':
      return 'medium';
    case 'neutral':
      return 'heavy';
    case 'prickly':
    case 'hostile':
      return 'heavy';
  }
}

/**
 * Render the directive.
 *
 * Instructions, not prose: deterministic code owns who this person is to the bot, and the style
 * engine owns the words.
 */
export function renderStanding(
  doc: SocialStandingDoc,
  band: StandingBand,
  ceiling: RoastBudget,
): string {
  if (band === 'neutral' && doc.interactions < 5) return '';
  const tone =
    band === 'friend'
      ? 'Warm by default. Any jab must read as affectionate; never cutting.'
      : band === 'warm'
        ? 'Friendly. Roast is welcome but keep it good-natured.'
        : band === 'neutral'
          ? 'Normal register.'
          : 'This person has been hostile before. Do not grovel and do not escalate.';
  return [
    `SOCIAL STANDING: ${doc.handle} — ${band} (rapport ${doc.rapport >= 0 ? '+' : ''}${doc.rapport}, ${doc.conflicts} genuine conflicts).`,
    `  Tone: ${tone} Roast ceiling: ${ceiling}.`,
    '  This sets TONE ONLY. It must never decide who is factually right.',
  ].join('\n');
}
