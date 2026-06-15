import type { Collection, Db } from 'mongodb';
import type { MessageDoc } from '../../domain/entities.js';
import type { TranscribedMessage } from '../../domain/types.js';

export interface StoredMessage {
  messageId?: number | null;
  handle: string;
  isBot: boolean;
  replyToHandle?: string | null;
  message: TranscribedMessage;
}

export interface AddMessageMeta {
  messageId?: number | null;
  telegramId?: number | null;
  replyToMessageId?: number | null;
  replyToHandle?: string | null;
  mentionedHandles?: string[];
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

  async add(
    chatId: number,
    handle: string,
    isBot: boolean,
    message: TranscribedMessage,
    meta: AddMessageMeta = {},
  ): Promise<void> {
    const now = new Date();
    await this.col.insertOne({
      chatId,
      messageId: meta.messageId ?? null,
      userHandle: handle,
      telegramId: meta.telegramId ?? null,
      isBot,
      messageText: message.messageText,
      imageDescription: message.imageDescription ?? null,
      voiceDescription: message.voiceDescription ?? null,
      replyToMessageId: meta.replyToMessageId ?? null,
      replyToHandle: meta.replyToHandle ?? null,
      mentionedHandles: meta.mentionedHandles ?? [],
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
    return docs.reverse().map((d) => this.toStored(d));
  }

  private toStored(d: MessageDoc): StoredMessage {
    return {
      messageId: d.messageId ?? null,
      handle: d.userHandle,
      isBot: d.isBot,
      replyToHandle: d.replyToHandle ?? null,
      message: {
        messageText: d.messageText,
        timestamp: d.timestamp,
        imageDescription: d.imageDescription ?? null,
        voiceDescription: d.voiceDescription ?? null,
      },
    };
  }

  /**
   * Window around a specific message id: `before` messages before it, the message itself, and
   * `after` messages after it (chronological). Falls back to recent if the id isn't stored.
   */
  async getWindowAroundMessage(
    chatId: number,
    messageId: number,
    before: number,
    after: number,
  ): Promise<StoredMessage[]> {
    const center = await this.col.findOne({ chatId, messageId });
    if (!center) return this.getRecent(chatId, before + after + 1);
    const beforeDocs = await this.col
      .find({ chatId, timestamp: { $lte: center.timestamp } })
      .sort({ timestamp: -1, _id: -1 })
      .limit(before + 1)
      .toArray();
    const afterDocs = await this.col
      .find({ chatId, timestamp: { $gt: center.timestamp } })
      .sort({ timestamp: 1, _id: 1 })
      .limit(after)
      .toArray();
    return [...beforeDocs.reverse(), ...afterDocs].map((d) => this.toStored(d));
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
