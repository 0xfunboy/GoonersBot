import type { RetrievedMemory } from '../memory/types.js';
import type {
  ComedyStrategy,
  ReplyPlan,
  SceneAnalysis,
  ReplyIntent,
  MemoryUseMode,
  TurnEvaluation,
  RoastBudget,
} from './types.js';
import { capRoast, isSeriousSupport } from './socialAwareness.js';

const HARD_BANNED = [
  'Ah fra',
  "Ah, fra'",
  'Comunque fra',
  "Comunque, fra'",
  'Tutto chiaro',
  'non hai letto i termini',
];

export interface PlannerInput {
  scene: SceneAnalysis;
  evaluation: TurnEvaluation;
  retrievedMemories: RetrievedMemory[];
  bannedOpenings: string[];
  currentHandle: string;
  maxLines: number;
  maxChars: number;
  /** StyleEngine may preselect this and pass it through for persistence/guarding. */
  comedyStrategy?: ComedyStrategy;
  /**
   * Ceiling earned by how this person has treated the bot over time.
   *
   * Applied on top of the turn's own social ceiling, so a friend is teased rather than savaged
   * even in a scene that would otherwise licence a heavy roast.
   */
  standingRoastCeiling?: RoastBudget;
}

/**
 * ReplyPlanner: decides what the reply should DO before any text is generated. Heuristic and
 * deterministic (no extra LLM call) - derived from the scene + retrieved memory. The plan
 * constrains the generator (intent, tone, length, memory usage, banned phrases, novelty).
 */
