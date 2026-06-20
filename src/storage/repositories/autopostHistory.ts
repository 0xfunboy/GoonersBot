import type { Collection, Db } from 'mongodb';
import type { AutopostHistoryDoc } from '../../domain/entities.js';

/**
 * Durable, per-chat de-duplication for autonomous posts. A unique insert is the reservation,
 * so concurrent scheduler ticks cannot select and send the same item twice.
 */
export class AutopostHistoryRepo {
  private readonly col: Collection<AutopostHistoryDoc>;

  constructor(db: Db) {
    this.col = db.collection<AutopostHistoryDoc>('autopost_history');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<AutopostHistoryDoc>('autopost_history');
    await col.createIndex({ chatId: 1, dedupeKey: 1 }, { unique: true });
    await col.createIndex({ createdAt: 1 });
  }

  async reserve(
    chatId: number,
    kind: AutopostHistoryDoc['kind'],
    dedupeKey: string,
  ): Promise<boolean> {
    try {
      await this.col.insertOne({ chatId, kind, dedupeKey, createdAt: new Date() });
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}
