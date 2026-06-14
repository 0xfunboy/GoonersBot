import type { Collection, Db } from 'mongodb';
import type { MessageDoc } from '../../domain/entities.js';
import type { TranscribedMessage } from '../../domain/types.js';

export interface StoredMessage {
  handle: string;
  isBot: boolean;
  message: TranscribedMessage;
}

export class MessagesRepo {
  private readonly col: Collection<MessageDoc>;

  constructor(
    db: Db,
    private readonly maxStoredPerChat: number,
    private readonly retentionDays: number,
  ) {
    this.col = db.collection<MessageDoc>('messages');
  }

  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ chatId: 1, timestamp: -1 });
    await this.col.createIndex({ chatId: 1 });
    await this.col.createIndex({ userHandle: 1 });
    if (this.retentionDays > 0) {
      // TTL index on createdAt — Mongo expires raw history after retentionDays.
      const seconds = this.retentionDays * 24 * 60 * 60;
      await this.recreateTtlIndex(seconds);
    }
  }

  /** Recreate TTL index if expiry changed (Mongo can't modify expireAfterSeconds in place across all versions). */
  private async recreateTtlIndex(seconds: number): Promise<void> {
    const indexes = await this.col.indexes();
    const existing = indexes.find((i) => i.name === 'goonerbot_ttl_createdAt');
    if (existing && existing.expireAfterSeconds !== seconds) {
      await this.col.dropIndex('goonerbot_ttl_createdAt');
    }
    await this.col.createIndex(
      { createdAt: 1 },
      { name: 'goonerbot_ttl_createdAt', expireAfterSeconds: seconds },
    );
  }

  async add(chatId: number, handle: string, isBot: boolean, message: TranscribedMessage): Promise<void> {
    const now = new Date();
    await this.col.insertOne({
      chatId,
      userHandle: handle,
      isBot,
      messageText: message.messageText,
      imageDescription: message.imageDescription ?? null,
      voiceDescription: message.voiceDescription ?? null,
      timestamp: message.timestamp,
      createdAt: now,
    });
    await this.enforceCap(chatId);
  }

  /** Trim a chat's stored messages to the configured cap (delete oldest). */
  private async enforceCap(chatId: number): Promise<void> {
    if (this.maxStoredPerChat <= 0) return;
    const count = await this.col.countDocuments({ chatId });
    if (count <= this.maxStoredPerChat) return;
    const toDelete = count - this.maxStoredPerChat;
    const oldest = await this.col
      .find({ chatId }, { projection: { _id: 1 } })
      .sort({ timestamp: 1, _id: 1 })
      .limit(toDelete)
      .toArray();
    if (oldest.length > 0) {
      await this.col.deleteMany({ _id: { $in: oldest.map((d) => d._id) } });
    }
  }

  /** Return the last N messages in chronological order. */
  async getRecent(chatId: number, limit: number): Promise<StoredMessage[]> {
    const docs = await this.col
      .find({ chatId })
      .sort({ timestamp: -1, _id: -1 })
      .limit(limit)
      .toArray();
    return docs.reverse().map((d) => ({
      handle: d.userHandle,
      isBot: d.isBot,
      message: {
        messageText: d.messageText,
        timestamp: d.timestamp,
        imageDescription: d.imageDescription ?? null,
        voiceDescription: d.voiceDescription ?? null,
      },
    }));
  }

  async reset(chatId: number): Promise<void> {
    await this.col.deleteMany({ chatId });
  }

  async deleteByUser(handle: string): Promise<void> {
    await this.col.deleteMany({ userHandle: handle });
  }

  /** Manual retention sweep (in case TTL is disabled or for immediate cleanup). */
  async purgeOlderThan(date: Date): Promise<number> {
    const res = await this.col.deleteMany({ createdAt: { $lt: date } });
    return res.deletedCount;
  }
}
