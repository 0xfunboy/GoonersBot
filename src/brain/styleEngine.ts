import type { SceneAnalysis, StyleProfile } from './types.js';
import type { BotReplyRecord } from './types.js';

/**
 * StyleEngine: varies the bot's voice every turn so it never sounds like the same NPC.
 * Repetition isn't only repeated facts - it's repeated phrasing. Variants + dials + a dynamic
 * banned-openings list (built from recent replies) keep the voice alive.
 */

export const STYLE_VARIANTS = [
  'dry',
  'venomous',
  'self_deprecating',
  'surreal',
  'porn_brained',
  'meme_lord',
  'fake_degen_philosopher',
  'bar_talk',
  'market_degen',
  'lorekeeper',
] as const;

export type StyleVariant = (typeof STYLE_VARIANTS)[number];

const VARIANT_DESC: Record<StyleVariant, string> = {
  dry: 'sharp and very short, a few words that hurt',
  venomous: 'sarcastic and venomous, clever jabs',
  self_deprecating: 'self-ironic, roasts itself before the others can',
  surreal: 'absurd, deranged mental images',
  porn_brained: 'degenerate mode, double entendres and horny jokes (if NSFW)',
  meme_lord: 'talks in memes, copypasta formats, chat brainrot',
  fake_degen_philosopher: 'pseudo-deep but actually degenerate',
  bar_talk: 'sports-bar energy, extremely strong opinions on everything',
  market_degen: 'crypto degen, copium and hopium, never serious financial advice',
  lorekeeper: 'naturally calls back group lore and inside jokes',
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
    if (input.scene.botIsBeingCriticized) biased.push('self_deprecating', 'venomous');
    if (input.scene.energy === 'chaotic' || input.scene.energy === 'high')
      biased.push('surreal', 'meme_lord');
    if (input.scene.userIntent === 'insult_bot') biased.push('venomous', 'dry');
    if (input.scene.humorStyle.includes('degen')) biased.push('market_degen', 'bar_talk');
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
    const dial = (n: number) => (n >= 0.66 ? 'high' : n >= 0.33 ? 'mid' : 'low');
    return [
      `Variant(s): ${variantLines}`,
      `aggression ${dial(style.aggression)}, vulgarity ${dial(style.vulgarity)}, nsfw ${dial(style.nsfw)}, ` +
        `absurdity ${dial(style.absurdity)}, brevity ${dial(style.brevity)}, chaos ${dial(style.chaos)}, ` +
        `self-irony ${dial(style.selfAwareness)}`,
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

  /**
   * Detect recurring tics: 3-5 word sequences that appear in 2+ recent replies (e.g. a catchphrase
   * sign-off like "porco che sei"), plus the closing of the latest reply so two answers in a row
   * don't end the same way. These are fed to the generator as phrases to avoid.
   */
  recurringTics(recent: BotReplyRecord[]): string[] {
    const norm = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^\p{L}\s']/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const texts = recent
      .slice(0, 8)
      .map((r) => norm(r.text))
      .filter(Boolean);
    const counts = new Map<string, number>();
    for (const t of texts) {
      const w = t.split(' ');
      for (let n = 3; n <= 5; n += 1) {
        for (let i = 0; i + n <= w.length; i += 1) {
          const gram = w.slice(i, i + n).join(' ');
          counts.set(gram, (counts.get(gram) ?? 0) + 1);
        }
      }
    }
    const tics = [...counts.entries()].filter(([, c]) => c >= 2).map(([g]) => g);
    const lastClosing = texts[0]?.split(' ').slice(-4).join(' ');
    if (lastClosing && lastClosing.length >= 6) tics.push(lastClosing);
    return [...new Set(tics)].slice(0, 12);
  }
}
