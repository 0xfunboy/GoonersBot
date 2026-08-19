import type { Collection, Db } from 'mongodb';
import type { AnimeSeries } from '../../anime/types.js';

/**
 * One persisted series. `source` + `sourceId` is the natural key, so refreshing a series is an
 * upsert rather than an insert - repeated crawls never duplicate a title.
 */
export interface AnimeSeriesDoc extends AnimeSeries {
  /** Last successful refresh from the remote catalog. */
  crawledAt: Date;
  /** Bumped on every write; lets callers tell a no-op refresh from a real change. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields that identify a series and must never be rewritten by a partial refresh. */
export type AnimeSeriesUpsert = AnimeSeries;

export class AnimeCatalogRepo {
  private readonly col: Collection<AnimeSeriesDoc>;

  constructor(db: Db) {
    this.col = db.collection<AnimeSeriesDoc>('anime_series');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<AnimeSeriesDoc>('anime_series');
    await col.createIndex({ source: 1, sourceId: 1 }, { unique: true });
    // Lookup path: a normalized query key hits this directly before any fuzzy work happens.
    await col.createIndex({ titleKeys: 1 });
    await col.createIndex({ status: 1, crawledAt: 1 });
    await col.createIndex({ updatedAt: -1 });
  }

  async get(source: AnimeSeries['source'], sourceId: string): Promise<AnimeSeriesDoc | null> {
    return this.col.findOne({ source, sourceId });
  }

  async getMany(
    source: AnimeSeries['source'],
    sourceIds: readonly string[],
  ): Promise<AnimeSeriesDoc[]> {
    if (sourceIds.length === 0) return [];
    return this.col.find({ source, sourceId: { $in: [...sourceIds] } }).toArray();
  }

  /** Exact lookup on any normalized title key. Cheap enough to try before fuzzy ranking. */
  async findByTitleKey(key: string, limit = 10): Promise<AnimeSeriesDoc[]> {
    if (!key) return [];
    return this.col.find({ titleKeys: key }).limit(limit).toArray();
  }

  /**
   * Candidate pool for deterministic fuzzy ranking.
   *
   * Prefiltered by shared tokens so ranking never has to load the whole catalog; a query whose
   * tokens are all too generic simply falls back to the most recently updated slice.
   */
  async findFuzzyCandidates(tokens: readonly string[], limit = 200): Promise<AnimeSeriesDoc[]> {
    const usable = tokens.filter((token) => token.length >= 3).slice(0, 6);
    if (usable.length === 0) return [];
    const patterns = usable.map((token) => new RegExp(`(^| )${escapeRegExp(token)}`, 'i'));
    return this.col
      .find({ titleKeys: { $in: patterns } })
      .limit(limit)
      .toArray();
  }

  /**
   * Idempotent upsert.
   *
   * `createdAt` is only written on insert, so re-crawling a series preserves when the catalog
   * first learned about it.
   */
  async upsert(series: AnimeSeriesUpsert, now: Date = new Date()): Promise<void> {
    await this.col.updateOne(
      { source: series.source, sourceId: series.sourceId },
      writeFor(series, now),
      {
        upsert: true,
      },
    );
  }

  async upsertMany(series: readonly AnimeSeriesUpsert[], now: Date = new Date()): Promise<void> {
    if (series.length === 0) return;
    await this.col.bulkWrite(
      series.map((entry) => ({
        updateOne: {
          filter: { source: entry.source, sourceId: entry.sourceId },
          update: writeFor(entry, now),
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  /** Currently-airing series, most recently updated first. */
  async listAiring(limit = 20): Promise<AnimeSeriesDoc[]> {
    return this.col.find({ status: 'ongoing' }).sort({ updatedAt: -1 }).limit(limit).toArray();
  }
}

/**
 * Optional fields that the source can stop publishing.
 *
 * A finished series loses `nextAiringEpisode`, so without an explicit `$unset` the stored document
 * would keep announcing "Prossimo episodio: 28" - with a date in the past - for a show that ended.
 * A stale fact is worse than a missing one, because the composer states it with confidence.
 */
const CLEARABLE_FIELDS = [
  'titleRomaji',
  'titleEnglish',
  'titleNative',
  'coverUrl',
  'description',
  'format',
  'episodeCount',
  'latestEpisode',
  'nextEpisode',
  'airingWeekday',
  'seasonYear',
  'season',
  'score',
  'sourceUpdatedAt',
] as const satisfies readonly (keyof AnimeSeries)[];

/** Build the update document: set what the source published, clear what it no longer does. */
function writeFor(series: AnimeSeriesUpsert, now: Date) {
  const set: Record<string, unknown> = {
    ...stripUndefined(series),
    crawledAt: now,
    updatedAt: now,
  };
  // Defend against an old in-memory caller too: Mongo rejects updating one path in both
  // operators, so make sure a legacy extra property cannot collide with the `$unset` below.
  delete set['streamingLinks'];
  // `streamingLinks` belonged to the old catalog contract. Availability now comes exclusively
  // from the archive adapters, so scrub the legacy field whenever an existing series is touched.
  const unset: Record<string, ''> = { streamingLinks: '' };
  for (const field of CLEARABLE_FIELDS) {
    if (series[field] === undefined) unset[field] = '';
  }
  return {
    $set: set,
    ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    $inc: { revision: 1 },
    $setOnInsert: { createdAt: now },
  };
}

/**
 * Drop `undefined` values before `$set`.
 *
 * Mongo stores an explicit `undefined` as null, which would turn "AniList did not publish an
 * episode count" into "the episode count is null" and defeat every `?? fallback` downstream.
 */
function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as Partial<T>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
