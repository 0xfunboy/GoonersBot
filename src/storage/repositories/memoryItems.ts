import { ObjectId, type Collection, type Db, type WithId, type Filter } from 'mongodb';
import type { MemoryCandidate, MemoryItem, MemoryStatus } from '../../memory/types.js';

type MemoryDoc = Omit<MemoryItem, '_id'>;

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
    await col.createIndex({ updatedAt: -1 });
    // Dedupe guard: one active doc per (chat, normalizedText). Partial so rejected/expired don't clash.
    await col.createIndex(
      { chatId: 1, normalizedText: 1 },
      { unique: true, partialFilterExpression: { status: 'active' } },
    );
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
    };
    const res = await this.col.insertOne(doc);
    return { ...doc, _id: res.insertedId.toString() };
  }

  /** Insert a pre-built item (used by migration). */
  async insertRaw(item: MemoryDoc): Promise<void> {
    await this.col.insertOne(item);
  }

  async findActiveByNormalized(chatId: number, normalizedText: string): Promise<MemoryItem | null> {
    const doc = await this.col.findOne({ chatId, normalizedText, status: 'active' });
    return doc ? this.view(doc) : null;
  }

  /** Reinforce an existing item on duplicate detection. */
  async reinforce(id: string, sourceMessageIds: number[]): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    const now = new Date();
    await this.col.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { lastSeenAt: now, updatedAt: now },
        $inc: { salience: 0.05, confidence: 0.02 },
        $addToSet: { sourceMessageIds: { $each: sourceMessageIds } },
      },
    );
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
    await this.col.updateOne(
      { _id: new ObjectId(id) },
      {
        $inc: {
          salience: delta,
          ...(positive ? { positiveFeedbackCount: 1 } : { negativeFeedbackCount: 1 }),
        },
        $set: { updatedAt: new Date() },
      },
    );
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