export class ReplyPlanner {
  plan(input: PlannerInput): ReplyPlan {
    const s = input.scene;
    const e = input.evaluation;
    const socialSignal = e.socialSignal ?? s.socialSignal;
    const seriousSupport = isSeriousSupport(socialSignal);
    const gratitudeTurn = socialSignal?.situation === 'gratitude';
    const helpTurn =
      seriousSupport || socialSignal?.situation === 'practical_help' || gratitudeTurn;
    const plannedAction =
      helpTurn &&
      (e.action === 'banter_only' || e.action === 'use_group_lore' || e.action === 'stay_quiet')
        ? 'answer'
        : e.action;
    let replyIntent: ReplyIntent;
    switch (e.action) {
      case 'answer':
      case 'challenge_claim':
      case 'ground_search':
      case 'bring_news_context':
      case 'download_music':
      case 'download_media':
      case 'archive_anime':
      case 'generate_image':
      case 'draw_image':
      case 'generate_video':
      case 'translate_text':
      case 'make_voice':
      case 'post_news':
      case 'acquire_capability':
        replyIntent = 'answer_question';
        break;
      case 'summarize_thread':
        replyIntent = 'summarize';
        break;
      case 'use_group_lore':
        replyIntent = 'lore_callback';
        break;
      case 'banter_only':
        replyIntent = s.energy === 'chaotic' ? 'chaos_reply' : 'roast_user';
        break;
      case 'stay_quiet':
        replyIntent = 'ignore_memory_and_answer_directly';
        break;
    }
    if (s.botIsBeingCriticized) replyIntent = 'roast_self';
    if (gratitudeTurn) {
      replyIntent = 'acknowledge_gratitude';
    } else if (helpTurn) {
      replyIntent = 'answer_question';
    }

    const usable = input.retrievedMemories.filter((m) => m.relevance > 0.2);
    let memoryUseMode: MemoryUseMode = 'none';
    const valueFirst =
      e.action === 'answer' ||
      e.action === 'challenge_claim' ||
      e.action === 'ground_search' ||
      e.action === 'bring_news_context' ||
      e.action === 'download_music' ||
      e.action === 'download_media' ||
      e.action === 'archive_anime' ||
      e.action === 'generate_image' ||
      e.action === 'draw_image' ||
      e.action === 'generate_video' ||
      e.action === 'translate_text' ||
      e.action === 'make_voice' ||
      e.action === 'post_news' ||
      e.action === 'acquire_capability' ||
      e.action === 'summarize_thread';
    if (
      !s.botIsBeingCriticized &&
      socialSignal?.memoryPolicy !== 'avoid_callbacks' &&
      usable.length > 0
    ) {
      const hasExplicit = usable.some((m) => m.allowedToUseExplicitly);
      memoryUseMode =
        !valueFirst &&
        hasExplicit &&
        socialSignal?.memoryPolicy === 'eligible' &&
        (replyIntent === 'lore_callback' || s.humorStyle.includes('lore_callback'))
          ? 'explicit_callback'
          : 'implicit_style';
      if (socialSignal?.memoryPolicy === 'implicit_only') memoryUseMode = 'implicit_style';
    }
    const memoryIdsToUse = usable.map((m) => m.item._id).filter((id): id is string => Boolean(id));

    const addressed = s.botIsBeingAddressed;
    const substantiveHelp =
      e.valueTarget === 'truth' ||
      e.valueTarget === 'technical_help' ||
      socialSignal?.situation === 'factual_help' ||
      socialSignal?.situation === 'practical_help';
    const longForm = e.action === 'summarize_thread' || substantiveHelp || seriousSupport;
    const maxLines = longForm
      ? Math.max(input.maxLines, e.action === 'summarize_thread' ? 18 : seriousSupport ? 5 : 10)
      : s.botIsBeingCriticized
        ? Math.min(2, input.maxLines)
        : addressed
          ? input.maxLines
          : Math.min(2, input.maxLines);
    const maxChars = longForm
      ? Math.max(input.maxChars, e.action === 'summarize_thread' ? 3_500 : 2_000)
      : input.maxChars;

    const bannedPhrases = [...new Set([...HARD_BANNED, ...input.bannedOpenings])];
    const forbiddenReferences: string[] = [];
    if (s.botIsBeingCriticized)
      forbiddenReferences.push('repeated callbacks', 'terms of use', 'the same old jokes');
    if (valueFirst) {
      forbiddenReferences.push('roast-only answer', 'stale personal callback as the main point');
    }
    if (seriousSupport) {
      forbiddenReferences.push(
        "the person's vulnerability as a punchline",
        'sexual jokes',
        'lore callbacks',
        'performative motivational speech',
      );
    }
    if (gratitudeTurn) {
      forbiddenReferences.push(
        'a new insult',
        'a backhanded compliment',
        'personal lore',
        'a fresh roast after the thanks',
      );
    }

    const turnBudget = socialSignal
      ? capRoast(e.roastBudget, socialSignal.roastCeiling)
      : e.roastBudget;
    // Two independent ceilings: what this moment allows, and what this person has earned.
    const roastBudget = input.standingRoastCeiling
      ? capRoast(turnBudget, input.standingRoastCeiling)
      : turnBudget;
    const noveltyInstruction = seriousSupport
      ? 'Acknowledge the specific feeling without therapy-speak, then give one concrete immediate step. Be steady, loyal and direct; no roast.'
      : gratitudeTurn
        ? 'Accept the thanks in one natural, warm line. No joke mechanism, no callback, no insult and no topic change.'
        : s.botIsBeingCriticized
          ? 'Completely change the structure and opening compared to recent replies. Admit the loop with self-irony, then answer differently.'
          : memoryUseMode === 'explicit_callback'
            ? 'If the callback earns its place, transform it into a new angle. Never recite the old lore or make it the whole reply.'
            : 'Use a different comic mechanism and premise from recent replies. Avoid openings, closings and joke subjects already used.';

    return {
      replyIntent,
      action: plannedAction,
      valueTarget: gratitudeTurn ? 'social_glue' : helpTurn ? 'support' : e.valueTarget,
      roastBudget,
      socialRole: helpTurn ? 'friend' : e.socialRole,
      mustBringValue:
        (helpTurn && !gratitudeTurn) ||
        valueFirst ||
        e.valueTarget === 'truth' ||
        e.valueTarget === 'technical_help',
      targetHandles: s.mentionedUsers.length ? s.mentionedUsers : [input.currentHandle],
      tone: gratitudeTurn
        ? 'brief, warm and natural; accept the thanks like a real friend, with no invoice and no roast'
        : seriousSupport
          ? 'blunt, calm, protective friend who stays present and gives practical help'
          : s.bestAngle || (s.botIsBeingCriticized ? 'self-ironic and venomous' : 'group-native'),
      maxLines,
      maxChars,
      memoryIdsToUse: memoryUseMode === 'none' ? [] : memoryIdsToUse,
      memoryUseMode,
      forbiddenReferences,
      bannedPhrases,
      noveltyInstruction,
      mustAnswer:
        seriousSupport ||
        addressed ||
        s.userIntent === 'dangerous_request' ||
        s.userIntent === 'ask_bot',
      ...(socialSignal ? { socialSignal } : {}),
      comedyStrategy: seriousSupport || gratitudeTurn ? 'none' : input.comedyStrategy,
    };
  }
}
