import { type Collection, type Db } from 'mongodb';
import type { BrainDebugTurn } from '../../brain/types.js';

export class BrainDebugRepo {
  private readonly col: Collection<BrainDebugTurn>;

  constructor(
    db: Db,
    private readonly ttlDays: number,
  ) {
    this.col = db.collection<BrainDebugTurn>('brain_debug_turns');
  }

  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ chatId: 1, createdAt: -1 });
    if (this.ttlDays > 0) {
      await this.col.createIndex(
        { createdAt: 1 },
        { name: 'braindebug_ttl', expireAfterSeconds: this.ttlDays * 24 * 60 * 60 },
      );
    }
  }

  async record(turn: BrainDebugTurn): Promise<void> {
    await this.col.insertOne(turn);
  }

  async getLast(chatId: number): Promise<BrainDebugTurn | null> {
    return this.col.findOne({ chatId }, { sort: { createdAt: -1 } });
  }
}
