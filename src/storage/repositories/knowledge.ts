import type { Collection, Db } from 'mongodb';

/**
 * A curated knowledge entry (nerd/anime/manga/IT/TV culture, …). Retrieved on-demand by keyword
 * overlap, so it only ever enters a prompt when relevant - keeping the character complex but not
 * monothematic and not inflating prompt size.
 */
export interface KnowledgeDoc {
  /** stable key for upserts (kebab-case) */
  key: string;
  topic: string;
  /** alternate names / search terms that should match this entry */
  aliases: string[];
  text: string;
  tags: string[];
  /** 0..1 - baseline importance when keyword scores tie */
  salience: number;
  updatedAt: Date;
}

export class KnowledgeRepo {
  private readonly col: Collection<KnowledgeDoc>;

  constructor(db: Db) {
    this.col = db.collection<KnowledgeDoc>('knowledge');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<KnowledgeDoc>('knowledge');
    await col.createIndex({ key: 1 }, { unique: true });
  }

  async count(): Promise<number> {
    return this.col.countDocuments();
  }

  async listAll(limit = 1000): Promise<KnowledgeDoc[]> {
    return this.col.find({}).limit(limit).toArray();
  }

  /** Idempotent bulk upsert by key (used to seed/refresh the curated set). */
  async upsertMany(entries: Omit<KnowledgeDoc, 'updatedAt'>[]): Promise<void> {
    if (entries.length === 0) return;
    const now = new Date();
    await this.col.bulkWrite(
      entries.map((e) => ({
        updateOne: {
          filter: { key: e.key },
          update: { $set: { ...e, updatedAt: now } },
          upsert: true,
        },
      })),
    );
  }
}
