/**
 * Brain pipeline types: scene → plan → style → generate → rank → repetition guard → safety.
 * These power the shift from a deterministic reply bot to a context-aware group character.
 */

export type SceneEnergy = 'dead' | 'low' | 'medium' | 'high' | 'chaotic';

export type HumorStyle =
  | 'roast'
  | 'self_deprecation'
  | 'nsfw'
  | 'absurd'
  | 'dry'
  | 'degen'
  | 'lore_callback'
  | 'argument';

export type UserIntent =
  | 'ask_bot'
  | 'insult_bot'
  | 'continue_banter'
  | 'request_summary'
  | 'request_memory'
  | 'command_like'
  | 'random_chatter'
  | 'dangerous_request'
  | 'unknown';

export interface SceneAnalysis {
  currentTopic: string;
  energy: SceneEnergy;
  humorStyle: HumorStyle[];
  activeUsers: string[];
  mentionedUsers: string[];
  openThreads: string[];
  botIsBeingAddressed: boolean;
  botIsBeingCriticized: boolean;
  userIntent: UserIntent;
  shouldUseMemory: boolean;
  shouldBeDefensive: boolean;
  bestAngle: string;
  risk: 'low' | 'medium' | 'high';
}

export type ReplyIntent =
  | 'answer_question'
  | 'roast_user'
  | 'roast_self'
  | 'deflect_dangerous_request'
  | 'summarize'
  | 'hype'
  | 'lore_callback'
  | 'ignore_memory_and_answer_directly'
  | 'deadpan'
  | 'chaos_reply';

export type MemoryUseMode = 'none' | 'implicit_style' | 'explicit_callback';

export interface ReplyPlan {
  replyIntent: ReplyIntent;
  targetHandles: string[];
  tone: string;
  maxLines: number;
  maxChars: number;
  memoryIdsToUse: string[];
  memoryUseMode: MemoryUseMode;
  forbiddenReferences: string[];
  bannedPhrases: string[];
  noveltyInstruction: string;
  safetyInstruction: string;
  mustAnswer: boolean;
}

export interface StyleProfile {
  aggression: number;
  vulgarity: number;
  nsfw: number;
  absurdity: number;
  dialect: number;
  brevity: number;
  directness: number;
  chaos: number;
  selfAwareness: number;
  degen: number;
  /** chosen named variants (1–2) for this turn */
  variants: string[];
}

export interface RankedReply {
  index: number;
  score: number;
  reason: string;
  problems: string[];
}

export interface RepetitionCheck {
  allowed: boolean;
  reason?: string;
  similarityToRecentReplies: number;
  repeatedPhrases: string[];
  overusedMemoryIds: string[];
  sameOpening: boolean;
}

export interface SafetyGateResult {
  allowed: boolean;
  action: 'allow' | 'deflect' | 'block';
  reason: string;
  /** when deflecting/blocking, an in-character replacement line */
  replacement?: string;
}

/** A persisted bot reply (for repetition guard + feedback). */
export interface BotReplyRecord {
  _id?: string;
  chatId: number;
  messageId?: number;
  text: string;
  normalizedText: string;
  fingerprint: string;
  createdAt: Date;
  styleVariant?: string;
  usedMemoryIds: string[];
  model?: string | null;
  feedbackScore?: number;
  feedbackReasons?: string[];
}

export interface BrainDebugTurn {
  chatId: number;
  inputMessageId?: number;
  createdAt: Date;
  scene: SceneAnalysis;
  retrievedMemories: Array<{ id: string; text: string; relevance: number; reason: string }>;
  plan: ReplyPlan;
  styleVariant: string;
  candidates: string[];
  ranked: RankedReply[];
  repetitionChecks: RepetitionCheck[];
  finalText: string;
  safetyResult: SafetyGateResult;
}
