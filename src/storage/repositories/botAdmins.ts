import type { Collection, Db } from 'mongodb';
import type { BotAdminDoc } from '../../domain/entities.js';
import type { Person } from '../../domain/types.js';

export class BotAdminsRepo {
  private readonly col: Collection<BotAdminDoc>;

  constructor(db: Db) {
    this.col = db.collection<BotAdminDoc>('bot_admins');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<BotAdminDoc>('bot_admins');
    await col.createIndex({ telegramId: 1 }, { unique: true });
    await col.createIndex({ handle: 1 });
    await col.createIndex({ updatedAt: -1 });
  }

  async list(): Promise<BotAdminDoc[]> {
    return this.col.find({}).sort({ createdAt: 1, telegramId: 1 }).toArray();
  }

  async hasTelegramId(telegramId: number): Promise<boolean> {
    return (await this.col.countDocuments({ telegramId }, { limit: 1 })) > 0;
  }

  async grant(target: Person, grantedBy: Person): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { telegramId: target.telegramId },
      {
        $setOnInsert: {
          telegramId: target.telegramId,
          createdAt: now,
        },
        $set: {
          handle: target.userHandle,
          firstName: target.firstName ?? null,
          lastName: target.lastName ?? null,
          grantedByTelegramId: grantedBy.telegramId,
          grantedByHandle: grantedBy.userHandle,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }

  async revoke(telegramId: number): Promise<boolean> {
    return (await this.col.deleteOne({ telegramId })).deletedCount > 0;
  }

  /** Keep mutable username/display metadata current without changing the id-based grant. */
  async refreshIdentity(person: Person): Promise<void> {
    await this.col.updateOne(
      { telegramId: person.telegramId },
      {
        $set: {
          handle: person.userHandle,
          firstName: person.firstName ?? null,
          lastName: person.lastName ?? null,
          updatedAt: new Date(),
        },
      },
    );
  }
}
