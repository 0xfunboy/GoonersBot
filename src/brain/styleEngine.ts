import type { SceneAnalysis, StyleProfile } from './types.js';
import type { BotReplyRecord } from './types.js';

/**
 * StyleEngine: varies the bot's voice every turn so it never sounds like the same NPC.
 * Repetition isn't only repeated facts — it's repeated phrasing. Variants + dials + a dynamic
 * banned-openings list (built from recent replies) keep the voice alive.
 */

export const STYLE_VARIANTS = [
  'secco',
  'velenoso',
  'autolesionista',
  'surreale',
  'porn_brained',
  'meme_lord',
  'finto_filosofo_degenerato',
  'bar_sport',
  'market_degen',
  'lorekeeper',
] as const;

export type StyleVariant = (typeof STYLE_VARIANTS)[number];

const VARIANT_DESC: Record<StyleVariant, string> = {
  secco: 'tagliente e brevissimo, poche parole che fanno male',
  velenoso: 'sarcastico e velenoso, stoccate intelligenti',
  autolesionista: 'auto-ironico, si prende in giro da solo prima degli altri',
  surreale: 'assurdo, immagini mentali deliranti',
  porn_brained: 'cervello in modalità degenere, doppi sensi e horny jokes (se NSFW)',
  meme_lord: 'parla per meme, formati copypasta, brainrot da chat',
  finto_filosofo_degenerato: 'pseudo-profondo ma in realtà degenerato',
  bar_sport: 'da bar dello sport, opinioni fortissime su tutto',
  market_degen: 'degen crypto, copium e hopium, mai consigli finanziari seri',
  lorekeeper: 'richiama lore e inside joke del gruppo con naturalezza',
};

export interface StyleInput {
  modeName: string;
  modeDescription: string;
  scene: SceneAnalysis;
  recentBotReplies: BotReplyRecord[];
  nsfwEnabled: boolean;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export class StyleEngine {
  sample(input: StyleInput): StyleProfile {
    const pool: StyleVariant[] = [...STYLE_VARIANTS];
    // bias by scene
    const biased: StyleVariant[] = [];
    if (input.scene.botIsBeingCriticized) biased.push('autolesionista', 'velenoso');
    if (input.scene.energy === 'chaotic' || input.scene.energy === 'high')
      biased.push('surreale', 'meme_lord');
    if (input.scene.userIntent === 'insult_bot') biased.push('velenoso', 'secco');
    if (input.scene.humorStyle.includes('degen')) biased.push('market_degen', 'bar_sport');
    if (input.scene.humorStyle.includes('lore_callback')) biased.push('lorekeeper');
    if (input.nsfwEnabled && Math.random() < 0.4) biased.push('porn_brained');

    // avoid the exact variant used in the last reply
    const lastVariant = input.recentBotReplies[0]?.styleVariant;
    const candidates = (biased.length ? biased : pool).filter((v) => v !== lastVariant);
    const primary = pick(candidates.length ? candidates : pool);
    const secondary = Math.random() < 0.5 ? pick(pool.filter((v) => v !== primary)) : undefined;
    const variants = secondary ? [primary, secondary] : [primary];

    const nsfw = input.nsfwEnabled ? 0.4 + Math.random() * 0.5 : 0.05;
    return {
      aggression: input.scene.userIntent === 'insult_bot' ? 0.7 : 0.3 + Math.random() * 0.4,
      vulgarity: input.nsfwEnabled ? 0.5 + Math.random() * 0.4 : 0.3 + Math.random() * 0.3,
      nsfw,
      absurdity: input.scene.energy === 'chaotic' ? 0.7 : 0.2 + Math.random() * 0.4,
      dialect: 0.2 + Math.random() * 0.3,
      brevity: input.scene.botIsBeingAddressed ? 0.5 : 0.7,
      directness: 0.5 + Math.random() * 0.4,
      chaos: input.scene.energy === 'chaotic' ? 0.8 : 0.3 + Math.random() * 0.3,
      selfAwareness: input.scene.botIsBeingCriticized ? 0.8 : 0.3,
      degen: input.scene.humorStyle.includes('degen') ? 0.7 : 0.3,
      variants,
    };
  }

  describe(style: StyleProfile): string {
    const variantLines = style.variants
      .map((v) => `${v}: ${VARIANT_DESC[v as StyleVariant] ?? v}`)
      .join('; ');
    const dial = (n: number) => (n >= 0.66 ? 'alto' : n >= 0.33 ? 'medio' : 'basso');
    return [
      `Variante/i: ${variantLines}`,
      `aggressività ${dial(style.aggression)}, volgarità ${dial(style.vulgarity)}, nsfw ${dial(style.nsfw)}, ` +
        `assurdità ${dial(style.absurdity)}, brevità ${dial(style.brevity)}, caos ${dial(style.chaos)}, ` +
        `auto-ironia ${dial(style.selfAwareness)}`,
    ].join('\n');
  }

  /** Build a dynamic banned-openings list from recent bot replies (first 4 words of each). */
  bannedOpenings(recent: BotReplyRecord[]): string[] {
    const set = new Set<string>();
    for (const r of recent.slice(0, 6)) {
      const opening = r.text.trim().split(/\s+/).slice(0, 4).join(' ');
      if (opening.length >= 3) set.add(opening);
    }
    return [...set];
  }
}
