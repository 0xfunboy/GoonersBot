import type { Collection, Db } from 'mongodb';
import type { AnimeArchiveSource } from '../../anime/archive/types.js';
import type { AnimeCatalogSource } from '../../anime/types.js';

/**
 * A chat's subscription to one series.
 *
 * `lastNotifiedEpisode` is the de-duplication anchor: it is persisted, so a scheduler restart
 * cannot re-announce an episode the chat already received.
 */
export interface AnimeFollowDoc {
  chatId: number;
  /** Forum topic the follow was created in, so notifications land in the same thread. */
  threadId?: number | undefined;
  source: AnimeCatalogSource;
  sourceId: string;
  /** Denormalized for listing follows without a catalog join. */
  title: string;
  createdByHandle: string;
  createdAt: Date;
  /** Highest episode already announced to this chat; -1 means "nothing announced yet". */
  lastNotifiedEpisode: number;
  /** Downloadable-source identity; deliberately independent from the metadata catalog id. */
  archiveSource?: AnimeArchiveSource | undefined;
  archiveSeriesId?: string | undefined;
  /** Highest episode announced after it was observed on AnimeUnity/HentaiSaturn. */
  archiveLastNotifiedEpisode?: number | undefined;
  lastCheckedAt?: Date | undefined;
}

/** Never announced anything yet. Distinct from 0, which means "episode 0 was announced". */
export const NEVER_NOTIFIED = -1;

export class AnimeFollowsRepo {
  private readonly col: Collection<AnimeFollowDoc>;

  constructor(db: Db) {
    this.col = db.collection<AnimeFollowDoc>('anime_follows');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<AnimeFollowDoc>('anime_follows');
    await col.createIndex({ chatId: 1, source: 1, sourceId: 1 }, { unique: true });
    // Poller path: pick the least recently checked series across all chats.
    await col.createIndex({ source: 1, sourceId: 1, lastCheckedAt: 1 });
  }

  async countForChat(chatId: number): Promise<number> {
    return this.col.countDocuments({ chatId });
  }

  async listForChat(chatId: number, limit = 100): Promise<AnimeFollowDoc[]> {
    return this.col.find({ chatId }).sort({ createdAt: 1 }).limit(limit).toArray();
  }

  async get(
    chatId: number,
    source: AnimeCatalogSource,
    sourceId: string,
  ): Promise<AnimeFollowDoc | null> {
    return this.col.findOne({ chatId, source, sourceId });
  }

  /**
   * Create a follow, seeded at the episode already aired.
   *
   * Seeding matters: a chat that starts following a show at episode 8 must not immediately be
   * told that episodes 1-8 are "new". Re-following an existing series is a no-op that keeps the
   * previous notification watermark.
   */
  async follow(
    follow: Omit<AnimeFollowDoc, 'createdAt' | 'lastNotifiedEpisode'> & {
      seedEpisode?: number | undefined;
    },
    now: Date = new Date(),
  ): Promise<{ created: boolean }> {
    const { seedEpisode, ...rest } = follow;
    const result = await this.col.updateOne(
      { chatId: rest.chatId, source: rest.source, sourceId: rest.sourceId },
      {
        $set: { title: rest.title, threadId: rest.threadId ?? undefined },
        $setOnInsert: {
          chatId: rest.chatId,
          source: rest.source,
          sourceId: rest.sourceId,
          createdByHandle: rest.createdByHandle,
          createdAt: now,
          lastNotifiedEpisode:
            seedEpisode !== undefined && Number.isFinite(seedEpisode)
              ? Math.trunc(seedEpisode)
              : NEVER_NOTIFIED,
        },
      },
      { upsert: true },
    );
    return { created: result.upsertedCount > 0 };
  }

  async unfollow(chatId: number, source: AnimeCatalogSource, sourceId: string): Promise<boolean> {
    const result = await this.col.deleteOne({ chatId, source, sourceId });
    return result.deletedCount > 0;
  }

  /** Distinct series that any chat follows, least recently checked first. */
  async listSeriesToPoll(
    limit: number,
  ): Promise<Array<{ source: AnimeCatalogSource; sourceId: string; title: string }>> {
    const rows = await this.col
      .aggregate<{
        _id: { source: AnimeCatalogSource; sourceId: string };
        oldest: Date | null;
        title: string;
      }>([
        {
          $group: {
            _id: { source: '$source', sourceId: '$sourceId' },
            oldest: { $min: '$lastCheckedAt' },
            title: { $first: '$title' },
          },
        },
        { $sort: { oldest: 1 } },
        { $limit: Math.max(1, limit) },
      ])
      .toArray();
    return rows.map((row) => ({
      source: row._id.source,
      sourceId: row._id.sourceId,
      title: row.title,
    }));
  }

