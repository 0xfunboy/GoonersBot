import type { RetrievedMemory } from '../memory/types.js';
import type {
  ReplyPlan,
  SceneAnalysis,
  ReplyIntent,
  MemoryUseMode,
  TurnEvaluation,
} from './types.js';

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
    let replyIntent: ReplyIntent;
    switch (e.action) {
      case 'answer':
      case 'challenge_claim':
      case 'ground_search':
      case 'bring_news_context':
      case 'download_music':
      case 'download_media':
      case 'generate_image':
      case 'draw_image':
      case 'translate_text':
      case 'make_voice':
      case 'post_news':
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

    const usable = input.retrievedMemories.filter((m) => m.relevance > 0.2);
    let memoryUseMode: MemoryUseMode = 'none';
    const valueFirst =
      e.action === 'answer' ||
      e.action === 'challenge_claim' ||
      e.action === 'ground_search' ||
      e.action === 'bring_news_context' ||
      e.action === 'download_music' ||
      e.action === 'download_media' ||
      e.action === 'generate_image' ||
      e.action === 'draw_image' ||
      e.action === 'translate_text' ||
      e.action === 'make_voice' ||
      e.action === 'post_news';
    if (!s.botIsBeingCriticized && usable.length > 0 && e.providerRequests.includes('group_rag')) {
      const hasExplicit = usable.some((m) => m.allowedToUseExplicitly);
      memoryUseMode =
        !valueFirst &&
        hasExplicit &&
        (replyIntent === 'lore_callback' || s.humorStyle.includes('lore_callback'))
          ? 'explicit_callback'
          : 'implicit_style';
    }
    const memoryIdsToUse = usable.map((m) => m.item._id).filter((id): id is string => Boolean(id));

    const addressed = s.botIsBeingAddressed;
    const maxLines = s.botIsBeingCriticized
      ? Math.min(2, input.maxLines)
      : addressed
        ? input.maxLines
        : Math.min(2, input.maxLines);

    const bannedPhrases = [...new Set([...HARD_BANNED, ...input.bannedOpenings])];
    const forbiddenReferences: string[] = [];
    if (s.botIsBeingCriticized)
      forbiddenReferences.push('repeated callbacks', 'terms of use', 'the same old jokes');
    if (valueFirst) {
      forbiddenReferences.push('roast-only answer', 'stale personal callback as the main point');
    }

    return {
      replyIntent,
      action: e.action,
      valueTarget: e.valueTarget,
      roastBudget: e.roastBudget,
      socialRole: e.socialRole,
      mustBringValue: valueFirst || e.valueTarget === 'truth' || e.valueTarget === 'technical_help',
      targetHandles: s.mentionedUsers.length ? s.mentionedUsers : [input.currentHandle],
      tone: s.bestAngle || (s.botIsBeingCriticized ? 'self-ironic and venomous' : 'group-native'),
      maxLines,
      maxChars: input.maxChars,
      memoryIdsToUse: memoryUseMode === 'none' ? [] : memoryIdsToUse,
      memoryUseMode,
      forbiddenReferences,
      bannedPhrases,
      noveltyInstruction: s.botIsBeingCriticized
        ? 'Completely change the structure and opening compared to recent replies. Admit the loop with self-irony, then answer differently.'
        : 'Avoid openings and jokes already used recently.',
      mustAnswer: addressed || s.userIntent === 'dangerous_request' || s.userIntent === 'ask_bot',
    };
  }
}
