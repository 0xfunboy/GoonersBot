import type { Collection, Db } from 'mongodb';

export interface LinkMediaCacheDoc {
  /** sha256 of the normalized source URL */
  key: string;
  url: string;
  canonicalUrl: string;
  contentId?: string;
  platform: string;
  kind: 'video' | 'image' | 'gif' | 'audio' | 'document';
  telegramFileId: string;
  caption?: string;
  byteSize?: number;
  durationSeconds?: number;
  transcript?: string;
  visionSummary?: string;
  createdAt: Date;
  lastUsedAt: Date;
  /** TTL anchor: Mongo drops the doc after this date */
  expiresAt: Date;
}

/** Functional cache of source URL -> already-uploaded Telegram file_id (not an archive). */
export class LinkMediaCacheRepo {
  private readonly col: Collection<LinkMediaCacheDoc>;

  constructor(db: Db) {
    this.col = db.collection<LinkMediaCacheDoc>('link_media_cache');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<LinkMediaCacheDoc>('link_media_cache');
    await col.createIndex({ key: 1 }, { unique: true });
    await col.createIndex({ canonicalUrl: 1 });
    await col.createIndex({ contentId: 1 });
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  get(key: string): Promise<LinkMediaCacheDoc | null> {
    return this.col.findOne({ key });
  }

  async touch(key: string): Promise<void> {
    await this.col.updateOne({ key }, { $set: { lastUsedAt: new Date() } });
  }

  async upsert(doc: LinkMediaCacheDoc): Promise<void> {
    await this.col.updateOne({ key: doc.key }, { $set: doc }, { upsert: true });
  }
}