  async markChecked(
    source: AnimeCatalogSource,
    sourceId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.col.updateMany({ source, sourceId }, { $set: { lastCheckedAt: now } });
  }

  /**
   * Atomically claim the right to announce `episode` to each subscribed chat.
   *
   * The conditional update *is* the lock: only the caller whose write matched
   * `lastNotifiedEpisode < episode` gets the document back, so concurrent ticks and restarted
   * schedulers can race freely without any chat receiving two notifications.
   *
   * The returned documents are the *pre-update* ones, so `lastNotifiedEpisode` is the watermark
   * to restore via `releaseClaim` if delivery then fails.
   */
  async claimNotifications(
    source: AnimeCatalogSource,
    sourceId: string,
    episode: number,
  ): Promise<AnimeFollowDoc[]> {
    if (!Number.isFinite(episode)) return [];
    const target = episode;
    const claimed: AnimeFollowDoc[] = [];
    const pending = await this.col
      .find({ source, sourceId, lastNotifiedEpisode: { $lt: target } })
      .toArray();
    for (const follow of pending) {
      const result = await this.col.findOneAndUpdate(
        {
          chatId: follow.chatId,
          source,
          sourceId,
          lastNotifiedEpisode: { $lt: target },
        },
        { $set: { lastNotifiedEpisode: target } },
        { returnDocument: 'before' },
      );
      if (result) claimed.push(result);
    }
    return claimed;
  }

  /**
   * Claim notifications using only a downloadable archive source.
   *
   * Existing follows are migrated lazily: the first AU/HS observation seeds the current episode
   * without announcing old content. This also repairs legacy AniList watermarks that advanced
   * before the episode actually appeared on a rehostable source.
   */
  async claimArchiveNotifications(
    source: AnimeCatalogSource,
    sourceId: string,
    archiveSource: AnimeArchiveSource,
    archiveSeriesId: string,
    episode: number,
  ): Promise<AnimeFollowDoc[]> {
    if (!Number.isFinite(episode)) return [];
    const target = Math.trunc(episode);
    const catalogFilter = { source, sourceId };
    await this.col.updateMany(
      {
        ...catalogFilter,
        $or: [
          { archiveSource: { $exists: false } },
          { archiveSeriesId: { $exists: false } },
          { archiveLastNotifiedEpisode: { $exists: false } },
          { archiveSource: { $ne: archiveSource } },
          { archiveSeriesId: { $ne: archiveSeriesId } },
        ],
      },
      {
        $set: {
          archiveSource,
          archiveSeriesId,
          archiveLastNotifiedEpisode: target,
        },
      },
    );

    const claimed: AnimeFollowDoc[] = [];
    const pending = await this.col
      .find({
        ...catalogFilter,
        archiveSource,
        archiveSeriesId,
        archiveLastNotifiedEpisode: { $lt: target },
      })
      .toArray();
    for (const follow of pending) {
      const result = await this.col.findOneAndUpdate(
        {
          chatId: follow.chatId,
          ...catalogFilter,
          archiveSource,
          archiveSeriesId,
          archiveLastNotifiedEpisode: { $lt: target },
        },
        { $set: { archiveLastNotifiedEpisode: target } },
        { returnDocument: 'before' },
      );
      if (result) claimed.push(result);
    }
    return claimed;
  }

  /** Release a claim when the notification could not be delivered, so the next tick retries. */
  async releaseClaim(
    chatId: number,
    source: AnimeCatalogSource,
    sourceId: string,
    previousEpisode: number,
  ): Promise<void> {
    await this.col.updateOne(
      { chatId, source, sourceId },
      { $set: { lastNotifiedEpisode: Math.trunc(previousEpisode) } },
    );
  }

  /** Release only the exact AU/HS claim; a newer concurrent watermark is never moved backwards. */
  async releaseArchiveClaim(
    chatId: number,
    source: AnimeCatalogSource,
    sourceId: string,
    archiveSource: AnimeArchiveSource,
    archiveSeriesId: string,
    claimedEpisode: number,
    previousEpisode: number,
  ): Promise<void> {
    await this.col.updateOne(
      {
        chatId,
        source,
        sourceId,
        archiveSource,
        archiveSeriesId,
        archiveLastNotifiedEpisode: Math.trunc(claimedEpisode),
      },
      { $set: { archiveLastNotifiedEpisode: previousEpisode } },
    );
  }

  /** Drop every follow belonging to a chat (used when the bot is removed from it). */
  async deleteForChat(chatId: number): Promise<number> {
    const result = await this.col.deleteMany({ chatId });
    return result.deletedCount ?? 0;
  }
}
