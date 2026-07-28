import {
  MongoServerError,
  ObjectId,
  type Collection,
  type Db,
  type WithId,
  type Filter,
} from 'mongodb';
import type {
  MemoryCandidate,
  MemoryItem,
  MemoryStatus,
  MemorySubjectType,
} from '../../memory/types.js';
import { normalizeSocialHandle } from '../../social/evolution.js';

type MemoryDoc = Omit<MemoryItem, '_id'>;

export const ACTIVE_MEMORY_SUBJECT_TEXT_UNIQUE_INDEX = 'memory_active_subject_text_unique_v2';

const LEGACY_ACTIVE_TEXT_KEY = { chatId: 1, normalizedText: 1 } as const;
const ACTIVE_SUBJECT_TEXT_KEY = {
  chatId: 1,
  subjectType: 1,
  subjectHandle: 1,
  normalizedText: 1,
} as const;

function indexKeyMatches(key: unknown, expected: Readonly<Record<string, number>>): boolean {
  if (key == null || typeof key !== 'object' || Array.isArray(key)) return false;
  const actualEntries = Object.entries(key as Record<string, unknown>);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([name, direction], index) =>
        actualEntries[index]?.[0] === name && actualEntries[index]?.[1] === direction,
    )
  );
}

export class MemoryItemsRepo {
  private readonly col: Collection<MemoryDoc>;

  constructor(db: Db) {
    this.col = db.collection<MemoryDoc>('memory_items');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection('memory_items');
    await col.createIndex({ chatId: 1, status: 1, salience: -1 });
    await col.createIndex({ chatId: 1, subjectHandle: 1, status: 1 });
    await col.createIndex({ chatId: 1, category: 1, status: 1 });
    await col.createIndex({ chatId: 1, involvedHandles: 1 });
    await col.createIndex({ chatId: 1, status: 1, embedding: 1 });
    // UPGRADE PATH: when memory_items grows beyond in-process cosine scale, add an Atlas
    // $vectorSearch index for embedding and keep this normal index for self-hosted Mongo fallback.
    await col.createIndex({ updatedAt: -1 });

    /*
     * Dedupe guard: the same sentence may legitimately describe two different members. Ensure the
     * replacement index before dropping the legacy (chat, normalizedText) index, and discover the
     * latter by key rather than assuming Mongo's generated name.
     */
    const indexes = await col.indexes();
    const validSubjectIndex = indexes.find(
      (index) =>
        indexKeyMatches(index.key, ACTIVE_SUBJECT_TEXT_KEY) &&
        index.unique === true &&
        index.partialFilterExpression?.['status'] === 'active',
    );
    if (!validSubjectIndex) {
      await col.createIndex(ACTIVE_SUBJECT_TEXT_KEY, {
        name: ACTIVE_MEMORY_SUBJECT_TEXT_UNIQUE_INDEX,
        unique: true,
        partialFilterExpression: { status: 'active' },
      });
    }
    const legacyIndexes = indexes.filter(
      (index) =>
        index.name != null &&
        indexKeyMatches(index.key, LEGACY_ACTIVE_TEXT_KEY) &&
        index.unique === true,
    );
    for (const index of legacyIndexes) {
      await col.dropIndex(index.name as string);
    }
  }

  private view(doc: WithId<MemoryDoc>): MemoryItem {
    return { ...(doc as MemoryDoc), _id: doc._id.toString() };
  }

  /** Persist a mined candidate as an active memory item. */
  async insertCandidate(
    chatId: number,
    c: MemoryCandidate,
    source: MemoryItem['source'],
    createdByHandle: string | null,
  ): Promise<MemoryItem> {
    const now = new Date();
    const doc: MemoryDoc = {
      chatId,
      subjectType: c.subjectType,
      subjectHandle: c.subjectHandle ?? null,
      involvedHandles: c.involvedHandles ?? [],
      text: c.text,
      normalizedText: c.normalizedText,
      category: c.category,
      source,
      sourceMessageIds: c.sourceMessageIds ?? [],
      createdByHandle,
      confidence: c.confidence,
      salience: c.salience,
      toxicity: c.toxicity,
      status: 'active',
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      useCount: 0,
      positiveFeedbackCount: 0,
      negativeFeedbackCount: 0,
      tags: [],
      revision: 1,
      history: [],
    };
    const res = await this.col.insertOne(doc);
    return { ...doc, _id: res.insertedId.toString() };
  }

  /** Insert a pre-built item (used by migration). */
  async insertRaw(item: MemoryDoc): Promise<void> {
    await this.col.insertOne(item);
  }

  async findActiveByNormalized(
    chatId: number,
    subjectType: MemorySubjectType,
    subjectHandle: string | null,
    normalizedText: string,
  ): Promise<MemoryItem | null> {
    const doc = await this.col.findOne({
      chatId,
      subjectType,
      subjectHandle,
      normalizedText,
      status: 'active',
    });
    return doc ? this.view(doc) : null;
  }

