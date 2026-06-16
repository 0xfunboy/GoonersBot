import type { RetrievedMemory } from '../memory/types.js';
import type { ReplyPlan, SceneAnalysis, ReplyIntent, MemoryUseMode } from './types.js';

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
  retrievedMemories: RetrievedMemory[];
  bannedOpenings: string[];
  currentHandle: string;
  maxLines: number;
  maxChars: number;
}

/**
 * ReplyPlanner: decides what the reply should DO before any text is generated. Heuristic and
 * deterministic (no extra LLM call) — derived from the scene + retrieved memory. The plan
 * constrains the generator (intent, tone, length, memory usage, banned phrases, novelty).
 */
export class ReplyPlanner {
  plan(input: PlannerInput): ReplyPlan {
    const s = input.scene;
    let replyIntent: ReplyIntent;
    switch (s.userIntent) {
      case 'dangerous_request':
        replyIntent = 'answer_question';
        break;
      case 'ask_bot':
        replyIntent = 'answer_question';
        break;
      case 'request_summary':
        replyIntent = 'summarize';
        break;
      case 'request_memory':
        replyIntent = 'lore_callback';
        break;
      case 'insult_bot':
        replyIntent = s.botIsBeingCriticized ? 'roast_self' : 'roast_user';
        break;
      case 'continue_banter':
        replyIntent = s.energy === 'chaotic' ? 'chaos_reply' : 'roast_user';
        break;
      default:
        replyIntent = s.energy === 'chaotic' ? 'chaos_reply' : 'ignore_memory_and_answer_directly';
    }
    if (s.botIsBeingCriticized) replyIntent = 'roast_self';

    const usable = input.retrievedMemories.filter((m) => m.relevance > 0.2);
    let memoryUseMode: MemoryUseMode = 'none';
    if (!s.botIsBeingCriticized && usable.length > 0) {
      const hasExplicit = usable.some((m) => m.allowedToUseExplicitly);
      memoryUseMode =
        hasExplicit && (replyIntent === 'lore_callback' || s.humorStyle.includes('lore_callback'))
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

    return {
      replyIntent,
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
