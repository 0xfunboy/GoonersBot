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
    return this.col
      .find({ chatId, threadIds: { $in: threadIds }, expiresAt: { $gt: new Date() } })
      .toArray();
  }

  async findByAlias(chatId: number, aliases: string[]): Promise<ConversationEntityDoc[]> {
    if (aliases.length === 0) return [];
    return this.col
      .find({ chatId, aliases: { $in: aliases }, expiresAt: { $gt: new Date() } })
      .toArray();
  }

  async upsert(doc: ConversationEntityDoc): Promise<void> {
    await this.col.updateOne(
      { chatId: doc.chatId, entityId: doc.entityId },
      { $set: doc },
      { upsert: true },
    );
  }

  /**
   * Record another sighting of an entity without discarding what is already known about it.
   *
   * `upsert` replaces the whole document, which is right for a freshly extracted entity but wrong
   * for a repeat mention: a later sighting outside any thread would reset `threadIds` to `[]` and
   * silently break the `listForThreads` lookup that makes referents resolvable at all.
   */
  async touch(
    doc: Pick<
      ConversationEntityDoc,
      'chatId' | 'entityId' | 'type' | 'canonicalName' | 'confidence' | 'updatedAt' | 'expiresAt'
    > &
      Partial<
        Pick<
          ConversationEntityDoc,
          | 'aliases'
          | 'attributes'
          | 'threadIds'
          | 'sourceMessageIds'
          | 'introducedByHandle'
          | 'createdAt'
        >
      >,
  ): Promise<void> {
    await this.col.updateOne(
      { chatId: doc.chatId, entityId: doc.entityId },
      {
        $set: {
          type: doc.type,
          canonicalName: doc.canonicalName,
          confidence: doc.confidence,
          updatedAt: doc.updatedAt,
          expiresAt: doc.expiresAt,
        },
        $addToSet: {
          aliases: { $each: doc.aliases ?? [] },
          attributes: { $each: doc.attributes ?? [] },
          threadIds: { $each: doc.threadIds ?? [] },
          sourceMessageIds: { $each: doc.sourceMessageIds ?? [] },
        },
        $setOnInsert: {
          chatId: doc.chatId,
          entityId: doc.entityId,
          introducedByHandle: doc.introducedByHandle ?? 'unknown',
          createdAt: doc.createdAt ?? doc.updatedAt,
        },
      },
      { upsert: true },
    );
  }
}
