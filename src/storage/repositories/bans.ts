import type { Collection, Db } from 'mongodb';
import type { BanDoc } from '../../domain/entities.js';

export class BansRepo {
  private readonly col: Collection<BanDoc>;

  constructor(db: Db) {
    this.col = db.collection<BanDoc>('bans');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<BanDoc>('bans');
    await col.createIndex({ handle: 1 }, { unique: true });
  }

  /**
   * Ban a user. `seconds <= 0` => permanent ban (bannedUntil = null).
   */
  async ban(handle: string, seconds: number, byHandle: string | null): Promise<void> {
    const now = new Date();
    const bannedUntil = seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null;
    await this.col.updateOne(
      { handle },
      { $set: { handle, bannedAt: now, bannedUntil, bannedByHandle: byHandle } },
      { upsert: true },
    );
  }

  async unban(handle: string): Promise<void> {
    await this.col.deleteOne({ handle });
  }

  /**
   * True if currently banned. Honours expiry (the original ignored bannedUntil) - an expired
   * temporary ban is auto-cleared and reported as not-banned.
   */
  async isBanned(handle: string, now: Date = new Date()): Promise<boolean> {
    const doc = await this.col.findOne({ handle });
    if (!doc) return false;
    if (doc.bannedUntil === null) return true; // permanent
    if (doc.bannedUntil.getTime() > now.getTime()) return true;
    // expired - clean up
    await this.col.deleteOne({ handle });
    return false;
  }
}
