import type { Collection, Db } from 'mongodb';
import type { ConversationThreadDoc } from '../../domain/entities.js';

export class ConversationThreadsRepo {
  private readonly col: Collection<ConversationThreadDoc>;

  constructor(db: Db) {
    this.col = db.collection<ConversationThreadDoc>('conversation_threads');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<ConversationThreadDoc>('conversation_threads');
    await col.createIndex({ chatId: 1, threadId: 1 }, { unique: true });
    await col.createIndex({ chatId: 1, status: 1, updatedAt: -1 });
    await col.createIndex({ chatId: 1, sourceMessageIds: 1 });
    await col.createIndex({ chatId: 1, entityAliases: 1 });
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async listActive(chatId: number, limit = 12): Promise<ConversationThreadDoc[]> {
    return this.col
      .find({ chatId, status: 'active', expiresAt: { $gt: new Date() } })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async findByMessageId(chatId: number, messageId: number): Promise<ConversationThreadDoc | null> {
    return this.col.findOne({
      chatId,
      sourceMessageIds: messageId,
      status: 'active',
      expiresAt: { $gt: new Date() },
    });
  }

  async upsert(doc: ConversationThreadDoc): Promise<void> {
    await this.col.updateOne(
      { chatId: doc.chatId, threadId: doc.threadId },
      { $set: doc },
      { upsert: true },
    );
  }

  async attachMessage(chatId: number, threadId: string, messageId: number): Promise<void> {
    await this.col.updateOne(
      { chatId, threadId },
      {
        $addToSet: { sourceMessageIds: messageId },
        $set: { updatedAt: new Date(), lastMessageId: messageId },
      },
    );
  }
}
