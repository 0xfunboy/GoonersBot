import type { Collection, Db } from 'mongodb';
import type { ConversationEntityDoc } from '../../domain/entities.js';

export class ConversationEntitiesRepo {
  private readonly col: Collection<ConversationEntityDoc>;

  constructor(db: Db) {
    this.col = db.collection<ConversationEntityDoc>('conversation_entities');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<ConversationEntityDoc>('conversation_entities');
    await col.createIndex({ chatId: 1, entityId: 1 }, { unique: true });
    await col.createIndex({ chatId: 1, aliases: 1 });
    await col.createIndex({ chatId: 1, ownerHandle: 1 });
    await col.createIndex({ chatId: 1, threadIds: 1 });
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async listForThreads(chatId: number, threadIds: string[]): Promise<ConversationEntityDoc[]> {
    if (threadIds.length === 0) return [];
    return this.col.find({ chatId, threadIds: { $in: threadIds }, expiresAt: { $gt: new Date() } }).toArray();
  }

  async findByAlias(chatId: number, aliases: string[]): Promise<ConversationEntityDoc[]> {
    if (aliases.length === 0) return [];
    return this.col.find({ chatId, aliases: { $in: aliases }, expiresAt: { $gt: new Date() } }).toArray();
  }

  async upsert(doc: ConversationEntityDoc): Promise<void> {
    await this.col.updateOne(
      { chatId: doc.chatId, entityId: doc.entityId },
      { $set: doc },
      { upsert: true },
    );
  }
}
