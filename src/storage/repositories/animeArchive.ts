import { createHash, randomBytes } from 'node:crypto';
import type { Collection, Db, Document, Filter } from 'mongodb';

export type AnimeArchiveSource = 'animeunity' | 'hentaisaturn';
export type AnimeArchiveScope = 'episode' | 'series';

export interface AnimeArchiveSeriesRef {
  id: string;
  canonicalUrl: string;
  title: string;
}

export interface AnimeArchiveEpisodeRef {
  id: string;
  number: number;
  canonicalUrl: string;
  title?: string | undefined;
}

export type AnimeArchiveTarget =
  | {
      kind: 'episode';
      series: AnimeArchiveSeriesRef;
      episode: AnimeArchiveEpisodeRef;
    }
  | {
      kind: 'series';
      series: AnimeArchiveSeriesRef;
    };

export type AnimeArchiveOfferState = 'pending' | 'accepted' | 'cancelled';

/**
 * Short-lived server-side state behind a Telegram confirmation button.
 *
 * Only the opaque `id` belongs in callback_data. In particular, this document deliberately has
 * no media URL/cookie/header field: source adapters must only persist canonical public page URLs.
 */
export interface AnimeArchiveOfferDoc {
  id: string;
  /** Hashed actor/chat/topic/target slot used to keep only one equivalent pending prompt. */
  dedupeKey: string;
  source: AnimeArchiveSource;
  target: AnimeArchiveTarget;
  chatId: number;
  threadId: number | null;
  replyToMessageId: number | null;
  confirmationMessageId: number | null;
  requesterTelegramId: number;
  requiresAdmin: boolean;
  state: AnimeArchiveOfferState;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  cancelledAt: Date | null;
}

export interface CreateAnimeArchiveOfferInput {
  source: AnimeArchiveSource;
  target: AnimeArchiveTarget;
  chatId: number;
  threadId?: number | null | undefined;
  replyToMessageId?: number | null | undefined;
  requesterTelegramId: number;
  requiresAdmin: boolean;
  /** Defaults to a short repository-owned lifetime. */
  expiresAt?: Date | undefined;
}

export interface AnimeArchiveOfferActor {
  actorTelegramId: number;
  chatId: number;
  threadId?: number | null | undefined;
  isAdmin: boolean;
}

export interface AnimeArchiveConfirmationAttachmentResult {
  /** Post-update view synthesized from the document atomically returned before replacement. */
  offer: AnimeArchiveOfferDoc;
  /** Exact Telegram message id displaced by this update, or null for the first attachment. */
  replacedMessageId: number | null;
}

export type AnimeArchiveOfferTransitionFailure =
  | 'not_found'
  | 'expired'
  | 'wrong_actor'
  | 'wrong_chat'
  | 'admin_required'
  | 'already_consumed';

export type AnimeArchiveOfferTransitionResult =
  | { ok: true; offer: AnimeArchiveOfferDoc }
  | { ok: false; reason: AnimeArchiveOfferTransitionFailure };

export const DEFAULT_ANIME_ARCHIVE_OFFER_TTL_MS = 15 * 60_000;
export const DEFAULT_ANIME_ARCHIVE_SEARCH_SESSION_TTL_MS = 30 * 60_000;

export interface AnimeArchiveSearchSessionItem {
  source: AnimeArchiveSource;
  sourceId: string;
  title: string;
  aliases: string[];
  canonicalUrl: string;
  coverUrl?: string | undefined;
  status: 'ongoing' | 'completed' | 'unknown';
  genres: string[];
  episodeCount?: number | undefined;
  year?: string | undefined;
  /** Bounded source description used only to resolve later references; never a media URL. */
  description?: string | undefined;
  /** 0..1 ranking confidence assigned from source-backed metadata. */
  matchScore: number;
  reason: string;
}

