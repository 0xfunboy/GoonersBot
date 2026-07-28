/**
 * Long-lived social memory.
 *
 * This is deliberately separate from raw conversation memory: a social profile is a compact,
 * evolving model of a person and of the group's shared culture. Every claim keeps provenance and
 * lifecycle state, so a correction can supersede stale lore instead of adding another contradictory
 * sentence to the prompt.
 */

export type SocialFacetKind =
  | 'interest'
  | 'preference'
  | 'aversion'
  | 'skill'
  | 'role'
  | 'communication_style'
  | 'goal'
  | 'habit';

export type SocialClaimState = 'active' | 'disputed' | 'superseded' | 'retracted' | 'stale';

export type SocialEvidenceSource =
  | 'self_declared'
  | 'admin'
  | 'direct_observation'
  | 'repeated_behavior'
  | 'peer_report'
  | 'inferred'
  | 'migration';

export interface SocialFacetClaim {
  id: string;
  kind: SocialFacetKind;
  /** Stable semantic slot, e.g. "football_team", "music", "work_role". */
  key: string;
  normalizedKey: string;
  /** Current value of this claim, e.g. "Inter" or "doom metal". */
  value: string;
  normalizedValue: string;
  state: SocialClaimState;
  confidence: number;
  salience: number;
  source: SocialEvidenceSource;
  evidenceCount: number;
  contradictionCount: number;
  sourceMessageIds: number[];
  firstObservedAt: Date;
  lastObservedAt: Date;
  lastConfirmedAt: Date;
  supersededAt?: Date | null;
  supersededBy?: string | null;
  /** Provenance for reversible revise/retract lifecycle mutations. */
  stateChangedBySourceMessageId?: number | null;
  stateBeforeLastChange?: SocialClaimState | null;
}

export interface MemberSocialProfile {
  chatId: number;
  handle: string;
  telegramId?: number | null;
  displayName?: string | null;
  aliases: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  messageCount: number;
  facets: SocialFacetClaim[];
  createdAt: Date;
  updatedAt: Date;
  /** Optimistic concurrency version. Zero is reserved for an absent document. */
  version: number;
}

export type RelationshipDimension =
  | 'affinity'
  | 'warmth'
  | 'trust'
  | 'banter_affinity'
  | 'support'
  | 'rivalry'
  | 'familiarity';

export interface SocialRelationship {
  id: string;
  fromHandle: string;
  toHandle: string;
  dimension: RelationshipDimension;
  /** -1..1. Meaning depends on dimension; positive is more/stronger. */
  score: number;
  confidence: number;
  evidenceCount: number;
  sourceMessageIds: number[];
  firstObservedAt: Date;
  lastObservedAt: Date;
}

export type RunningJokeState = 'active' | 'cooling' | 'retired';

export interface RunningJoke {
  id: string;
  canonicalKey: string;
  label: string;
  targetHandles: string[];
  /** Distinct phrasings/examples. They are inspiration, never mandatory canned replies. */
  variants: string[];
  state: RunningJokeState;
  confidence: number;
  vitality: number;
  evidenceCount: number;
  sourceMessageIds: number[];
  firstObservedAt: Date;
  lastObservedAt: Date;
  lastUsedAt?: Date | null;
  useCount: number;
  /** Recent variant identifiers prevent immediate verbatim reuse. */
  recentVariants: string[];
  /** 0..1, increases on use and decays over time. */
  fatigue: number;
  fatigueUpdatedAt: Date;
  stateChangedBySourceMessageId?: number | null;
  stateBeforeLastChange?: RunningJokeState | null;
}

export interface ChatSocialNorm {
  id: string;
  key: string;
  normalizedKey: string;
  value: string;
  normalizedValue: string;
  state: SocialClaimState;
  confidence: number;
  source: SocialEvidenceSource;
  evidenceCount: number;
  sourceMessageIds: number[];
  firstObservedAt: Date;
  lastObservedAt: Date;
  supersededBy?: string | null;
  stateChangedBySourceMessageId?: number | null;
  stateBeforeLastChange?: SocialClaimState | null;
}

export interface ChatSocialState {
  chatId: number;
  relationships: SocialRelationship[];
  runningJokes: RunningJoke[];
  norms: ChatSocialNorm[];
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export type FacetObservationAction = 'reinforce' | 'revise' | 'retract';

export interface SocialObservationBase {
  confidence: number;
  salience?: number;
  source: SocialEvidenceSource;
  sourceMessageId?: number | null;
  authorHandle?: string | null;
  observedAt?: Date;
}

export interface FacetObservation extends SocialObservationBase {
  kind: 'facet';
  subjectHandle: string;
  facet: SocialFacetKind;
  key: string;
  /** Omitted for a retraction that applies to every value in the semantic slot. */
  value?: string | null;
  action?: FacetObservationAction;
}

export interface IdentityObservation extends SocialObservationBase {
  kind: 'identity';
  subjectHandle: string;
  displayName?: string | null;
  alias?: string | null;
  telegramId?: number | null;
}

export interface RelationshipObservation extends SocialObservationBase {
  kind: 'relationship';
  fromHandle: string;
  toHandle: string;
  dimension: RelationshipDimension;
  delta: number;
}

export interface RunningJokeObservation extends SocialObservationBase {
  kind: 'running_joke';
  canonicalKey: string;
  label: string;
  targetHandles?: string[];
  variant?: string | null;
  action?: 'reinforce' | 'retire' | 'revive';
}

export interface ChatNormObservation extends SocialObservationBase {
  kind: 'chat_norm';
  key: string;
  value?: string | null;
  action?: FacetObservationAction;
}

export type SocialObservation =
  | FacetObservation
  | IdentityObservation
  | RelationshipObservation
  | RunningJokeObservation
  | ChatNormObservation;

export interface SocialMemberContext {
  handle: string;
  displayName?: string | null;
  aliases: string[];
  familiarity: number;
  facets: Array<{
    kind: SocialFacetKind;
    key: string;
    value: string;
    confidence: number;
    salience: number;
  }>;
}

export interface SocialContext {
  chatId: number;
  members: SocialMemberContext[];
  relationships: Array<{
    fromHandle: string;
    toHandle: string;
    dimension: RelationshipDimension;
    score: number;
    confidence: number;
  }>;
  runningJokes: Array<{
    id: string;
    label: string;
    targetHandles: string[];
    variants: string[];
    score: number;
  }>;
  norms: Array<{ key: string; value: string; confidence: number }>;
}

export interface SocialProfileStore {
  getMember(chatId: number, handle: string): Promise<MemberSocialProfile | null>;
  /** Optional stable-identity lookup used to merge a profile after a Telegram username change. */
  getMemberByTelegramId?(chatId: number, telegramId: number): Promise<MemberSocialProfile | null>;
  listMembers(chatId: number, limit?: number): Promise<MemberSocialProfile[]>;
  saveMember(profile: MemberSocialProfile, expectedVersion: number): Promise<boolean>;
  deleteMember(chatId: number, handle: string): Promise<boolean>;
  getChatState(chatId: number): Promise<ChatSocialState | null>;
  saveChatState(state: ChatSocialState, expectedVersion: number): Promise<boolean>;
}

export interface SocialEvolutionOptions {
  now: Date;
  id: () => string;
  maxFacetHistory: number;
  maxJokes: number;
  maxRelationships: number;
  maxNormHistory: number;
}

export interface SocialObservationResult {
  accepted: number;
  rejected: number;
  memberProfilesChanged: number;
  chatStateChanged: boolean;
}
