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
  /** Recent human-authored message lengths; used to match the room instead of writing mini essays. */
  recentHumanMessageLengths?: number[];
  /** Passive autoengage contributions must be especially small and socially licensed. */
  passive?: boolean;
  /** A direct textual/reaction correction should temporarily suppress performative banter. */
  recentNegativeFeedback?: boolean;
  /** Semantic joke domains already saturated in recent replies (server metaphors, fake reports, etc.). */
  fatiguedConcepts?: string[];
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
    const explicitBanter =
      socialSignal?.situation === 'banter' ||
      (s.userIntent === 'insult_bot' && socialSignal?.situation !== 'conflict');
    let plannedAction = e.action;
    if (gratitudeTurn) {
      plannedAction = 'acknowledge';
    } else if (
      helpTurn &&
      (plannedAction === 'banter_only' ||
        plannedAction === 'use_group_lore' ||
        plannedAction === 'stay_quiet')
    ) {
      plannedAction = 'answer';
    } else if (plannedAction === 'banter_only' && !explicitBanter) {
      // Casual conversation is not permission to perform. If Cortex over-routes a normal social
      // turn into banter, degrade it to the smallest useful human reaction instead of a roast.
      plannedAction = 'react_short';
    } else if (
      plannedAction === 'answer' &&
      e.valueTarget === 'social_glue' &&
      (socialSignal?.situation === 'casual' || socialSignal?.situation === 'celebration')
    ) {
      plannedAction = 'react_short';
    }
    if (input.recentNegativeFeedback && plannedAction === 'banter_only') {
      plannedAction = 'react_short';
    }
    let replyIntent: ReplyIntent;
    switch (plannedAction) {
      case 'answer':
        replyIntent = 'answer_question';
        break;
      case 'acknowledge':
        replyIntent = 'acknowledge';
        break;
      case 'react_short':
        replyIntent = 'react_short';
        break;
      case 'disagree_briefly':
        replyIntent = 'disagree_briefly';
        break;
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
    if (s.botIsBeingCriticized) {
      replyIntent = explicitBanter ? 'roast_self' : 'acknowledge';
    }
    if (gratitudeTurn) {
      replyIntent = 'acknowledge_gratitude';
    } else if (helpTurn) {
      replyIntent = 'answer_question';
    }

    const usable = input.retrievedMemories.filter((m) => m.relevance > 0.2);
    let memoryUseMode: MemoryUseMode = 'none';
    const valueFirst =
      plannedAction === 'answer' ||
      plannedAction === 'challenge_claim' ||
      plannedAction === 'ground_search' ||
      plannedAction === 'bring_news_context' ||
      plannedAction === 'download_music' ||
      plannedAction === 'download_media' ||
      plannedAction === 'archive_anime' ||
      plannedAction === 'generate_image' ||
      plannedAction === 'draw_image' ||
      plannedAction === 'generate_video' ||
      plannedAction === 'translate_text' ||
      plannedAction === 'make_voice' ||
      plannedAction === 'post_news' ||
      plannedAction === 'acquire_capability' ||
      plannedAction === 'summarize_thread';
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
    const humanMedian = median(input.recentHumanMessageLengths ?? []);
    const roomPulse = humanMedian > 0 ? humanMedian : 60;
    const shortSocial =
      plannedAction === 'acknowledge' ||
      plannedAction === 'react_short' ||
      plannedAction === 'disagree_briefly';
    const factualHelp =
      e.valueTarget === 'truth' ||
      socialSignal?.situation === 'factual_help' ||
      plannedAction === 'challenge_claim' ||
      plannedAction === 'ground_search' ||
      plannedAction === 'bring_news_context';
    const complexHelp =
      plannedAction === 'summarize_thread' || e.valueTarget === 'technical_help' || seriousSupport;
    let maxLines: number;
    let maxChars: number;
    if (plannedAction === 'summarize_thread') {
      maxLines = Math.max(input.maxLines, 18);
      maxChars = Math.max(input.maxChars, 3_500);
    } else if (shortSocial) {
      // Once the planner has intentionally chosen a social micro-action, stale upstream labels such
      // as valueTarget=truth must not inflate it back into an essay.
      maxLines = 1;
      const multiplier = plannedAction === 'disagree_briefly' ? 3.2 : 2.2;
      const ceiling = plannedAction === 'disagree_briefly' ? 220 : 150;
      maxChars = Math.min(ceiling, Math.max(45, Math.round(roomPulse * multiplier)));
    } else if (complexHelp) {
      maxLines = Math.max(input.maxLines, seriousSupport ? 5 : 8);
      maxChars = Math.max(input.maxChars, seriousSupport ? 900 : 1_400);
    } else if (factualHelp) {
      maxLines = Math.min(6, Math.max(2, input.maxLines));
      maxChars = Math.min(900, Math.max(input.maxChars, 520));
    } else if (plannedAction === 'banter_only') {
      maxLines = Math.min(2, input.maxLines);
      maxChars = Math.min(260, Math.max(90, Math.round(roomPulse * 3.5)));
    } else if (input.passive) {
      maxLines = 1;
      maxChars = Math.min(160, Math.max(55, Math.round(roomPulse * 2.4)));
    } else if (s.botIsBeingCriticized) {
      maxLines = 1;
      maxChars = Math.min(180, Math.max(70, Math.round(roomPulse * 2.6)));
    } else {
      maxLines = addressed ? Math.min(3, input.maxLines) : 1;
      maxChars = Math.min(input.maxChars, Math.max(140, Math.min(320, Math.round(roomPulse * 4))));
    }

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
    if (!factualHelp && !complexHelp) {
      forbiddenReferences.push(...(input.fatiguedConcepts ?? []));
    }

    const turnBudget = socialSignal
      ? capRoast(e.roastBudget, socialSignal.roastCeiling)
      : e.roastBudget;
    const socialBudget =
      shortSocial || input.recentNegativeFeedback ? capRoast(turnBudget, 'none') : turnBudget;
    // Two independent ceilings: what this moment allows, and what this person has earned.
    const roastBudget = input.standingRoastCeiling
      ? capRoast(socialBudget, input.standingRoastCeiling)
      : socialBudget;
    const noveltyInstruction = seriousSupport
      ? 'Acknowledge the specific feeling without therapy-speak, then give one concrete immediate step. Be steady, loyal and direct; no roast.'
      : gratitudeTurn
        ? 'Accept the thanks in one natural, warm line. No joke mechanism, no callback, no insult and no topic change.'
        : shortSocial
          ? 'ONE HUMAN CHAT LINE. No setup/punchline structure, no analogy, no fake report, no mini-monologue and no need to prove personality.'
          : s.botIsBeingCriticized && !explicitBanter
            ? 'Take the correction seriously. Admit the specific miss or disagree plainly in one short line; no self-roast routine and no meta-comedy.'
            : s.botIsBeingCriticized
              ? 'Keep the comeback compact and structurally different from recent replies. One hit is enough.'
              : memoryUseMode === 'explicit_callback'
                ? 'If the callback earns its place, transform it into a new angle. Never recite the old lore or make it the whole reply.'
                : roastBudget === 'none'
                  ? 'Respond like a normal friend, not a performer. Plain agreement, disagreement, reaction or useful content is enough. Do not manufacture a joke.'
                  : 'Use at most one fresh comic mechanism and one premise. Avoid openings, closings and joke subjects already used.';

    const plannedValueTarget =
      plannedAction === 'acknowledge' || plannedAction === 'react_short'
        ? 'social_glue'
        : plannedAction === 'disagree_briefly'
          ? 'context'
          : gratitudeTurn
            ? 'social_glue'
            : helpTurn
              ? 'support'
              : e.valueTarget;
    return {
      replyIntent,
      action: plannedAction,
      valueTarget: plannedValueTarget,
      roastBudget,
      socialRole: shortSocial || helpTurn ? 'friend' : e.socialRole,
      mustBringValue:
        !shortSocial &&
        ((helpTurn && !gratitudeTurn) ||
          valueFirst ||
          e.valueTarget === 'truth' ||
          e.valueTarget === 'technical_help'),
      targetHandles: s.mentionedUsers.length ? s.mentionedUsers : [input.currentHandle],
      tone: gratitudeTurn
        ? 'brief, warm and natural; accept the thanks like a real friend, with no invoice and no roast'
        : shortSocial
          ? 'ordinary human chat; concise, sincere, no performance and no forced cleverness'
          : seriousSupport
            ? 'blunt, calm, protective friend who stays present and gives practical help'
            : s.bestAngle ||
              (s.botIsBeingCriticized ? 'plain, accountable and non-defensive' : 'group-native'),
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
      comedyStrategy:
        seriousSupport || gratitudeTurn || shortSocial || roastBudget === 'none'
          ? 'none'
          : input.comedyStrategy,
    };
  }
}

function median(values: number[]): number {
  const usable = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (usable.length === 0) return 0;
  const middle = Math.floor(usable.length / 2);
  if (usable.length % 2 === 1) return usable[middle] ?? 0;
  return Math.round(((usable[middle - 1] ?? 0) + (usable[middle] ?? 0)) / 2);
}
