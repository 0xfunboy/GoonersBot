/**
 * Memory engine types. `MemoryItem` is the new source of truth for lore - a filtered, scored,
 * contextual store, NOT raw text dumped into prompts. The legacy `facts` collection is migrated in.
 */

export type MemorySubjectType =
  | 'user'
  | 'group'
  | 'relationship'
  | 'meme'
  | 'quote'
  | 'event'
  | 'running_joke';

export type MemoryCategory =
  | 'nickname'
  | 'role'
  | 'running_joke'
  | 'meme'
  | 'preference'
  | 'quote'
  | 'group_lore'
  | 'relationship'
  | 'reputation'
  | 'recurring_topic'
  | 'chat_rule'
  | 'style_signal';

export type MemorySource =
  | 'auto'
  | 'self_declared'
  | 'manual_extract'
  | 'admin'
  | 'imported'
  | 'migration';

export type MemoryToxicity = 'clean' | 'vulgar' | 'nsfw' | 'risky' | 'blocked';

export type MemoryStatus = 'candidate' | 'active' | 'rejected' | 'expired';

export type MemoryOperation = 'new' | 'reinforce' | 'update' | 'expire';

export interface MemoryRevision {
  text: string;
  normalizedText: string;
  confidence: number;
  salience: number;
  replacedAt: Date;
  reason?: string;
}

export interface MemoryItem {
  _id?: string;
  chatId: number;

  subjectType: MemorySubjectType;
  subjectHandle?: string | null;
  involvedHandles: string[];

  text: string;
  normalizedText: string;
  category: MemoryCategory;

  source: MemorySource;
  sourceMessageIds: number[];
  createdByHandle?: string | null;

  confidence: number;
  salience: number;
  toxicity: MemoryToxicity;
  status: MemoryStatus;

  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;

  lastUsedAt?: Date | null;
  useCount: number;
  positiveFeedbackCount: number;
  negativeFeedbackCount: number;

  embedding?: number[];
  tags: string[];

  /** Monotonic revision for facts/preferences that evolve instead of becoming duplicates. */
  revision?: number;
  /** Bounded history of replaced values, retained for audit but never injected into prompts. */
  history?: MemoryRevision[];
}

/** A freshly mined candidate, before dedupe/persist. */
export interface MemoryCandidate {
  subjectType: MemorySubjectType;
  subjectHandle?: string | null;
  involvedHandles: string[];
  category: MemoryCategory;
  text: string;
  normalizedText: string;
  confidence: number;
  salience: number;
  toxicity: MemoryToxicity;
  sourceMessageIds: number[];
  reason: string;
  /** How this evidence relates to the current store. Defaults to `new` for old model outputs. */
  operation?: MemoryOperation;
  /** Existing memory id affected by reinforce/update/expire. */
  targetMemoryId?: string | null;
}

export interface RetrievedMemory {
  item: MemoryItem;
  relevance: number;
  cosineScore?: number;
  reason: string;
  allowedToUseExplicitly: boolean;
}
