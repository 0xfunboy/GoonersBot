import type { Collection, Db } from 'mongodb';
import type { UserDoc } from '../../domain/entities.js';
import type { Person } from '../../domain/types.js';

export class UsersRepo {
  private readonly col: Collection<UserDoc>;

  constructor(db: Db) {
    this.col = db.collection<UserDoc>('users');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<UserDoc>('users');
    await col.createIndex({ handle: 1 }, { unique: true });
    await col.createIndex({ telegramId: 1 });
  }

  async upsertFromPerson(person: Person): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { handle: person.userHandle },
      {
        $setOnInsert: { handle: person.userHandle, createdAt: now },
        $set: {
          telegramId: person.telegramId,
          firstName: person.firstName ?? null,
          lastName: person.lastName ?? null,
          isPremium: person.isPremium ?? false,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }

  async getByHandle(handle: string): Promise<UserDoc | null> {
    return this.col.findOne({ handle });
  }

  async findByHandle(handle: string): Promise<UserDoc | null> {
    const exact = await this.getByHandle(handle);
    if (exact) return exact;
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.col.findOne({ handle: { $regex: `^${escaped}$`, $options: 'i' } });
  }

  /** Username changes can leave historical rows; newest observation wins for id lookup. */
  async getByTelegramId(telegramId: number): Promise<UserDoc | null> {
    return this.col.find({ telegramId }).sort({ updatedAt: -1 }).limit(1).next();
  }

  /** Only aliases observed on the immutable Telegram id; no model/name-based linking. */
  async listAliasesByTelegramId(telegramId: number): Promise<string[]> {
    const users = await this.col
      .find({ telegramId }, { projection: { handle: 1 } })
      .limit(100)
      .toArray();
    return [...new Set(users.map((user) => user.handle))];
  }

  /** Scrub PII for a user who declined terms (keep handle for safety bookkeeping). */
  async scrubPii(handle: string): Promise<void> {
    await this.col.updateOne(
      { handle },
      { $set: { firstName: null, lastName: null, updatedAt: new Date() } },
    );
  }
}
