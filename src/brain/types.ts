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

/**
 * A turn's social meaning, kept separate from literal intent. "Help me, coglione" is still a
 * support turn; profanity alone must never route vulnerability into the roast pipeline.
 */
export type SocialSituation =
  | 'urgent_distress'
  | 'vulnerability'
  | 'practical_help'
  | 'factual_help'
  | 'gratitude'
  | 'celebration'
  | 'banter'
  | 'conflict'
  | 'creative_play'
  | 'casual';

export type SupportNeed = 'none' | 'low' | 'high' | 'urgent';

export type ResponsePosture =
  | 'protective'
  | 'steady'
  | 'practical'
  | 'curious'
  | 'celebratory'
  | 'sparring'
  | 'deescalating'
  | 'playful';

export type MemoryPolicy = 'avoid_callbacks' | 'implicit_only' | 'eligible';

export type ResponseOrder = 'stabilize_then_help' | 'answer_then_color' | 'play_first';

export interface SocialSignal {
  situation: SocialSituation;
  supportNeed: SupportNeed;
  posture: ResponsePosture;
  humorAllowed: boolean;
  roastCeiling: RoastBudget;
  memoryPolicy: MemoryPolicy;
  responseOrder: ResponseOrder;
  confidence: number;
  cues: string[];
}

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
  /** Deterministic social floor; optional for old debug records and external callers. */
  socialSignal?: SocialSignal;
}

export type ReplyIntent =
  | 'answer_question'
  | 'acknowledge_gratitude'
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
  | 'download_media'
  | 'archive_anime'
  | 'generate_image'
  | 'draw_image'
  | 'generate_video'
  | 'translate_text'
  | 'make_voice'
  | 'post_news'
  | 'acquire_capability'
  | 'summarize_thread'
  | 'use_group_lore'
  | 'banter_only'
  | 'stay_quiet';

export type ProviderRequest =
  | 'group_rag'
  | 'knowledge_rag'
  | 'anime_knowledge'
  | 'anime_archive'
  | 'web_search'
  | 'news'
  | 'image_lookup'
  | 'music'
  | 'link_media'
  | 'image_generation'
  | 'video_generation'
  | 'translation'
  | 'tts'
  | 'capability_forge';

export type ValueTarget =
  | 'truth'
  | 'context'
  | 'joke'
  | 'support'
  | 'technical_help'
  | 'social_glue';

export type RoastBudget = 'none' | 'light' | 'medium' | 'heavy';

/**
 * The comic mechanism, not merely the tone. Rotating this prevents every response from being the
 * same insult wearing a different adjective.
 */
export type ComedyStrategy =
  | 'none'
  | 'surgical_observation'
  | 'absurd_analogy'
  | 'mock_authority'
  | 'status_reversal'
  | 'literal_misread'
  | 'escalating_specificity'
  | 'understatement'
  | 'self_own'
  | 'callback_remix'
  | 'shared_enemy'
  | 'warm_deadpan';

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
  /** Hard social calibration inferred from the actual turn, not personality flavor. */
  socialSignal?: SocialSignal;
  searchQuery?: string;
  musicQuery?: string;
  mediaQuery?: string;
  mediaUrl?: string;
  imagePrompt?: string;
  videoPrompt?: string;
  targetLanguage?: string;
  sourceText?: string;
  voiceText?: string;
}

export interface ProviderBundle {
  threadContext?: string;
  socialContext?: string;
  groupContext?: string;
  knowledgeContext?: string;
  /** Ambient recall: verified facts about whatever the chat is discussing right now. */
  ambientContext?: string;
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
  socialSignal?: SocialSignal;
  comedyStrategy?: ComedyStrategy;
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
  /** chosen joke mechanics; `none` is intentional during serious support. */
  comedyStrategies?: ComedyStrategy[];
  supportPosture?: ResponsePosture;
  humorAllowed?: boolean;
}

export interface RankedReply {
  index: number;
  score: number;
  reason: string;
  problems: string[];
}

export interface RepetitionCheck {
  allowed: boolean;
  /** True only for a reason strong enough to justify another model call. */
  hardBlocked: boolean;
  reason?: string;
  /** Variety hints used for ranking/telemetry; they never discard an otherwise useful reply. */
  advisoryReasons: string[];
  similarityToRecentReplies: number;
  repeatedPhrases: string[];
  overusedMemoryIds: string[];
  sameOpening: boolean;
  /** Similarity after lightweight concept canonicalisation, so paraphrases are visible. */
  semanticSimilarity: number;
  /** Reused joke subjects such as "wallet/trading loss" or "low intelligence". */
  repeatedPremises: string[];
  sameComedyStrategy: boolean;
  callbackSaturation: boolean;
}

/** A persisted bot reply (for repetition guard + feedback). */
export interface BotReplyRecord {
  _id?: string;
  chatId: number;
  /** Person the reply was aimed at, used for relationship-specific adaptation. */
  recipientHandle?: string;
  messageId?: number;
  /** Every Telegram message emitted for this turn (text plus successful media artifacts). */
  messageIds?: number[];
  text: string;
  normalizedText: string;
  fingerprint: string;
  createdAt: Date;
  styleVariant?: string;
  comedyStrategy?: ComedyStrategy;
  jokePremises?: string[];
  socialSituation?: SocialSituation;
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
  cortex?: import('./cortex/schema.js').SourcedCortexDecision;
  providerSources: string[];
  providerBundle?: ProviderBundle;
  threadContext?: string;
  retrievedMemories: Array<{
    id: string;
    text: string;
    relevance: number;
    reason: string;
    cosineScore?: number;
  }>;
  plan: ReplyPlan;
  styleVariant: string;
  candidates: string[];
  ranked: RankedReply[];
  repetitionChecks: RepetitionCheck[];
  finalText: string;
}
