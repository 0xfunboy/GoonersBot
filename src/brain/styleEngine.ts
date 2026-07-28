import type { ComedyStrategy, SceneAnalysis, SocialSignal, StyleProfile } from './types.js';
import type { BotReplyRecord } from './types.js';
import { isSeriousSupport } from './socialAwareness.js';

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
  'older_brother',
  'curious_nerd',
  'deadpan_caring',
  'confessional',
] as const;

export type StyleVariant = (typeof STYLE_VARIANTS)[number];

export const COMEDY_STRATEGIES: readonly ComedyStrategy[] = [
  'surgical_observation',
  'absurd_analogy',
  'mock_authority',
  'status_reversal',
  'literal_misread',
  'escalating_specificity',
  'understatement',
  'self_own',
  'callback_remix',
  'shared_enemy',
  'warm_deadpan',
] as const;

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
  older_brother: 'protective older-brother energy: blunt, practical, quietly loyal',
  curious_nerd: 'genuinely curious technical peer who notices the interesting detail',
  deadpan_caring: 'cares without becoming sentimental or corporate; dry but present',
  confessional: 'briefly personal and self-aware, like a real friend admitting a reaction',
};

const STRATEGY_DESC: Record<ComedyStrategy, string> = {
  none: 'no joke mechanic; be human, direct and useful',
  surgical_observation: 'notice one specific detail and make that the blade; no generic insult',
  absurd_analogy: 'compare the situation to one fresh, concrete and unexpected image',
  mock_authority: 'briefly frame the verdict like a fake expert, institution or field report',
  status_reversal: 'flip who appears competent, powerful or normal in the situation',
  literal_misread: 'take one phrase literally for a compact comic turn, then return to the point',
  escalating_specificity: 'escalate through increasingly specific details, ending before it drags',
  understatement: 'describe the obvious disaster with dry, disproportionate restraint',
  self_own: 'include the bot in the embarrassment instead of always punching outward',
  callback_remix: 'transform a genuinely relevant callback into a new angle; never recite old lore',
  shared_enemy: 'side with the person and aim the hostility at the problem, system or situation',
  warm_deadpan: 'show loyalty through a dry line, without sentimental assistant language',
};

