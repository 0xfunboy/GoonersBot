import type { Collection, Db } from 'mongodb';
import type { TermsAcceptanceDoc } from '../../domain/entities.js';

export class TermsRepo {
  private readonly col: Collection<TermsAcceptanceDoc>;

  constructor(db: Db) {
    this.col = db.collection<TermsAcceptanceDoc>('terms_acceptance');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<TermsAcceptanceDoc>('terms_acceptance');
    await col.createIndex({ handle: 1 }, { unique: true });
  }

  async hasAccepted(handle: string): Promise<boolean> {
    const doc = await this.col.findOne({ handle }, { projection: { accepted: 1 } });
    return doc?.accepted ?? false;
  }

  async hasDeclined(handle: string): Promise<boolean> {
    const doc = await this.col.findOne({ handle }, { projection: { declined: 1 } });
    return doc?.declined ?? false;
  }

  async accept(handle: string): Promise<void> {
    await this.col.updateOne(
      { handle },
      { $set: { handle, accepted: true, declined: false, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  async decline(handle: string): Promise<void> {
    await this.col.updateOne(
      { handle },
      { $set: { handle, accepted: false, declined: true, updatedAt: new Date() } },
      { upsert: true },
    );
  }
}
