import type { Collection, Db } from 'mongodb';
import type { FactDoc, FactSource } from '../../domain/entities.js';

export class FactsRepo {
  private readonly col: Collection<FactDoc>;

  constructor(db: Db) {
    this.col = db.collection<FactDoc>('facts');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<FactDoc>('facts');
    await col.createIndex({ chatId: 1, userHandle: 1 });
    await col.createIndex({ chatId: 1 });
    await col.createIndex({ createdAt: 1 });
    // Prevent exact duplicate facts per user/chat.
    await col.createIndex({ chatId: 1, userHandle: 1, fact: 1 }, { unique: true });
  }

  /** Add a fact (idempotent on exact duplicates). Returns false if it was a duplicate. */
  async add(
    chatId: number,
    userHandle: string,
    fact: string,
    source: FactSource,
    createdByHandle: string | null,
  ): Promise<boolean> {
    try {
      await this.col.insertOne({
        chatId,
        userHandle,
        fact,
        source,
        createdByHandle,
        createdAt: new Date(),
      });
      return true;
    } catch (err) {
      // Duplicate key => fact already exists.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: number }).code === 11000
      ) {
        return false;
      }
      throw err;
    }
  }

  async getForUser(chatId: number, userHandle: string): Promise<string[]> {
    const docs = await this.col.find({ chatId, userHandle }).sort({ createdAt: 1 }).toArray();
    return docs.map((d) => d.fact);
  }

  /** All facts in a chat as (handle, fact) pairs (for prompt building). */
  async getChatFacts(chatId: number): Promise<Array<{ handle: string; fact: string }>> {
    const docs = await this.col.find({ chatId }).sort({ createdAt: 1 }).toArray();
    return docs.map((d) => ({ handle: d.userHandle, fact: d.fact }));
  }

  async clearForUser(chatId: number, userHandle: string): Promise<number> {
    const res = await this.col.deleteMany({ chatId, userHandle });
    return res.deletedCount;
  }

  /** Replace a user's introduction fact (one per chat/user). */
  async setIntroduction(chatId: number, userHandle: string, introduction: string): Promise<void> {
    await this.col.deleteMany({ chatId, userHandle, source: 'introduction' });
    await this.col.insertOne({
      chatId,
      userHandle,
      fact: introduction,
      source: 'introduction',
      createdByHandle: userHandle,
      createdAt: new Date(),
    });
  }

  async getIntroduction(chatId: number, userHandle: string): Promise<string | null> {
    const doc = await this.col.findOne(
      { chatId, userHandle, source: 'introduction' },
      { sort: { createdAt: -1 } },
    );
    return doc?.fact ?? null;
  }

  async deleteByUser(handle: string): Promise<void> {
    await this.col.deleteMany({ userHandle: handle });
  }
}
