/**
 * Brain pipeline types: scene → plan → style → generate → rank → repetition guard.
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
  | 'summarize'
  | 'hype'
  | 'lore_callback'
  | 'ignore_memory_and_answer_directly'
  | 'deadpan'
  | 'chaos_reply';

export type MemoryUseMode = 'none' | 'implicit_style' | 'explicit_callback';

export type TurnAction =
  | 'answer'
  | 'challenge_claim'
  | 'ground_search'
  | 'bring_news_context'
  | 'download_music'
  | 'generate_image'
  | 'draw_image'
  | 'translate_text'
  | 'make_voice'
  | 'post_news'
  | 'summarize_thread'
  | 'use_group_lore'
  | 'banter_only'
  | 'stay_quiet';

export type ProviderRequest =
  | 'group_rag'
  | 'knowledge_rag'
  | 'web_search'
  | 'news'
  | 'image_lookup'
  | 'music'
  | 'image_generation'
  | 'translation'
  | 'tts';

export type ValueTarget =
  | 'truth'
  | 'context'
  | 'joke'
  | 'support'
  | 'technical_help'
  | 'social_glue';

export type RoastBudget = 'none' | 'light' | 'medium' | 'heavy';

export type SocialRole =
  | 'friend'
  | 'truth_checker'
  | 'banter'
  | 'lorekeeper'
  | 'quiet_listener'
  | 'technical_peer';

export interface TurnEvaluation {
  shouldAct: boolean;
  action: TurnAction;
  providerRequests: ProviderRequest[];
  valueTarget: ValueTarget;
  roastBudget: RoastBudget;
  socialRole: SocialRole;
  confidence: number;
  reason: string;
  searchQuery?: string;
  musicQuery?: string;
  imagePrompt?: string;
  targetLanguage?: string;
  sourceText?: string;
  voiceText?: string;
}

export interface ProviderBundle {
  groupContext?: string;
  knowledgeContext?: string;
  webContext?: string;
  newsContext?: string;
  claimCheck?: string;
  sources: string[];
}

export interface ReplyPlan {
  replyIntent: ReplyIntent;
  action: TurnAction;
  valueTarget: ValueTarget;
  roastBudget: RoastBudget;
  socialRole: SocialRole;
  mustBringValue: boolean;
  targetHandles: string[];
  tone: string;
  maxLines: number;
  maxChars: number;
  memoryIdsToUse: string[];
  memoryUseMode: MemoryUseMode;
  forbiddenReferences: string[];
  bannedPhrases: string[];
  noveltyInstruction: string;
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
  /** chosen named variants (1-2) for this turn */
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
  evaluation: TurnEvaluation;
  providerSources: string[];
  providerBundle?: ProviderBundle;
  retrievedMemories: Array<{ id: string; text: string; relevance: number; reason: string }>;
  plan: ReplyPlan;
  styleVariant: string;
  candidates: string[];
  ranked: RankedReply[];
  repetitionChecks: RepetitionCheck[];
  finalText: string;
}