export interface AnimeArchiveSearchSessionDoc {
  id: string;
  chatId: number;
  threadId: number | null;
  requesterTelegramId: number;
  source: AnimeArchiveSource;
  query: string;
  searchQueries: string[];
  items: AnimeArchiveSearchSessionItem[];
  /** Telegram message that displayed this shortlist, attached after successful delivery. */
  resultMessageId: number | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface CreateAnimeArchiveSearchSessionInput {
  chatId: number;
  threadId?: number | null | undefined;
  requesterTelegramId: number;
  source: AnimeArchiveSource;
  query: string;
  searchQueries: string[];
  items: AnimeArchiveSearchSessionItem[];
  expiresAt?: Date | undefined;
}

/** Pure validation used after a failed compare-and-set and by in-memory tests. */
export function classifyAnimeArchiveOfferTransition(
  offer: AnimeArchiveOfferDoc | null,
  actor: AnimeArchiveOfferActor,
  now: Date,
  action: 'accept' | 'cancel' = 'accept',
): AnimeArchiveOfferTransitionFailure | null {
  if (!offer) return 'not_found';
  if (offer.requesterTelegramId !== actor.actorTelegramId) return 'wrong_actor';
  if (offer.chatId !== actor.chatId || offer.threadId !== normalizeThreadId(actor.threadId)) {
    return 'wrong_chat';
  }
  if (offer.state !== 'pending') return 'already_consumed';
  if (offer.expiresAt.getTime() <= now.getTime()) return 'expired';
  // Admin is deliberately re-checked only for SI. The owner must always be able to invalidate a
  // pending NO token, even if Telegram demoted them after the prompt was created.
  if (action === 'accept' && offer.requiresAdmin && !actor.isAdmin) return 'admin_required';
  return null;
}

/**
 * Validation for repairing the narrow accepted-offer -> durable-job gap without reopening the
 * ordinary pending transition. The original owner/chat/topic and bulk authority still apply.
 */
export function classifyAnimeArchiveAcceptedOfferRecovery(
  offer: AnimeArchiveOfferDoc | null,
  actor: AnimeArchiveOfferActor,
  now: Date,
): AnimeArchiveOfferTransitionFailure | null {
  if (!offer) return 'not_found';
  if (offer.requesterTelegramId !== actor.actorTelegramId) return 'wrong_actor';
  if (offer.chatId !== actor.chatId || offer.threadId !== normalizeThreadId(actor.threadId)) {
    return 'wrong_chat';
  }
  if (offer.state !== 'accepted') return 'already_consumed';
  if (offer.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (offer.requiresAdmin && !actor.isAdmin) return 'admin_required';
  return null;
}

/** Stable non-reversible slot key. Equivalent prompts never persist raw target URLs in an index. */
export function animeArchiveOfferDedupeKey(input: CreateAnimeArchiveOfferInput): string {
  const target = normalizeTarget(input.target);
  return `offer:${shortHash(
    JSON.stringify({
      requesterTelegramId: input.requesterTelegramId,
      chatId: input.chatId,
      threadId: normalizeThreadId(input.threadId),
      source: input.source,
      kind: target.kind,
      seriesId: target.series.id,
      episodeId: target.kind === 'episode' ? target.episode.id : null,
    }),
  )}`;
}

export class AnimeArchiveOffersRepo {
  private readonly col: Collection<AnimeArchiveOfferDoc>;

  constructor(
    db: Db,
    private readonly idFactory: () => string = () => opaqueId('ao'),
  ) {
    this.col = db.collection<AnimeArchiveOfferDoc>('anime_archive_offers');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<AnimeArchiveOfferDoc>('anime_archive_offers');
    await col.createIndex({ id: 1 }, { unique: true });
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await col.createIndex(
      { dedupeKey: 1 },
      {
        unique: true,
        partialFilterExpression: { dedupeKey: { $type: 'string' }, state: 'pending' },
      },
    );
    await col.createIndex({
      requesterTelegramId: 1,
      chatId: 1,
      threadId: 1,
      state: 1,
      createdAt: -1,
    });
    await col.createIndex(
      { chatId: 1, confirmationMessageId: 1 },
      {
        partialFilterExpression: { confirmationMessageId: { $type: 'number' } },
      },
    );
  }

  async create(
    input: CreateAnimeArchiveOfferInput,
    now: Date = new Date(),
  ): Promise<AnimeArchiveOfferDoc> {
    assertValidDate(now, 'now');
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(now.getTime() + DEFAULT_ANIME_ARCHIVE_OFFER_TTL_MS);
    assertValidDate(expiresAt, 'expiresAt');
    if (expiresAt.getTime() <= now.getTime()) {
      throw new Error('Anime archive offer expiry must be in the future');
    }

    const normalizedTarget = normalizeTarget(input.target);
    const dedupeKey = animeArchiveOfferDedupeKey({ ...input, target: normalizedTarget });

    // Reusing the pending nonce prevents equivalent natural/direct prompts from making an
    // otherwise safe unquoted SI/NO ambiguous. Keep the previous attachment live until the new
    // Telegram message is successfully attached, and refresh the request destination/expiry.
    const existing = await this.col.findOneAndUpdate(
      { dedupeKey, state: 'pending', expiresAt: { $gt: now } },
      {
        $set: {
          target: normalizedTarget,
          replyToMessageId: input.replyToMessageId ?? null,
          requiresAdmin: input.requiresAdmin,
          expiresAt,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
    if (existing) return existing;

    // TTL deletion is asynchronous. Release an expired pending slot before inserting its new
    // nonce, otherwise the partial unique index would reject a legitimate fresh prompt.
    await this.col.updateMany(
      { dedupeKey, state: 'pending', expiresAt: { $lte: now } },
      { $set: { state: 'cancelled', cancelledAt: now, updatedAt: now } },
    );

    const offer: AnimeArchiveOfferDoc = {
      id: this.idFactory(),
      dedupeKey,
      source: input.source,
      target: normalizedTarget,
      chatId: input.chatId,
      threadId: normalizeThreadId(input.threadId),
      replyToMessageId: input.replyToMessageId ?? null,
      confirmationMessageId: null,
      requesterTelegramId: input.requesterTelegramId,
      requiresAdmin: input.requiresAdmin,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt,
      acceptedAt: null,
      cancelledAt: null,
    };
    try {
      await this.col.insertOne(offer);
      return offer;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // A concurrent equivalent request won the slot. Return its opaque nonce instead of leaking a
      // duplicate-key race to the message pipeline.
      const raced = await this.col.findOne({
        dedupeKey,
        state: 'pending',
        expiresAt: { $gt: now },
      });
      if (raced) return raced;
      throw error;
    }
  }

  async attachConfirmationMessage(
    id: string,
    confirmationMessageId: number,
    now: Date = new Date(),
  ): Promise<AnimeArchiveOfferDoc | null> {
    return (await this.replaceConfirmationMessage(id, confirmationMessageId, now))?.offer ?? null;
  }

  /**
   * Atomically replace a pending prompt attachment and return the message id observed immediately
   * before the write. Callers can therefore retire the exact loser of concurrent replacements.
   */
  async replaceConfirmationMessage(
    id: string,
    confirmationMessageId: number,
    now: Date = new Date(),
  ): Promise<AnimeArchiveConfirmationAttachmentResult | null> {
    const previous = await this.col.findOneAndUpdate(
      {
        id,
        state: 'pending',
        expiresAt: { $gt: now },
      },
      { $set: { confirmationMessageId, updatedAt: now } },
      { returnDocument: 'before' },
    );
    if (!previous) return null;
    return {
      offer: { ...previous, confirmationMessageId, updatedAt: now },
      replacedMessageId: previous.confirmationMessageId,
    };
  }

  /** Internal delivery cleanup: make a pending nonce unusable after send/attachment failure. */
  async invalidatePending(
    id: string,
    now: Date = new Date(),
  ): Promise<AnimeArchiveOfferDoc | null> {
    return this.col.findOneAndUpdate(
      { id, state: 'pending', confirmationMessageId: null },
      { $set: { state: 'cancelled', cancelledAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    );
  }

  async get(id: string): Promise<AnimeArchiveOfferDoc | null> {
    return this.col.findOne({ id });
  }

  /**
   * Resolve the exact series identity behind a message the user is replying to. The offer may have
   * been accepted/cancelled already: its canonical source reference remains useful conversational
   * context until the normal offer TTL removes it.
   */
  async findByConfirmationMessage(
    chatId: number,
    confirmationMessageId: number,
    requesterTelegramId: number,
    now: Date = new Date(),
  ): Promise<AnimeArchiveOfferDoc | null> {
    return this.col.findOne({
      chatId,
      confirmationMessageId,
      requesterTelegramId,
      expiresAt: { $gt: now },
    });
  }

  /** Recent canonical archive references for semantic follow-ups, regardless of consumed state. */
  async listLatestContextForActor(
    actor: Omit<AnimeArchiveOfferActor, 'isAdmin'>,
    limit: number,
    now: Date = new Date(),
  ): Promise<AnimeArchiveOfferDoc[]> {
    return this.col
      .find({
        requesterTelegramId: actor.actorTelegramId,
        chatId: actor.chatId,
        threadId: normalizeThreadId(actor.threadId),
        expiresAt: { $gt: now },
      })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(Math.max(1, Math.min(8, Math.trunc(limit) || 1)))
      .toArray();
  }

  /** Delivered pending confirmations for textual SI/NO matching, newest first. */
  async listLatestPendingForActor(
    actor: Omit<AnimeArchiveOfferActor, 'isAdmin'>,
    limit = 10,
    now: Date = new Date(),
  ): Promise<AnimeArchiveOfferDoc[]> {
    return this.col
      .find({
        requesterTelegramId: actor.actorTelegramId,
        chatId: actor.chatId,
        threadId: normalizeThreadId(actor.threadId),
        state: 'pending',
        expiresAt: { $gt: now },
        // Telegram message ids are positive; this excludes null/unattached offers with a typed
        // filter the Mongo driver can validate without relying on its incomplete `$type` aliases.
        confirmationMessageId: { $gt: 0 },
      })
      .sort({ createdAt: -1 })
      .limit(clampLimit(limit))
      .toArray();
  }

  async findLatestPendingForActor(
    actor: Omit<AnimeArchiveOfferActor, 'isAdmin'>,
    now: Date = new Date(),
  ): Promise<AnimeArchiveOfferDoc | null> {
    const [offer] = await this.listLatestPendingForActor(actor, 1, now);
    return offer ?? null;
  }

  async accept(
    id: string,
    actor: AnimeArchiveOfferActor,
    now: Date = new Date(),
  ): Promise<AnimeArchiveOfferTransitionResult> {
    return this.transition(id, actor, 'accepted', now);
  }

  async cancel(
    id: string,
    actor: AnimeArchiveOfferActor,
    now: Date = new Date(),
  ): Promise<AnimeArchiveOfferTransitionResult> {
    return this.transition(id, actor, 'cancelled', now);
  }

  private async transition(
    id: string,
    actor: AnimeArchiveOfferActor,
    state: 'accepted' | 'cancelled',
    now: Date,
  ): Promise<AnimeArchiveOfferTransitionResult> {
    const filter: Filter<AnimeArchiveOfferDoc> = {
      id,
      state: 'pending',
      expiresAt: { $gt: now },
      requesterTelegramId: actor.actorTelegramId,
      chatId: actor.chatId,
      threadId: normalizeThreadId(actor.threadId),
      ...(state === 'accepted' && !actor.isAdmin ? { requiresAdmin: false } : {}),
    };
    const timestampField = state === 'accepted' ? 'acceptedAt' : 'cancelledAt';
    const offer = await this.col.findOneAndUpdate(
      filter,
      { $set: { state, updatedAt: now, [timestampField]: now } },
      { returnDocument: 'after' },
    );
    if (offer) return { ok: true, offer };

    // The write above is the lock. This read only explains why its compare-and-set did not match.
    const reason = classifyAnimeArchiveOfferTransition(
      await this.get(id),
      actor,
      now,
      state === 'accepted' ? 'accept' : 'cancel',
    );
    return { ok: false, reason: reason ?? 'already_consumed' };
  }
}

/**
 * Short-lived, source-backed recommendation memory. It stores only canonical public series refs and
 * metadata, never signed media URLs. This is the bridge between "find me something like X" and a
 * later "ok, send title Y episode 2" follow-up.
 */
export class AnimeArchiveSearchSessionsRepo {
  private readonly col: Collection<AnimeArchiveSearchSessionDoc>;

  constructor(
    db: Db,
    private readonly idFactory: () => string = () => opaqueId('as'),
  ) {
    this.col = db.collection<AnimeArchiveSearchSessionDoc>('anime_archive_search_sessions');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<AnimeArchiveSearchSessionDoc>('anime_archive_search_sessions');
    await col.createIndex({ id: 1 }, { unique: true });
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await col.createIndex({
      requesterTelegramId: 1,
      chatId: 1,
      threadId: 1,
      createdAt: -1,
    });
    await col.createIndex(
      { chatId: 1, resultMessageId: 1 },
      { partialFilterExpression: { resultMessageId: { $type: 'number' } } },
    );
  }

  async create(
    input: CreateAnimeArchiveSearchSessionInput,
    now: Date = new Date(),
  ): Promise<AnimeArchiveSearchSessionDoc> {
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(now.getTime() + DEFAULT_ANIME_ARCHIVE_SEARCH_SESSION_TTL_MS);
    assertValidDate(expiresAt, 'expiresAt');
    if (expiresAt.getTime() <= now.getTime()) {
      throw new Error('Anime archive search session expiry must be in the future');
    }
    const doc: AnimeArchiveSearchSessionDoc = {
      id: this.idFactory(),
      chatId: input.chatId,
      threadId: normalizeThreadId(input.threadId),
      requesterTelegramId: input.requesterTelegramId,
      source: input.source,
      query: input.query.trim().slice(0, 500),
      searchQueries: [
        ...new Set(input.searchQueries.map((value) => value.trim()).filter(Boolean)),
      ].slice(0, 8),
      items: input.items.slice(0, 8).map((item) => ({
        ...item,
        aliases: [...new Set(item.aliases.map((value) => value.trim()).filter(Boolean))].slice(
          0,
          16,
        ),
        genres: [...new Set(item.genres.map((value) => value.trim()).filter(Boolean))].slice(0, 24),
        description: item.description?.slice(0, 1_500),
        reason: item.reason.slice(0, 300),
        matchScore: Math.max(0, Math.min(1, item.matchScore)),
      })),
      resultMessageId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
    await this.col.insertOne(doc);
    return doc;
  }

  async attachResultMessage(
    id: string,
    resultMessageId: number,
    now: Date = new Date(),
  ): Promise<AnimeArchiveSearchSessionDoc | null> {
    return this.col.findOneAndUpdate(
      { id, expiresAt: { $gt: now } },
      { $set: { resultMessageId, updatedAt: now } },
      { returnDocument: 'after' },
    );
  }

  async findByMessage(
    chatId: number,
    resultMessageId: number,
    requesterTelegramId: number,
    now: Date = new Date(),
  ): Promise<AnimeArchiveSearchSessionDoc | null> {
    return this.col.findOne({
      chatId,
      resultMessageId,
      requesterTelegramId,
      expiresAt: { $gt: now },
    });
  }

  async findLatestForActor(
    actor: { chatId: number; threadId?: number | null; requesterTelegramId: number },
    now: Date = new Date(),
  ): Promise<AnimeArchiveSearchSessionDoc | null> {
    return this.col.findOne(
      {
        chatId: actor.chatId,
        threadId: normalizeThreadId(actor.threadId),
        requesterTelegramId: actor.requesterTelegramId,
        expiresAt: { $gt: now },
      },
      { sort: { createdAt: -1 } },
    );
  }
}

export type AnimeArchiveEpisodeState = 'pending' | 'running' | 'done' | 'failed';
export const ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN =
  'Telegram delivery outcome unknown; automatic retry suppressed';
const DURABLE_DELIVERY_WRITE_CONCERN = {
  w: 'majority' as const,
  journal: true,
  wtimeoutMS: 10_000,
};
export type AnimeArchiveJobState =
  | 'queued'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface AnimeArchiveTelegramReceipt {
  chatId: number;
  /** Primary/last Telegram message for backwards compatibility with single-file deliveries. */
  messageId: number;
  /** Every message emitted for a losslessly split episode, in playback order. */
  messageIds?: number[] | undefined;
  fileId?: string | undefined;
  /** File ids for multipart lossless deliveries, aligned with messageIds when available. */
  fileIds?: string[] | undefined;
  fileUniqueId?: string | undefined;
  mediaKind?: 'video' | 'document' | undefined;
}

export interface AnimeArchiveJobEpisode extends AnimeArchiveEpisodeRef {
  /** Stable numeric processing order after episode-number sorting. */
  order: number;
  status: AnimeArchiveEpisodeState;
  /** Attempts in the current run/resume cycle. */
  attempts: number;
  /** Lifetime attempts, retained when a terminal/cancelled job is resumed. */
  totalAttempts: number;
  receipt: AnimeArchiveTelegramReceipt | null;
  /** Opaque CAS marker persisted immediately before the Telegram upload starts. */
  deliveryToken?: string | null | undefined;
  deliveryStartedAt?: Date | null | undefined;
  /** Terminal safety latch: a retry could duplicate a Telegram message, so it stays non-resumable. */
  deliveryOutcomeUnknown?: boolean | undefined;
  failureReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface AnimeArchiveDestination {
  chatId: number;
  threadId: number | null;
  replyToMessageId: number | null;
}

export interface AnimeArchiveFailedEpisodeSummary {
  id: string;
  number: number;
  reason: string;
}

export interface AnimeArchiveJobSummary {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  running: number;
  /** Episodes already complete when the latest resume cycle began. */
  skipped: number;
  failedEpisodes: AnimeArchiveFailedEpisodeSummary[];
}

export interface AnimeArchiveJobDoc {
  id: string;
  idempotencyKey: string;
  offerId: string | null;
  scope: AnimeArchiveScope;
  source: AnimeArchiveSource;
  series: AnimeArchiveSeriesRef;
  destination: AnimeArchiveDestination;
  requesterTelegramId: number;
  /** Persisted because a restarted worker cannot reconstruct private operator policy. */
  quotaBypass: boolean;
  episodes: AnimeArchiveJobEpisode[];
  maxAttempts: number;
  state: AnimeArchiveJobState;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  leaseRenewedAt: Date | null;
  claimCount: number;
  leaseRecoveryCount: number;
  resumeCount: number;
  skippedOnCurrentRun: number;
  summary: AnimeArchiveJobSummary | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelledAt: Date | null;
}

export interface CreateAnimeArchiveJobInput {
  scope: AnimeArchiveScope;
  source: AnimeArchiveSource;
  series: AnimeArchiveSeriesRef;
  destination: {
    chatId: number;
    threadId?: number | null | undefined;
    replyToMessageId?: number | null | undefined;
  };
  requesterTelegramId: number;
  quotaBypass?: boolean | undefined;
  episodes: readonly AnimeArchiveEpisodeRef[];
  /** Preferred key for confirmation-created jobs. */
  offerId?: string | null | undefined;
  /** Optional caller key; it is hashed before persistence so arbitrary input is never stored. */
  idempotencyKey?: string | undefined;
  maxAttempts?: number | undefined;
}

export interface CreateAnimeArchiveJobResult {
  created: boolean;
  job: AnimeArchiveJobDoc;
}

export interface MergeAnimeArchiveSeriesSnapshotResult extends CreateAnimeArchiveJobResult {
  /** True when a job was inserted, resumed, or gained at least one episode. */
  changed: boolean;
  /** Number of source ids appended by this snapshot merge. */
  addedEpisodes: number;
  /** True when a terminal/cancelled job was requeued. */
  resumed: boolean;
}

export interface AnimeArchiveEpisodeTransitionResult {
  job: AnimeArchiveJobDoc;
  episode: AnimeArchiveJobEpisode;
  retryScheduled?: boolean | undefined;
}

export interface AnimeArchiveResumeResult {
  resumed: boolean;
  job: AnimeArchiveJobDoc | null;
}

export function sortAnimeArchiveEpisodes(
  episodes: readonly AnimeArchiveEpisodeRef[],
): AnimeArchiveEpisodeRef[] {
  const seen = new Set<string>();
  return episodes
    .map((episode) => {
      const normalized = normalizeEpisode(episode);
      if (seen.has(normalized.id)) {
        throw new Error(`Duplicate anime archive episode id: ${normalized.id}`);
      }
      seen.add(normalized.id);
      return normalized;
    })
    .sort((left, right) => left.number - right.number || left.id.localeCompare(right.id));
}

/** Stable, non-reversible persistence key; raw URLs and caller values are never stored in it. */
export function animeArchiveJobIdempotencyKey(input: CreateAnimeArchiveJobInput): string {
  if (input.idempotencyKey) return `caller:${shortHash(input.idempotencyKey)}`;
  if (input.offerId) return `offer:${normalizeText(input.offerId, 'offerId', 128)}`;
  const episodes = sortAnimeArchiveEpisodes(input.episodes);
  return `target:${shortHash(
    JSON.stringify({
      scope: input.scope,
      source: input.source,
      seriesId: input.series.id,
      chatId: input.destination.chatId,
      threadId: normalizeThreadId(input.destination.threadId),
      episodeIds: episodes.map((episode) => episode.id),
    }),
  )}`;
}

export function summarizeAnimeArchiveEpisodes(
  episodes: readonly AnimeArchiveJobEpisode[],
  skipped = 0,
): AnimeArchiveJobSummary {
  const count = (status: AnimeArchiveEpisodeState): number =>
    episodes.filter((episode) => episode.status === status).length;
  return {
    total: episodes.length,
    completed: count('done'),
    failed: count('failed'),
    pending: count('pending'),
    running: count('running'),
    skipped: Math.max(0, Math.trunc(skipped)),
    failedEpisodes: episodes
      .filter((episode) => episode.status === 'failed')
      .map((episode) => ({
        id: episode.id,
        number: episode.number,
        reason: episode.failureReason ?? 'Unknown failure',
      }))
      .sort((left, right) => left.number - right.number || left.id.localeCompare(right.id)),
  };
}

/** Pure counterpart of the Mongo resume transition: completed rows are never restarted. */
export function resumeAnimeArchiveEpisodes(
  episodes: readonly AnimeArchiveJobEpisode[],
  now: Date,
): AnimeArchiveJobEpisode[] {
  return episodes.map((episode) =>
    episode.status === 'done'
      ? { ...episode }
      : isAnimeArchiveDeliveryUncertain(episode)
        ? deliveryOutcomeUnknownEpisode(episode, now)
        : {
            ...episode,
            status: 'pending',
            attempts: 0,
            receipt: null,
            deliveryToken: null,
            deliveryStartedAt: null,
            deliveryOutcomeUnknown: false,
            failureReason: null,
            startedAt: null,
            completedAt: null,
            updatedAt: now,
          },
  );
}

/** Pure counterpart of lease recovery, retained so safety behavior is regression-testable. */
export function recoverAnimeArchiveEpisodes(
  episodes: readonly AnimeArchiveJobEpisode[],
  maxAttempts: number,
  now: Date,
): AnimeArchiveJobEpisode[] {
  return episodes.map((episode) => {
    if (episode.status !== 'running') return { ...episode };
    if (isAnimeArchiveDeliveryUncertain(episode)) {
      return deliveryOutcomeUnknownEpisode(episode, now);
    }
    if (episode.attempts >= maxAttempts) {
      return {
        ...episode,
        status: 'failed',
        failureReason: 'Worker lease expired after maximum attempts',
        completedAt: now,
        updatedAt: now,
      };
    }
    return {
      ...episode,
      status: 'pending',
      failureReason: 'Worker lease expired; queued for retry',
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
  });
}

export function isAnimeArchiveDeliveryUncertain(episode: AnimeArchiveJobEpisode): boolean {
  return episode.deliveryOutcomeUnknown === true || Boolean(episode.deliveryToken?.trim());
}

function deliveryOutcomeUnknownEpisode(
  episode: AnimeArchiveJobEpisode,
  now: Date,
): AnimeArchiveJobEpisode {
  return {
    ...episode,
    status: 'failed',
    deliveryOutcomeUnknown: true,
    failureReason: ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN,
    completedAt: episode.completedAt ?? now,
    updatedAt: now,
  };
}

/**
 * Pure series-snapshot transition used by the Mongo CAS and in-memory tests. Completed rows and
 * their Telegram receipts are retained byte-for-byte; only non-done rows enter a fresh retry cycle.
 */
export function mergeAnimeArchiveSeriesSnapshot(
  job: AnimeArchiveJobDoc,
  snapshot: readonly AnimeArchiveEpisodeRef[],
  now: Date,
): Omit<MergeAnimeArchiveSeriesSnapshotResult, 'created'> {
  assertValidDate(now, 'now');
  if (job.scope !== 'series') throw new Error('Only series jobs can merge an episode snapshot');
  const normalized = sortAnimeArchiveEpisodes(snapshot);
  const existingIds = new Set(job.episodes.map((episode) => episode.id));
  const missing = normalized.filter((episode) => !existingIds.has(episode.id));
  const hasResumableEpisode = job.episodes.some(
    (episode) => episode.status !== 'done' && !isAnimeArchiveDeliveryUncertain(episode),
  );
  const resumeTerminal =
    ((job.state === 'partial' || job.state === 'failed' || job.state === 'cancelled') &&
      (hasResumableEpisode || missing.length > 0)) ||
    (job.state === 'done' && missing.length > 0);
  const changed = resumeTerminal || missing.length > 0;
  if (!changed) {
    return { changed: false, addedEpisodes: 0, resumed: false, job };
  }

  const maxOrder = job.episodes.reduce((max, episode) => Math.max(max, episode.order), -1);
  const existing = resumeTerminal
    ? job.episodes.map((episode) =>
        episode.status === 'done'
          ? episode
          : isAnimeArchiveDeliveryUncertain(episode)
            ? deliveryOutcomeUnknownEpisode(episode, now)
            : {
                ...episode,
                status: 'pending' as const,
                attempts: 0,
                receipt: null,
                deliveryToken: null,
                deliveryStartedAt: null,
                deliveryOutcomeUnknown: false,
                failureReason: null,
                startedAt: null,
                completedAt: null,
                updatedAt: now,
              },
      )
    : job.episodes;
  const appended: AnimeArchiveJobEpisode[] = missing.map((episode, index) => ({
    ...episode,
    order: maxOrder + index + 1,
    status: 'pending',
    attempts: 0,
    totalAttempts: 0,
    receipt: null,
    deliveryToken: null,
    deliveryStartedAt: null,
    deliveryOutcomeUnknown: false,
    failureReason: null,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
  }));
  const episodes = [...existing, ...appended];
  const next: AnimeArchiveJobDoc = {
    ...job,
    episodes,
    ...(resumeTerminal
      ? {
          state: 'queued' as const,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseRenewedAt: null,
          skippedOnCurrentRun: episodes.filter((episode) => episode.status === 'done').length,
          summary: null,
          finishedAt: null,
          cancelledAt: null,
          resumeCount: job.resumeCount + 1,
        }
      : {}),
    updatedAt: now,
  };
  return {
    changed: true,
    addedEpisodes: appended.length,
    resumed: resumeTerminal,
    job: next,
  };
}

export class AnimeArchiveJobsRepo {
  private readonly col: Collection<AnimeArchiveJobDoc>;

  constructor(
    db: Db,
    private readonly idFactory: () => string = () => opaqueId('aj'),
  ) {
    this.col = db.collection<AnimeArchiveJobDoc>('anime_archive_jobs');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<AnimeArchiveJobDoc>('anime_archive_jobs');
    await col.createIndex({ id: 1 }, { unique: true });
    await col.createIndex({ idempotencyKey: 1 }, { unique: true });
    await col.createIndex(
      { offerId: 1 },
      {
        unique: true,
        partialFilterExpression: { offerId: { $type: 'string' } },
      },
    );
    await col.createIndex({ state: 1, leaseExpiresAt: 1, createdAt: 1 });
    await col.createIndex({ state: 1, finishedAt: -1 });
    await col.createIndex({ 'destination.chatId': 1, state: 1, createdAt: -1 });
    await col.createIndex({ source: 1, 'series.id': 1, createdAt: -1 });
  }

  async create(
    input: CreateAnimeArchiveJobInput,
    now: Date = new Date(),
  ): Promise<CreateAnimeArchiveJobResult> {
    assertValidDate(now, 'now');
    const normalizedEpisodes = sortAnimeArchiveEpisodes(input.episodes);
    if (normalizedEpisodes.length === 0) {
      throw new Error('Anime archive job requires at least one episode');
    }
    if (input.scope === 'episode' && normalizedEpisodes.length !== 1) {
      throw new Error('Single-episode archive job must contain exactly one episode');
    }
    const maxAttempts = clampAttempts(input.maxAttempts ?? 3);
    const idempotencyKey = animeArchiveJobIdempotencyKey(input);
    const job: AnimeArchiveJobDoc = {
      id: this.idFactory(),
      idempotencyKey,
      offerId: input.offerId ? normalizeText(input.offerId, 'offerId', 128) : null,
      scope: input.scope,
      source: input.source,
      series: normalizeSeries(input.series),
      destination: {
        chatId: input.destination.chatId,
        threadId: normalizeThreadId(input.destination.threadId),
        replyToMessageId: input.destination.replyToMessageId ?? null,
      },
      requesterTelegramId: input.requesterTelegramId,
      quotaBypass: input.quotaBypass ?? false,
      episodes: normalizedEpisodes.map((episode, order) => ({
        ...episode,
        order,
        status: 'pending',
        attempts: 0,
        totalAttempts: 0,
        receipt: null,
        deliveryToken: null,
        deliveryStartedAt: null,
        deliveryOutcomeUnknown: false,
        failureReason: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      })),
      maxAttempts,
      state: 'queued',
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseRenewedAt: null,
      claimCount: 0,
      leaseRecoveryCount: 0,
      resumeCount: 0,
      skippedOnCurrentRun: 0,
      summary: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
    };

    const result = await this.col.updateOne(
      { idempotencyKey },
      { $setOnInsert: job },
      { upsert: true },
    );
    const persisted = await this.col.findOne({ idempotencyKey });
    if (!persisted) throw new Error('Anime archive job upsert did not return a document');
    return { created: result.upsertedCount > 0, job: persisted };
  }

  async get(id: string): Promise<AnimeArchiveJobDoc | null> {
    return this.col.findOne({ id });
  }

  async getByOfferId(offerId: string): Promise<AnimeArchiveJobDoc | null> {
    return this.col.findOne({ offerId });
  }

  /**
   * Create the stable series job or atomically CAS-merge a newer source snapshot into it. The CAS
   * includes the complete episode array, so a worker transition can never be overwritten by a
   * concurrent refresh; on contention the merge is recomputed from the new durable state.
   */
  async createOrMergeSeriesSnapshot(
    input: CreateAnimeArchiveJobInput,
    now: Date = new Date(),
  ): Promise<MergeAnimeArchiveSeriesSnapshotResult> {
    if (input.scope !== 'series') {
      throw new Error('Series snapshot merge requires a series job input');
    }
    const initial = await this.create(input, now);
    if (initial.created) {
      return {
        ...initial,
        changed: true,
        addedEpisodes: initial.job.episodes.length,
        resumed: false,
      };
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = attempt === 0 ? initial.job : await this.get(initial.job.id);
      if (!current) throw new Error('Anime archive series job disappeared during snapshot merge');
      const planned = mergeAnimeArchiveSeriesSnapshot(current, input.episodes, now);
      if (!planned.changed) {
        return { created: false, ...planned };
      }
      const merged = await this.col.findOneAndUpdate(
        {
          id: current.id,
          state: current.state,
          updatedAt: current.updatedAt,
          episodes: current.episodes,
          leaseOwner: current.leaseOwner,
          leaseExpiresAt: current.leaseExpiresAt,
          leaseRenewedAt: current.leaseRenewedAt,
        },
        {
          $set: {
            episodes: planned.job.episodes,
            state: planned.job.state,
            leaseOwner: planned.job.leaseOwner,
            leaseExpiresAt: planned.job.leaseExpiresAt,
            leaseRenewedAt: planned.job.leaseRenewedAt,
            skippedOnCurrentRun: planned.job.skippedOnCurrentRun,
            summary: planned.job.summary,
            finishedAt: planned.job.finishedAt,
            cancelledAt: planned.job.cancelledAt,
            resumeCount: planned.job.resumeCount,
            updatedAt: planned.job.updatedAt,
          },
        },
        { returnDocument: 'after' },
      );
      if (merged) {
        return {
          created: false,
          changed: true,
          addedEpisodes: planned.addedEpisodes,
          resumed: planned.resumed,
          job: merged,
        };
      }
    }
    throw new Error('Anime archive series snapshot merge remained contended');
  }

  /** Recent terminal jobs are swept so a restart cannot lose their Telegram summary. */
  async listTerminal(limit = 50, since: Date = new Date(0)): Promise<AnimeArchiveJobDoc[]> {
    assertValidDate(since, 'since');
    const filter: Filter<AnimeArchiveJobDoc> = {
      state: { $in: ['done', 'partial', 'failed'] },
      summary: { $ne: null },
      finishedAt: { $gte: since },
    };
    return this.col.find(filter).sort({ finishedAt: -1, id: 1 }).limit(clampLimit(limit)).toArray();
  }

  /**
   * Atomically leases the oldest queued job, or recovers one whose worker lease expired.
   * Any episode abandoned in `running` is made retryable, unless its bounded attempt budget is
   * exhausted, in which case it becomes a durable failure and later episodes can still proceed.
   */
  async claimNextJob(
    workerId: string,
    leaseMs: number,
    now: Date = new Date(),
  ): Promise<AnimeArchiveJobDoc | null> {
    const owner = normalizeText(workerId, 'workerId', 128);
    const leaseExpiresAt = futureLease(now, leaseMs);
    const filter: Filter<AnimeArchiveJobDoc> = {
      $or: [
        { state: 'queued' },
        {
          state: 'running',
          $or: [{ leaseExpiresAt: { $lte: now } }, { leaseExpiresAt: null }],
        },
      ],
    };
    const pipeline: Document[] = [
      {
        $set: {
          episodes: recoverRunningEpisodesExpression(now),
          leaseRecoveryCount: {
            $add: [
              { $ifNull: ['$leaseRecoveryCount', 0] },
              { $cond: [{ $eq: ['$state', 'running'] }, 1, 0] },
            ],
          },
          state: 'running',
          leaseOwner: owner,
          leaseExpiresAt,
          leaseRenewedAt: now,
          claimCount: { $add: [{ $ifNull: ['$claimCount', 0] }, 1] },
          startedAt: { $ifNull: ['$startedAt', now] },
          updatedAt: now,
        },
      },
    ];
    return this.col.findOneAndUpdate(filter, pipeline, {
      sort: { createdAt: 1, id: 1 },
      returnDocument: 'after',
    });
  }

  async renewLease(
    id: string,
    workerId: string,
    leaseMs: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.col.updateOne(
      {
        id,
        state: 'running',
        leaseOwner: workerId,
        leaseExpiresAt: { $gt: now },
      },
      {
        $set: {
          leaseExpiresAt: futureLease(now, leaseMs),
          leaseRenewedAt: now,
          updatedAt: now,
        },
      },
    );
    return result.modifiedCount > 0;
  }

  /** Claims exactly one row; the no-running-row predicate keeps default concurrency at one. */
  async claimNextEpisode(
    id: string,
    workerId: string,
    now: Date = new Date(),
  ): Promise<AnimeArchiveEpisodeTransitionResult | null> {
    const filter: Filter<AnimeArchiveJobDoc> = {
      id,
      state: 'running',
      leaseOwner: workerId,
      leaseExpiresAt: { $gt: now },
      'episodes.status': 'pending',
      episodes: { $not: { $elemMatch: { status: 'running' } } },
    };
    const job = await this.col.findOneAndUpdate(
      filter,
      {
        $set: {
          'episodes.$.status': 'running',
          'episodes.$.startedAt': now,
          'episodes.$.completedAt': null,
          'episodes.$.updatedAt': now,
          updatedAt: now,
        },
        $inc: {
          'episodes.$.attempts': 1,
          'episodes.$.totalAttempts': 1,
        },
      },
      { returnDocument: 'after' },
    );
    if (!job) return null;
    const episode = job.episodes.find((entry) => entry.status === 'running');
    if (!episode) throw new Error('Claimed anime archive job has no running episode');
    return { job, episode };
  }

  /** Persist the at-most-once delivery latch immediately before invoking Telegram. */
  async beginEpisodeDelivery(
    id: string,
    episodeId: string,
    workerId: string,
    deliveryToken: string,
    now: Date = new Date(),
  ): Promise<AnimeArchiveEpisodeTransitionResult | null> {
    const token = normalizeText(deliveryToken, 'deliveryToken', 128);
    const job = await this.col.findOneAndUpdate(
      {
        ...activeEpisodeFilter(id, episodeId, workerId, now),
        episodes: {
          $elemMatch: {
            id: episodeId,
            status: 'running',
            receipt: null,
            deliveryToken: null,
            deliveryOutcomeUnknown: { $ne: true },
          },
        },
      },
      {
        $set: {
          'episodes.$.deliveryToken': token,
          'episodes.$.deliveryStartedAt': now,
          'episodes.$.deliveryOutcomeUnknown': false,
          'episodes.$.updatedAt': now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after', writeConcern: DURABLE_DELIVERY_WRITE_CONCERN },
    );
    return episodeTransition(job, episodeId);
  }

  /** Telegram explicitly rejected the request, so the marker may safely be rolled back. */
  async abortEpisodeDelivery(
    id: string,
    episodeId: string,
    workerId: string,
    deliveryToken: string,
    now: Date = new Date(),
  ): Promise<AnimeArchiveEpisodeTransitionResult | null> {
    const token = normalizeText(deliveryToken, 'deliveryToken', 128);
    const job = await this.col.findOneAndUpdate(
      activeDeliveryFilter(id, episodeId, workerId, token, now),
      {
        $set: {
          'episodes.$.deliveryToken': null,
          'episodes.$.deliveryStartedAt': null,
          'episodes.$.deliveryOutcomeUnknown': false,
          'episodes.$.updatedAt': now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after', writeConcern: DURABLE_DELIVERY_WRITE_CONCERN },
    );
    return episodeTransition(job, episodeId);
  }

  /** Terminalize an ambiguous transport/persistence outcome without allowing an automatic resend. */
  async markEpisodeDeliveryUnknown(
    id: string,
    episodeId: string,
    workerId: string,
    deliveryToken: string,
    now: Date = new Date(),
  ): Promise<AnimeArchiveEpisodeTransitionResult | null> {
    const token = normalizeText(deliveryToken, 'deliveryToken', 128);
    const job = await this.col.findOneAndUpdate(
      activeDeliveryFilter(id, episodeId, workerId, token, now),
      {
        $set: {
          'episodes.$.status': 'failed',
          'episodes.$.deliveryOutcomeUnknown': true,
          'episodes.$.failureReason': ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN,
          'episodes.$.completedAt': now,
          'episodes.$.updatedAt': now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after', writeConcern: DURABLE_DELIVERY_WRITE_CONCERN },
    );
    return episodeTransition(job, episodeId);
  }

  async completeEpisode(
    id: string,
    episodeId: string,
    workerId: string,
    deliveryToken: string,
    receipt: AnimeArchiveTelegramReceipt,
    now: Date = new Date(),
  ): Promise<AnimeArchiveEpisodeTransitionResult | null> {
    const token = normalizeText(deliveryToken, 'deliveryToken', 128);
    const job = await this.col.findOneAndUpdate(
      activeDeliveryFilter(id, episodeId, workerId, token, now),
      {
        $set: {
          'episodes.$.status': 'done',
          'episodes.$.receipt': normalizeReceipt(receipt),
          'episodes.$.deliveryToken': null,
          'episodes.$.deliveryStartedAt': null,
          'episodes.$.deliveryOutcomeUnknown': false,
          'episodes.$.failureReason': null,
          'episodes.$.completedAt': now,
          'episodes.$.updatedAt': now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after', writeConcern: DURABLE_DELIVERY_WRITE_CONCERN },
    );
    return episodeTransition(job, episodeId);
  }

  /**
   * Records a failure atomically. Retryable rows return to pending only while attempts remain;
   * permanent/exhausted failures stay failed so the next episode can be claimed.
   */
  async failEpisode(
    id: string,
    episodeId: string,
    workerId: string,
    reason: string,
    retryable: boolean,
    now: Date = new Date(),
  ): Promise<AnimeArchiveEpisodeTransitionResult | null> {
    const current = await this.get(id);
    const episode = current?.episodes.find((entry) => entry.id === episodeId);
    if (!current || !episode || episode.status !== 'running') return null;
    if (isAnimeArchiveDeliveryUncertain(episode)) return null;
    const retryScheduled = retryable && episode.attempts < current.maxAttempts;
    const status: AnimeArchiveEpisodeState = retryScheduled ? 'pending' : 'failed';
    const filter: Filter<AnimeArchiveJobDoc> = {
      ...activeEpisodeFilter(id, episodeId, workerId, now),
      episodes: {
        $elemMatch: {
          id: episodeId,
          status: 'running',
          attempts: episode.attempts,
          deliveryToken: null,
          deliveryOutcomeUnknown: { $ne: true },
        },
      },
    };
    const job = await this.col.findOneAndUpdate(
      filter,
      {
        $set: {
          'episodes.$.status': status,
          'episodes.$.failureReason': safeFailureReason(reason),
          'episodes.$.completedAt': retryScheduled ? null : now,
          'episodes.$.updatedAt': now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
    const transitioned = episodeTransition(job, episodeId);
    return transitioned ? { ...transitioned, retryScheduled } : null;
  }

  /**
   * A source-layout break affects the whole series. Atomically terminalize every untouched row so
   * the worker can finalize instead of hammering the same broken parser for every episode.
   */
  async failPendingEpisodes(
    id: string,
    workerId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<AnimeArchiveJobDoc | null> {
    const failureReason = safeFailureReason(reason);
    return this.col.findOneAndUpdate(
      {
        id,
        state: 'running',
        leaseOwner: workerId,
        leaseExpiresAt: { $gt: now },
      },
      [
        {
          $set: {
            episodes: {
              $map: {
                input: '$episodes',
                as: 'episode',
                in: {
                  $cond: [
                    { $eq: ['$$episode.status', 'pending'] },
                    {
                      $mergeObjects: [
                        '$$episode',
                        {
                          status: 'failed',
                          failureReason,
                          completedAt: now,
                          updatedAt: now,
                        },
                      ],
                    },
                    '$$episode',
                  ],
                },
              },
            },
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );
  }

  /** Finalizes only after every episode reached done/failed and only for the active lease owner. */
  async finalizeJob(
    id: string,
    workerId: string,
    now: Date = new Date(),
  ): Promise<AnimeArchiveJobDoc | null> {
    const current = await this.get(id);
    if (!current) return null;
    if (current.state === 'done' || current.state === 'partial' || current.state === 'failed') {
      return current;
    }
    const summary = summarizeAnimeArchiveEpisodes(current.episodes, current.skippedOnCurrentRun);
    if (summary.pending > 0 || summary.running > 0 || current.state !== 'running') return null;
    const state: AnimeArchiveJobState =
      summary.failed === 0 ? 'done' : summary.completed > 0 ? 'partial' : 'failed';
    return this.col.findOneAndUpdate(
      {
        id,
        state: 'running',
        leaseOwner: workerId,
        leaseExpiresAt: { $gt: now },
        $nor: [{ 'episodes.status': 'pending' }, { 'episodes.status': 'running' }],
      },
      {
        $set: {
          state,
          summary,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseRenewedAt: null,
          finishedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
  }

  /** Graceful worker shutdown: make the job immediately claimable by another worker. */
  async releaseJob(id: string, workerId: string, now: Date = new Date()): Promise<boolean> {
    const result = await this.col.updateOne({ id, state: 'running', leaseOwner: workerId }, [
      {
        $set: {
          episodes: recoverRunningEpisodesExpression(now),
          state: 'queued',
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseRenewedAt: null,
          updatedAt: now,
        },
      },
    ]);
    return result.modifiedCount > 0;
  }

  /** Durable cancellation. Done rows stay done; an interrupted row becomes resumable. */
  async cancelJob(id: string, now: Date = new Date()): Promise<AnimeArchiveJobDoc | null> {
    return this.col.findOneAndUpdate(
      { id, state: { $in: ['queued', 'running'] } },
      [
        {
          $set: {
            episodes: {
              $map: {
                input: '$episodes',
                as: 'episode',
                in: {
                  $cond: [
                    { $eq: ['$$episode.status', 'running'] },
                    {
                      $cond: [
                        {
                          $or: [
                            {
                              $ne: [{ $ifNull: ['$$episode.deliveryToken', null] }, null],
                            },
                            {
                              $eq: [{ $ifNull: ['$$episode.deliveryOutcomeUnknown', false] }, true],
                            },
                          ],
                        },
                        {
                          $mergeObjects: [
                            '$$episode',
                            {
                              status: 'failed',
                              deliveryOutcomeUnknown: true,
                              failureReason: ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN,
                              completedAt: now,
                              updatedAt: now,
                            },
                          ],
                        },
                        {
                          $mergeObjects: [
                            '$$episode',
                            {
                              status: 'pending',
                              deliveryToken: null,
                              deliveryStartedAt: null,
                              deliveryOutcomeUnknown: false,
                              startedAt: null,
                              completedAt: null,
                              updatedAt: now,
                            },
                          ],
                        },
                      ],
                    },
                    '$$episode',
                  ],
                },
              },
            },
            state: 'cancelled',
            leaseOwner: null,
            leaseExpiresAt: null,
            leaseRenewedAt: null,
            cancelledAt: now,
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );
  }

  /**
   * Requeues a terminal/cancelled job without touching completed episodes. Failed/interrupted rows
   * get a fresh bounded attempt cycle while `totalAttempts` keeps their lifetime history.
   */
  async resumeJob(id: string, now: Date = new Date()): Promise<AnimeArchiveResumeResult> {
    const job = await this.col.findOneAndUpdate(
      { id, state: { $in: ['cancelled', 'partial', 'failed'] } },
      [
        {
          $set: {
            skippedOnCurrentRun: {
              $size: {
                $filter: {
                  input: '$episodes',
                  as: 'episode',
                  cond: { $eq: ['$$episode.status', 'done'] },
                },
              },
            },
            episodes: {
              $map: {
                input: '$episodes',
                as: 'episode',
                in: {
                  $cond: [
                    { $eq: ['$$episode.status', 'done'] },
                    '$$episode',
                    {
                      $cond: [
                        {
                          $or: [
                            {
                              $ne: [{ $ifNull: ['$$episode.deliveryToken', null] }, null],
                            },
                            {
                              $eq: [{ $ifNull: ['$$episode.deliveryOutcomeUnknown', false] }, true],
                            },
                          ],
                        },
                        {
                          $mergeObjects: [
                            '$$episode',
                            {
                              status: 'failed',
                              deliveryOutcomeUnknown: true,
                              failureReason: ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN,
                              completedAt: { $ifNull: ['$$episode.completedAt', now] },
                              updatedAt: now,
                            },
                          ],
                        },
                        {
                          $mergeObjects: [
                            '$$episode',
                            {
                              status: 'pending',
                              attempts: 0,
                              receipt: null,
                              deliveryToken: null,
                              deliveryStartedAt: null,
                              deliveryOutcomeUnknown: false,
                              failureReason: null,
                              startedAt: null,
                              completedAt: null,
                              updatedAt: now,
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            state: 'queued',
            leaseOwner: null,
            leaseExpiresAt: null,
            leaseRenewedAt: null,
            summary: null,
            finishedAt: null,
            cancelledAt: null,
            resumeCount: { $add: [{ $ifNull: ['$resumeCount', 0] }, 1] },
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );
    if (job) return { resumed: true, job };
    return { resumed: false, job: await this.get(id) };
  }
}

/** Storage facade for the two collections; kept adapter-independent on purpose. */
export class AnimeArchiveRepo {
  readonly offers: AnimeArchiveOffersRepo;
  readonly searches: AnimeArchiveSearchSessionsRepo;
  readonly jobs: AnimeArchiveJobsRepo;

  constructor(db: Db) {
    this.offers = new AnimeArchiveOffersRepo(db);
    this.searches = new AnimeArchiveSearchSessionsRepo(db);
    this.jobs = new AnimeArchiveJobsRepo(db);
  }

  static async ensureIndexes(db: Db): Promise<void> {
    await AnimeArchiveOffersRepo.ensureIndexes(db);
    await AnimeArchiveSearchSessionsRepo.ensureIndexes(db);
    await AnimeArchiveJobsRepo.ensureIndexes(db);
  }
}

function activeEpisodeFilter(
  id: string,
  episodeId: string,
  workerId: string,
  now: Date,
): Filter<AnimeArchiveJobDoc> {
  return {
    id,
    state: 'running',
    leaseOwner: workerId,
    leaseExpiresAt: { $gt: now },
    episodes: { $elemMatch: { id: episodeId, status: 'running' } },
  };
}

function activeDeliveryFilter(
  id: string,
  episodeId: string,
  workerId: string,
  deliveryToken: string,
  now: Date,
): Filter<AnimeArchiveJobDoc> {
  return {
    id,
    state: 'running',
    leaseOwner: workerId,
    leaseExpiresAt: { $gt: now },
    episodes: {
      $elemMatch: {
        id: episodeId,
        status: 'running',
        deliveryToken,
        deliveryOutcomeUnknown: { $ne: true },
      },
    },
  };
}

function episodeTransition(
  job: AnimeArchiveJobDoc | null,
  episodeId: string,
): AnimeArchiveEpisodeTransitionResult | null {
  if (!job) return null;
  const episode = job.episodes.find((entry) => entry.id === episodeId);
  return episode ? { job, episode } : null;
}

function recoverRunningEpisodesExpression(now: Date): Document {
  return {
    $map: {
      input: '$episodes',
      as: 'episode',
      in: {
        $cond: [
          { $eq: ['$$episode.status', 'running'] },
          {
            $cond: [
              {
                $or: [
                  {
                    $ne: [{ $ifNull: ['$$episode.deliveryToken', null] }, null],
                  },
                  {
                    $eq: [{ $ifNull: ['$$episode.deliveryOutcomeUnknown', false] }, true],
                  },
                ],
              },
              {
                $mergeObjects: [
                  '$$episode',
                  {
                    status: 'failed',
                    deliveryOutcomeUnknown: true,
                    failureReason: ANIME_ARCHIVE_DELIVERY_OUTCOME_UNKNOWN,
                    completedAt: now,
                    updatedAt: now,
                  },
                ],
              },
              {
                $cond: [
                  {
                    $gte: ['$$episode.attempts', { $ifNull: ['$maxAttempts', 3] }],
                  },
                  {
                    $mergeObjects: [
                      '$$episode',
                      {
                        status: 'failed',
                        failureReason: 'Worker lease expired after maximum attempts',
                        completedAt: now,
                        updatedAt: now,
                      },
                    ],
                  },
                  {
                    $mergeObjects: [
                      '$$episode',
                      {
                        status: 'pending',
                        failureReason: 'Worker lease expired; queued for retry',
                        startedAt: null,
                        completedAt: null,
                        updatedAt: now,
                      },
                    ],
                  },
                ],
              },
            ],
          },
          '$$episode',
        ],
      },
    },
  };
}

function normalizeTarget(target: AnimeArchiveTarget): AnimeArchiveTarget {
  const series = normalizeSeries(target.series);
  return target.kind === 'episode'
    ? { kind: 'episode', series, episode: normalizeEpisode(target.episode) }
    : { kind: 'series', series };
}

function normalizeSeries(series: AnimeArchiveSeriesRef): AnimeArchiveSeriesRef {
  return {
    id: normalizeText(series.id, 'series.id', 256),
    canonicalUrl: normalizeCanonicalUrl(series.canonicalUrl),
    title: normalizeText(series.title, 'series.title', 512),
  };
}

function normalizeEpisode(episode: AnimeArchiveEpisodeRef): AnimeArchiveEpisodeRef {
  if (!Number.isFinite(episode.number) || episode.number < 0) {
    throw new Error('Anime archive episode number must be a finite non-negative number');
  }
  return {
    id: normalizeText(episode.id, 'episode.id', 256),
    number: episode.number,
    canonicalUrl: normalizeCanonicalUrl(episode.canonicalUrl),
    ...(episode.title ? { title: normalizeText(episode.title, 'episode.title', 512) } : {}),
  };
}

function normalizeCanonicalUrl(value: string): string {
  const parsed = new URL(normalizeText(value, 'canonicalUrl', 4_096));
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Anime archive canonical URL must use http(s)');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Anime archive canonical URL must not contain credentials');
  }
  parsed.hash = '';
  return parsed.toString();
}

function normalizeReceipt(receipt: AnimeArchiveTelegramReceipt): AnimeArchiveTelegramReceipt {
  const messageIds = receipt.messageIds
    ?.filter((value) => Number.isSafeInteger(value) && value > 0)
    .slice(0, 64);
  const fileIds = receipt.fileIds
    ?.filter((value) => Boolean(value?.trim()))
    .slice(0, 64)
    .map((value) => normalizeText(value, 'fileId', 512));
  return {
    chatId: receipt.chatId,
    messageId: receipt.messageId,
    ...(messageIds?.length ? { messageIds } : {}),
    ...(receipt.fileId ? { fileId: normalizeText(receipt.fileId, 'fileId', 512) } : {}),
    ...(fileIds?.length ? { fileIds } : {}),
    ...(receipt.fileUniqueId
      ? { fileUniqueId: normalizeText(receipt.fileUniqueId, 'fileUniqueId', 512) }
      : {}),
    ...(receipt.mediaKind ? { mediaKind: receipt.mediaKind } : {}),
  };
}

function normalizeText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${label} is too long`);
  return normalized;
}

function normalizeThreadId(value: number | null | undefined): number | null {
  return value ?? null;
}

function safeFailureReason(value: string): string {
  const normalized = value.trim() || 'Unknown failure';
  const withoutUrlQueries = normalized.replace(/\bhttps?:\/\/[^\s]+/giu, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return '[redacted-url]';
    }
  });
  return withoutUrlQueries.slice(0, 1_000);
}

function futureLease(now: Date, leaseMs: number): Date {
  assertValidDate(now, 'now');
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error('Anime archive lease must be a positive duration');
  }
  return new Date(now.getTime() + Math.trunc(leaseMs));
}

function clampAttempts(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('Anime archive maxAttempts must be positive');
  }
  return Math.min(20, Math.trunc(value));
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid date`);
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return Number((error as { code?: unknown }).code) === 11_000;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 32);
}
