import { MongoServerError, type Collection, type Db } from 'mongodb';
import type { MemoryOwnerDocument, MemoryRepository } from './contracts.js';

/** A bounded owner aggregate makes erasure and revision CAS atomic on standalone Mongo. */
export class MongoMemoryRepository implements MemoryRepository {
  private readonly col: Collection<MemoryOwnerDocument>;

  constructor(db: Db) {
    this.col = db.collection<MemoryOwnerDocument>('companion_memories');
  }

  async get(ownerTelegramId: number): Promise<MemoryOwnerDocument | null> {
    return this.col.findOne({ _id: ownerTelegramId });
  }

  async compareAndSwap(document: MemoryOwnerDocument, expectedVersion: number): Promise<boolean> {
    if (document.version !== expectedVersion + 1) throw new Error('Invalid memory revision');
    if (expectedVersion === 0) {
      try {
        await this.col.insertOne(document);
        return true;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) return false;
        throw error;
      }
    }
    const result = await this.col.replaceOne(
      { _id: document._id, version: expectedVersion },
      document,
    );
    return result.modifiedCount === 1;
  }
}