export interface StyleInput {
  modeName: string;
  modeDescription: string;
  scene: SceneAnalysis;
  recentBotReplies: BotReplyRecord[];
  nsfwEnabled: boolean;
  socialSignal?: SocialSignal;
  valueTarget?: 'truth' | 'context' | 'joke' | 'support' | 'technical_help' | 'social_glue';
  socialRole?:
    | 'friend'
    | 'truth_checker'
    | 'banter'
    | 'lorekeeper'
    | 'quiet_listener'
    | 'technical_peer';
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export class StyleEngine {
  sample(input: StyleInput): StyleProfile {
    const pool: StyleVariant[] = [...STYLE_VARIANTS];
    const social = input.socialSignal ?? input.scene.socialSignal;
    const seriousSupport = isSeriousSupport(social);
    const gratitudeTurn = social?.situation === 'gratitude';
    const humorAllowed = social?.humorAllowed ?? true;
    // bias by scene
    const biased: StyleVariant[] = [];
    if (input.scene.botIsBeingCriticized) biased.push('self_deprecating', 'venomous');
    if (input.scene.energy === 'chaotic' || input.scene.energy === 'high')
      biased.push('surreal', 'meme_lord');
    if (input.scene.userIntent === 'insult_bot') biased.push('venomous', 'dry');
    if (input.scene.humorStyle.includes('degen')) biased.push('market_degen', 'bar_talk');
    if (input.scene.humorStyle.includes('lore_callback')) biased.push('lorekeeper');
    if (input.nsfwEnabled && humorAllowed && !seriousSupport && Math.random() < 0.4)
      biased.push('porn_brained');
    if (input.valueTarget === 'technical_help' || input.socialRole === 'technical_peer') {
      biased.push('curious_nerd', 'dry', 'older_brother');
    }
    if (input.valueTarget === 'support' || seriousSupport || gratitudeTurn) {
      biased.push('deadpan_caring', 'older_brother', 'confessional');
    }

    const compatiblePool: StyleVariant[] =
      seriousSupport || gratitudeTurn
        ? ['deadpan_caring', 'older_brother', 'confessional', 'curious_nerd']
        : input.valueTarget === 'technical_help'
          ? ['curious_nerd', 'dry', 'older_brother', 'deadpan_caring']
          : input.valueTarget === 'support'
            ? ['deadpan_caring', 'older_brother', 'confessional', 'dry', 'bar_talk']
            : pool;

    // Cool down several recent voices, not just the previous one. Composite variants are persisted
    // as "a+b", so split them before filtering.
    const recentVariants = new Set(
      input.recentBotReplies
        .slice(0, 4)
        .flatMap((r) => (r.styleVariant ?? '').split('+'))
        .filter(Boolean),
    );
    const dislikedVariants = new Set(
      input.recentBotReplies
        .filter((reply) => (reply.feedbackScore ?? 0) < 0)
        .flatMap((reply) => (reply.styleVariant ?? '').split('+'))
        .filter(Boolean),
    );
    const likedVariants = input.recentBotReplies
      .filter((reply) => (reply.feedbackScore ?? 0) > 0)
      .flatMap((reply) => (reply.styleVariant ?? '').split('+'))
      .filter(
        (variant): variant is StyleVariant =>
          STYLE_VARIANTS.includes(variant as StyleVariant) &&
          compatiblePool.includes(variant as StyleVariant) &&
          !recentVariants.has(variant) &&
          !dislikedVariants.has(variant),
      );
    const feedbackCompatible = compatiblePool.filter((variant) => !dislikedVariants.has(variant));
    const effectivePool = feedbackCompatible.length ? feedbackCompatible : compatiblePool;
    const preferred = [...likedVariants, ...(biased.length ? biased : effectivePool)].filter(
      (v) => compatiblePool.includes(v) && !recentVariants.has(v),
    );
    const cooledPool = effectivePool.filter((v) => !recentVariants.has(v));
    const candidates = preferred.length
      ? preferred
      : cooledPool.length
        ? cooledPool
        : effectivePool;
    const primary = pick(candidates);
    const secondaryPool = compatiblePool.filter((v) => v !== primary && !recentVariants.has(v));
    const secondary =
      secondaryPool.length > 0 && Math.random() < (seriousSupport ? 0.2 : 0.45)
        ? pick(secondaryPool)
        : undefined;
    const variants = secondary ? [primary, secondary] : [primary];
    const comedyStrategies = this.selectComedyStrategies({ ...input, socialSignal: social });

    const nsfw =
      seriousSupport || !humorAllowed ? 0 : input.nsfwEnabled ? 0.4 + Math.random() * 0.5 : 0.05;
    const supportive =
      (input.valueTarget === 'support' || seriousSupport) &&
      input.scene.userIntent !== 'insult_bot';
    const factual =
      input.valueTarget === 'truth' ||
      input.valueTarget === 'technical_help' ||
      input.socialRole === 'truth_checker';
    return {
      aggression: seriousSupport
        ? 0
        : !humorAllowed
          ? 0
          : input.scene.userIntent === 'insult_bot'
            ? 0.7
            : supportive
              ? 0.05 + Math.random() * 0.15
              : factual
                ? 0.12 + Math.random() * 0.25
                : 0.3 + Math.random() * 0.4,
      vulgarity: seriousSupport
        ? 0.05 + Math.random() * 0.1
        : !humorAllowed
          ? 0.02
          : supportive
            ? 0.1 + Math.random() * 0.2
            : input.nsfwEnabled
              ? 0.5 + Math.random() * 0.4
              : 0.3 + Math.random() * 0.3,
      nsfw,
      absurdity: seriousSupport
        ? 0.05
        : !humorAllowed
          ? 0
          : input.scene.energy === 'chaotic'
            ? 0.7
            : 0.2 + Math.random() * 0.4,
      dialect: 0.2 + Math.random() * 0.3,
      brevity: input.scene.botIsBeingAddressed ? 0.5 : 0.7,
      directness: 0.5 + Math.random() * 0.4,
      chaos: seriousSupport
        ? 0.05
        : !humorAllowed
          ? 0
          : input.scene.energy === 'chaotic'
            ? 0.8
            : 0.3 + Math.random() * 0.3,
      selfAwareness: input.scene.botIsBeingCriticized ? 0.8 : 0.3,
      degen:
        seriousSupport || !humorAllowed ? 0 : input.scene.humorStyle.includes('degen') ? 0.7 : 0.3,
      variants,
      comedyStrategies,
      ...(social?.posture ? { supportPosture: social.posture } : {}),
      humorAllowed,
    };
  }

  describe(style: StyleProfile): string {
    const variantLines = style.variants
      .map((v) => `${v}: ${VARIANT_DESC[v as StyleVariant] ?? v}`)
      .join('; ');
    const dial = (n: number) => (n >= 0.66 ? 'high' : n >= 0.33 ? 'mid' : 'low');
    const strategyLines = (style.comedyStrategies ?? [])
      .map((s) => `${s}: ${STRATEGY_DESC[s]}`)
      .join('; ');
    return [
      `Variant(s): ${variantLines}`,
      strategyLines ? `Comedy mechanism(s): ${strategyLines}` : '',
      style.humorAllowed === false
        ? 'SOCIAL OVERRIDE: no roast and no comic performance. Be the blunt, reliable friend.'
        : '',
      style.supportPosture
        ? `Social posture: ${style.supportPosture}. The posture outranks personality flavor.`
        : '',
      `aggression ${dial(style.aggression)}, vulgarity ${dial(style.vulgarity)}, nsfw ${dial(style.nsfw)}, ` +
        `absurdity ${dial(style.absurdity)}, brevity ${dial(style.brevity)}, chaos ${dial(style.chaos)}, ` +
        `self-irony ${dial(style.selfAwareness)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Select the joke mechanism separately from voice. This is the key anti-NPC layer: "dry" can be
   * an observation today and an understatement tomorrow instead of always being the same wallet jab.
   */
  selectComedyStrategies(input: StyleInput): ComedyStrategy[] {
    const social = input.socialSignal ?? input.scene.socialSignal;
    if (social?.humorAllowed === false || isSeriousSupport(social)) return ['none'];

    let pool: ComedyStrategy[];
    if (input.valueTarget === 'support') {
      pool = ['shared_enemy', 'warm_deadpan', 'understatement'];
    } else if (
      input.valueTarget === 'truth' ||
      input.valueTarget === 'technical_help' ||
      input.socialRole === 'truth_checker'
    ) {
      pool = ['surgical_observation', 'understatement', 'absurd_analogy', 'warm_deadpan'];
    } else if (input.scene.botIsBeingCriticized) {
      pool = ['self_own', 'status_reversal', 'understatement'];
    } else {
      pool = [
        'surgical_observation',
        'absurd_analogy',
        'mock_authority',
        'status_reversal',
        'literal_misread',
        'escalating_specificity',
        'understatement',
        'self_own',
      ];
      if (input.scene.humorStyle.includes('lore_callback')) pool.push('callback_remix');
    }

    const disliked = new Set(
      input.recentBotReplies
        .filter((reply) => (reply.feedbackScore ?? 0) < 0)
        .map((reply) => reply.comedyStrategy ?? inferComedyStrategy(reply.text))
        .filter((strategy): strategy is ComedyStrategy => Boolean(strategy)),
    );
    const feedbackPool = pool.filter((strategy) => !disliked.has(strategy));
    if (feedbackPool.length > 0) pool = feedbackPool;
    const recent = new Set(
      input.recentBotReplies
        .slice(0, 5)
        .map((r) => r.comedyStrategy ?? inferComedyStrategy(r.text))
        .filter((s): s is ComedyStrategy => Boolean(s)),
    );
    const fresh = pool.filter((strategy) => !recent.has(strategy));
    const liked = input.recentBotReplies
      .filter((reply) => (reply.feedbackScore ?? 0) > 0)
      .map((reply) => reply.comedyStrategy ?? inferComedyStrategy(reply.text))
      .filter((strategy): strategy is ComedyStrategy =>
        Boolean(strategy && pool.includes(strategy) && !recent.has(strategy)),
      );
    const candidates = fresh.length
      ? [...liked, ...fresh]
      : pool.filter((s) => s !== input.recentBotReplies[0]?.comedyStrategy);
    const primary = pick(candidates.length ? candidates : pool);
    const secondaryPool = candidates.filter((s) => s !== primary);
    return secondaryPool.length > 0 && Math.random() < 0.18
      ? [primary, pick(secondaryPool)]
      : [primary];
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

/** Best-effort migration for replies recorded before `comedyStrategy` existed. */
export function inferComedyStrategy(text: string): ComedyStrategy | null {
  const norm = text.toLowerCase();
  if (
    /\b(secondo (uno studio|la scienza)|tecnicamente|manuale|certificat|commissione)\b/i.test(norm)
  )
    return 'mock_authority';
  if (/\b(sembra|pare|come un[oa]?|manco fosse|tipo un[oa]?)\b/i.test(norm))
    return 'absurd_analogy';
  if (/\b(letteralmente|preso alla lettera|hai detto)\b/i.test(norm)) return 'literal_misread';
  if (/\b(io|pure io|noi bot|anche a me|siamo in due)\b/i.test(norm)) return 'self_own';
  if (/\b(almeno|appena appena|leggermente|non proprio)\b/i.test(norm)) return 'understatement';
  if (/\b(il problema|questa roba|quel sistema|l'app|il mercato)\b/i.test(norm))
    return 'shared_enemy';
  return null;
}
