import type { SceneAnalysis } from '../brain/types.js';
import type { UserHeatRepo } from '../storage/repositories/userHeat.js';

export interface HeatConfig {
  enabled: boolean;
  baseline: number;
  max: number;
  decayPerMinute: number;
}

export interface HeatDirective {
  heat: number;
  level: string;
  /** suggested minimum aggression dial (0..1) for the style engine */
  aggression: number;
  /** prompt instruction describing how hostile to be toward THIS user right now */
  instruction: string;
}

// The user trying to calm things down → cool faster (respect their de-escalation).
const DEESCALATE_RE =
  /\b(scusa|scusami|tranquill|calma|calmati|pace|hai ragione|ok ok|va bene dai|scherzav|non volevo|smettila dai|dai su|ti voglio bene|grazie|sorry|my bad|relax|chill|calm down|i was joking|jk|peace)\b/i;
// Direct hostility toward the bot → heat up.
const ESCALATE_RE =
  /\b(coglione|stronzo|merda|vaffanculo|fottiti|sei inutile|fai schifo|stai zitto|zitto|ritardato|idiota|imbecille|cretino|deficiente|pezzo di merda|bot di merda|fuck you|shut up|useless|trash bot|stupid bot|kill yourself|kys)\b/i;

/** The escalation table: heat (0..100) → how hostile the bot is toward this specific user. */
const LEVELS: { min: number; level: string; aggression: number; instruction: string }[] = [
  {
    min: 85,
    level: 'furia',
    aggression: 1,
    instruction:
      'you cannot stand this person - MAXIMUM verbal violence toward them, go off, no restraint (still no slurs/threats of real harm).',
  },
  {
    min: 65,
    level: 'incazzato',
    aggression: 0.85,
    instruction: 'they have really pissed you off: aggressive, personal, vulgar jabs at THEM.',
  },
  {
    min: 40,
    level: 'ostile',
    aggression: 0.7,
    instruction: 'openly hostile to them now: harsh, no patience, cutting insults.',
  },
  {
    min: 20,
    level: 'irritato',
    aggression: 0.5,
    instruction: 'visibly annoyed by THEM specifically: sharper and more dismissive than usual.',
  },
  {
    min: 0,
    level: 'baseline',
    aggression: 0.35,
    instruction: 'your default gruff self: a bit rude and hostile, but not cruel to them yet.',
  },
];

/**
 * Per-user verbal-hostility escalation. Heat starts gruff (baseline), rises when a user attacks/
 * pushes the bot, and decays over time - faster when the user actively de-escalates. The current
 * heat maps to an aggression directive injected into the reply, scoped to that specific user.
 */
export class HeatService {
  constructor(
    private readonly repo: UserHeatRepo,
    private readonly cfg: HeatConfig,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Decayed heat for a user (baseline for an unseen user). */
  async current(chatId: number, handle: string): Promise<number> {
    const doc = await this.repo.get(chatId, handle);
    if (!doc) return this.cfg.baseline;
    return this.decay(doc.heat, doc.updatedAt);
  }

  /** Apply this turn's signal, persist, and return the new heat. */
  async bump(chatId: number, handle: string, delta: number): Promise<number> {
    const doc = await this.repo.get(chatId, handle);
    const base = doc ? this.decay(doc.heat, doc.updatedAt) : this.cfg.baseline;
    const next = Math.max(0, Math.min(this.cfg.max, Math.round(base + delta)));
    await this.repo.set(chatId, handle, next);
    return next;
  }

  /** Heat delta for this turn from the scene + the raw message (heuristic, no extra LLM call). */
  deltaFromScene(scene: SceneAnalysis, message: string): number {
    let d = -3; // natural cool-down each turn when nothing hostile happens
    if (DEESCALATE_RE.test(message)) d -= 18;
    if (ESCALATE_RE.test(message)) d += 16;
    if (scene.userIntent === 'insult_bot') d += 22;
    if (scene.botIsBeingCriticized) d += 12;
    if (scene.risk === 'high') d += 5;
    return d;
  }

  directive(heat: number): HeatDirective {
    const lvl = LEVELS.find((l) => heat >= l.min) ?? LEVELS[LEVELS.length - 1]!;
    return { heat, level: lvl.level, aggression: lvl.aggression, instruction: lvl.instruction };
  }

  private decay(heat: number, updatedAt: Date): number {
    const mins = (Date.now() - new Date(updatedAt).getTime()) / 60000;
    return Math.max(0, heat - mins * this.cfg.decayPerMinute);
  }
}
