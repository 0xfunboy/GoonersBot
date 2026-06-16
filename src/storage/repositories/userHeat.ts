import type { Collection, Db } from 'mongodb';

/** Per-user, per-chat verbal-hostility score (0..100). Drives the escalation system. */
export interface UserHeatDoc {
  chatId: number;
  handle: string;
  heat: number;
  updatedAt: Date;
}

export class UserHeatRepo {
  private readonly col: Collection<UserHeatDoc>;

  constructor(db: Db) {
    this.col = db.collection<UserHeatDoc>('user_heat');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<UserHeatDoc>('user_heat');
    await col.createIndex({ chatId: 1, handle: 1 }, { unique: true });
  }

  async get(chatId: number, handle: string): Promise<UserHeatDoc | null> {
    return this.col.findOne({ chatId, handle });
  }

  async set(chatId: number, handle: string, heat: number): Promise<void> {
    await this.col.updateOne(
      { chatId, handle },
      { $set: { heat, updatedAt: new Date() }, $setOnInsert: { chatId, handle } },
      { upsert: true },
    );
  }
}
