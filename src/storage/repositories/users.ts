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

  /** Scrub PII for a user who declined terms (keep handle for safety bookkeeping). */
  async scrubPii(handle: string): Promise<void> {
    await this.col.updateOne(
      { handle },
      { $set: { firstName: null, lastName: null, updatedAt: new Date() } },
    );
  }
}
