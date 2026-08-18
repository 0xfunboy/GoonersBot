import type { Collection, Db } from 'mongodb';

/**
 * Cached ambient lookup, keyed by provider + subject.
 *
 * `miss: true` entries are deliberate: without them, a subject the source does not know would be
 * re-fetched every time it is mentioned, which is precisely the pattern a chatty group produces.
 */
export interface AmbientCacheDoc {
  provider: string;
  key: string;
  /** Canonical subject name as the source spells it. */
  subject: string;
  text: string;
  url?: string | undefined;
  /** True when the source had nothing; the entry exists only to suppress refetching. */
  miss: boolean;
  fetchedAt: Date;
  /** TTL anchor; Mongo removes the document once this passes. */
  expiresAt: Date;
}

export interface AmbientCacheEntry {
  subject: string;
  text: string;
  url?: string | undefined;
  miss: boolean;
}

/** A negative entry expires far sooner than a positive one: absence is likelier to change. */
const MISS_TTL_DIVISOR = 8;

export class AmbientCacheRepo {
  private readonly col: Collection<AmbientCacheDoc>;

  constructor(db: Db) {
    this.col = db.collection<AmbientCacheDoc>('ambient_cache');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<AmbientCacheDoc>('ambient_cache');
    await col.createIndex({ provider: 1, key: 1 }, { unique: true });
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async get(provider: string, key: string): Promise<AmbientCacheEntry | null> {
    const doc = await this.col.findOne({ provider, key });
    if (!doc) return null;
    // Mongo's TTL monitor runs on its own schedule, so an expired document can still be read.
    if (doc.expiresAt.getTime() <= Date.now()) return null;
    return { subject: doc.subject, text: doc.text, url: doc.url, miss: doc.miss };
  }

  async put(
    provider: string,
    key: string,
    entry: AmbientCacheEntry,
    ttlHours: number,
    now: Date = new Date(),
  ): Promise<void> {
    const hours = entry.miss ? Math.max(1, ttlHours / MISS_TTL_DIVISOR) : Math.max(1, ttlHours);
    await this.col.updateOne(
      { provider, key },
      {
        $set: {
          provider,
          key,
          subject: entry.subject,
          text: entry.text,
          url: entry.url,
          miss: entry.miss,
          fetchedAt: now,
          expiresAt: new Date(now.getTime() + hours * 3_600_000),
        },
      },
      { upsert: true },
    );
  }
}