  /**
   * Reinforce an existing item only when at least one genuinely new human source id is supplied.
   * The `$expr` guard and update pipeline are one atomic operation, so concurrent miners cannot
   * boost confidence twice with the same evidence.
   */
  async reinforce(id: string, sourceMessageIds: number[]): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const evidenceIds = [
      ...new Set(
        sourceMessageIds.filter((sourceId) => Number.isSafeInteger(sourceId) && sourceId > 0),
      ),
    ];
    if (evidenceIds.length === 0) return false;
    const now = new Date();
    const res = await this.col.updateOne(
      {
        _id: new ObjectId(id),
        status: 'active',
        $expr: {
          $gt: [
            {
              $size: {
                $setDifference: [evidenceIds, { $ifNull: ['$sourceMessageIds', []] }],
              },
            },
            0,
          ],
        },
      },
      [
        {
          $set: {
            lastSeenAt: now,
            updatedAt: now,
            salience: { $min: [1, { $add: [{ $ifNull: ['$salience', 0] }, 0.05] }] },
            confidence: { $min: [1, { $add: [{ $ifNull: ['$confidence', 0] }, 0.02] }] },
            sourceMessageIds: {
              $setUnion: [{ $ifNull: ['$sourceMessageIds', []] }, evidenceIds],
            },
          },
        },
      ],
    );
    return res.modifiedCount > 0;
  }

  /**
   * Replace the value of an evolving memory while retaining a bounded audit history. The Mongo id
   * stays stable, so embeddings, feedback references and cooldown bookkeeping remain coherent.
   */
  async updateFromCandidate(id: string, c: MemoryCandidate): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const current = await this.col.findOne({ _id: new ObjectId(id), status: 'active' });
    if (!current) return false;
    const now = new Date();
    const revision = {
      text: current.text,
      normalizedText: current.normalizedText,
      confidence: current.confidence,
      salience: current.salience,
      replacedAt: now,
      reason: c.reason,
    };
    try {
      const res = await this.col.updateOne(
        { _id: current._id, status: 'active' },
        {
          $set: {
            subjectType: c.subjectType,
            subjectHandle: c.subjectHandle ?? null,
            involvedHandles: c.involvedHandles ?? [],
            text: c.text,
            normalizedText: c.normalizedText,
            category: c.category,
            confidence: c.confidence,
            salience: c.salience,
            toxicity: c.toxicity,
            lastSeenAt: now,
            updatedAt: now,
          },
          $unset: { embedding: '' },
          $inc: { revision: 1 },
          $push: { history: { $each: [revision], $slice: -8 } },
          $addToSet: { sourceMessageIds: { $each: c.sourceMessageIds ?? [] } },
        },
      );
      return res.modifiedCount > 0;
    } catch (error) {
      // A revised value may already exist as another active item. The caller can then deduplicate
      // or reinforce it without aborting the whole mining window.
      if (error instanceof MongoServerError && error.code === 11000) return false;
      throw error;
    }
  }

  /** All active memories for a chat (capped), highest salience first - for retrieval scoring. */
  async listActive(chatId: number, limit = 200): Promise<MemoryItem[]> {
    const docs = await this.col
      .find({ chatId, status: 'active' })
      .sort({ salience: -1, updatedAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => this.view(d));
  }

  async listActiveWithEmbedding(
    chatId: number,
    embeddingDim: number,
    limit = 250,
  ): Promise<MemoryItem[]> {
    const docs = await this.col
      .find({ chatId, status: 'active', embedding: { $exists: true } })
      .sort({ salience: -1, updatedAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => this.view(d)).filter((d) => d.embedding?.length === embeddingDim);
  }

  async listMissingEmbedding(embeddingDim: number, limit = 500): Promise<MemoryItem[]> {
    const docs = await this.col
      .find({
        status: 'active',
        $or: [{ embedding: { $exists: false } }, { embedding: { $not: { $size: embeddingDim } } }],
      })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => this.view(d));
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    await this.col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { embedding, updatedAt: new Date() } },
    );
  }

  async listForSubject(
    chatId: number,
    subjectHandle: string,
    statuses: MemoryStatus[] = ['active'],
  ): Promise<MemoryItem[]> {
    const docs = await this.col
      .find({ chatId, subjectHandle, status: { $in: statuses } })
      .sort({ salience: -1 })
      .toArray();
    return docs.map((d) => this.view(d));
  }

  async listTopLore(chatId: number, limit = 5): Promise<MemoryItem[]> {
    const docs = await this.col
      .find({
        chatId,
        status: 'active',
        subjectType: { $in: ['group', 'meme', 'running_joke', 'event'] },
      })
      .sort({ salience: -1, useCount: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => this.view(d));
  }

  async getById(id: string): Promise<MemoryItem | null> {
    if (!ObjectId.isValid(id)) return null;
    const doc = await this.col.findOne({ _id: new ObjectId(id) });
    return doc ? this.view(doc) : null;
  }

  async markUsed(ids: string[]): Promise<void> {
    const objIds = ids.filter((i) => ObjectId.isValid(i)).map((i) => new ObjectId(i));
    if (objIds.length === 0) return;
    await this.col.updateMany(
      { _id: { $in: objIds } },
      { $set: { lastUsedAt: new Date() }, $inc: { useCount: 1 } },
    );
  }

  async adjustSalience(id: string, delta: number, positive: boolean): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    await this.col.updateOne({ _id: new ObjectId(id) }, [
      {
        $set: {
          salience: {
            $max: [0, { $min: [1, { $add: [{ $ifNull: ['$salience', 0] }, delta] }] }],
          },
          positiveFeedbackCount: {
            $add: [{ $ifNull: ['$positiveFeedbackCount', 0] }, positive ? 1 : 0],
          },
          negativeFeedbackCount: {
            $add: [{ $ifNull: ['$negativeFeedbackCount', 0] }, positive ? 0 : 1],
          },
          updatedAt: new Date(),
        },
      },
    ]);
  }

  /**
   * Apply a correction to explicit reaction learning. Counter deltas may be negative when a user
   * removes or changes a previous vote; both counters remain non-negative.
   */
  async adjustReactionFeedback(
    id: string,
    salienceDelta: number,
    positiveCountDelta: number,
    negativeCountDelta: number,
  ): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    if (salienceDelta === 0 && positiveCountDelta === 0 && negativeCountDelta === 0) return;
    await this.col.updateOne({ _id: new ObjectId(id) }, [
      {
        $set: {
          salience: {
            $max: [0, { $min: [1, { $add: [{ $ifNull: ['$salience', 0] }, salienceDelta] }] }],
          },
          positiveFeedbackCount: {
            $max: [
              0,
              {
                $add: [{ $ifNull: ['$positiveFeedbackCount', 0] }, positiveCountDelta],
              },
            ],
          },
          negativeFeedbackCount: {
            $max: [
              0,
              {
                $add: [{ $ifNull: ['$negativeFeedbackCount', 0] }, negativeCountDelta],
              },
            ],
          },
          updatedAt: new Date(),
        },
      },
    ]);
  }

  /** Idempotently lower the priority of callbacks the old system already exhausted. */
  async coolOverused(chatId: number, minUseCount = 12): Promise<number> {
    const res = await this.col.updateMany(
      { chatId, status: 'active', useCount: { $gte: minUseCount }, salience: { $gt: 0.18 } },
      [
        {
          $set: {
            salience: 0.18,
            updatedAt: new Date(),
            tags: { $setUnion: [{ $ifNull: ['$tags', []] }, ['cooled']] },
          },
        },
      ],
    );
    return res.modifiedCount;
  }

  /** Soft-delete: set status=expired. */
  async expireById(chatId: number, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const res = await this.col.updateOne(
      { _id: new ObjectId(id), chatId },
      { $set: { status: 'expired', updatedAt: new Date() } },
    );
    return res.matchedCount > 0;
  }

  async expireBySubject(chatId: number, subjectHandle: string): Promise<number> {
    const res = await this.col.updateMany(
      { chatId, subjectHandle, status: 'active' },
      { $set: { status: 'expired', updatedAt: new Date() } },
    );
    return res.modifiedCount;
  }

  /**
   * Permanently erase memories attributable to or about one member across every chat.
   *
   * Terms refusal is stronger than the normal `/forget` lifecycle operation: expired documents
   * would still retain personal data at rest, so this intentionally covers every status and hard
   * deletes subject, participant and manual-author matches. Telegram handles are case-insensitive.
   */
  async deleteByHandleEverywhere(handle: string): Promise<number> {
    const normalizedHandle = normalizeSocialHandle(handle);
    if (!normalizedHandle) return 0;
    const res = await this.col.deleteMany(
      {
        $or: [
          { subjectHandle: normalizedHandle },
          { involvedHandles: normalizedHandle },
          { createdByHandle: normalizedHandle },
        ],
      },
      { collation: { locale: 'en', strength: 2 } },
    );
    return res.deletedCount;
  }

  async expireBySourceMessage(chatId: number, messageId: number): Promise<number> {
    const res = await this.col.updateMany(
      { chatId, sourceMessageIds: messageId, status: 'active' },
      { $set: { status: 'expired', updatedAt: new Date() } },
    );
    return res.modifiedCount;
  }

  async countActive(chatId: number, filter: Filter<MemoryDoc> = {}): Promise<number> {
    return this.col.countDocuments({ chatId, status: 'active', ...filter });
  }
}
