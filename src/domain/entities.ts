/**
 * MongoDB document shapes. These are the persisted entities behind the repositories.
 * Collections (per MIGRATION_AUDIT §5): chats, users, chat_members, modes, facts, messages,
 * usage, bans, terms_acceptance, media, jobs.
 */

/** NSFW routing mode for a chat. off => never; base => whole chat uses NSFW model; smart => per-message lexicon. */
export type NsfwMode = 'off' | 'base' | 'smart';

export interface ChatDoc {
  chatId: number;
  chatName?: string;
  language: string;
  isStarted: boolean;
  conversationTracker: boolean;
  autoFact: boolean;
  autoengage: boolean;
  nsfwMode: NsfwMode;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserDoc {
  handle: string;
  telegramId: number;
  firstName?: string | null;
  lastName?: string | null;
  isPremium?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMemberDoc {
  chatId: number;
  handle: string;
  telegramId: number;
  lastSeenAt: Date;
  messageCount: number;
}

export interface ModeDoc {
  chatId: number;
  name: string;
  description: string;
  isBuiltin: boolean;
  isActive: boolean;
  /** when true, this mode always routes to the NSFW model (subject to chat allowing NSFW) */
  nsfw: boolean;
  createdByHandle: string | null;
  createdAt: Date;
}

export type FactSource = 'manual' | 'auto' | 'introduction';

export interface FactDoc {
  chatId: number;
  userHandle: string;
  fact: string;
  source: FactSource;
  createdByHandle: string | null;
  createdAt: Date;
}

export interface MessageDoc {
  chatId: number;
  messageId?: number | null;
  userHandle: string;
  telegramId?: number | null;
  isBot: boolean;
  messageText: string | null;
  imageDescription?: string | null;
  voiceDescription?: string | null;
  replyToMessageId?: number | null;
  replyToHandle?: string | null;
  mentionedHandles?: string[];
  timestamp: Date;
  createdAt: Date;
}

export interface UsageDoc {
  handle: string;
  usage: number;
  limit: number;
  lastReset: Date;
  // breakdown counters
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: number;
  imageCalls: number;
  transcriptionCalls: number;
  visionCalls: number;
  costEstimate: number;
  updatedAt: Date;
}

export interface UsageEventDoc {
  handle: string;
  chatId: number;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: number;
  imageCalls: number;
  transcriptionCalls: number;
  visionCalls: number;
  points: number;
  costEstimate: number;
  createdAt: Date;
}

export interface BanDoc {
  handle: string;
  bannedAt: Date;
  /** null => permanent ban */
  bannedUntil: Date | null;
  bannedByHandle: string | null;
}

export interface TermsAcceptanceDoc {
  handle: string;
  accepted: boolean;
  declined: boolean;
  updatedAt: Date;
}

export type MediaDirection = 'inbound' | 'outbound';
export type MediaKind = 'image' | 'voice' | 'audio';

export interface MediaDoc {
  chatId: number;
  handle: string;
  direction: MediaDirection;
  kind: MediaKind;
  description?: string | null;
  url?: string | null;
  byteSize?: number | null;
  createdAt: Date;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobDoc {
  type: string;
  status: JobStatus;
  payload?: Record<string, unknown>;
  scheduledFor: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  error?: string | null;
  createdAt: Date;
}
