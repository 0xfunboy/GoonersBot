import type { Collection, Db } from 'mongodb';
import type { UsageDoc, UsageEventDoc } from '../../domain/entities.js';

export interface UsageDelta {
  points: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedTokens?: number;
  imageCalls?: number;
  transcriptionCalls?: number;
  visionCalls?: number;
  costEstimate?: number;
}

export interface UsageEventInput extends UsageDelta {
  handle: string;
  chatId: number;
  provider: string;
  model: string | null;
}

export class UsageRepo {
  private readonly col: Collection<UsageDoc>;
  private readonly events: Collection<UsageEventDoc>;

  constructor(
    db: Db,
    private readonly defaultLimit: number,
  ) {
    this.col = db.collection<UsageDoc>('usage');
    this.events = db.collection<UsageEventDoc>('usage_events');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<UsageDoc>('usage');
    await col.createIndex({ handle: 1 }, { unique: true });
    const events = db.collection<UsageEventDoc>('usage_events');
    await events.createIndex({ handle: 1, createdAt: -1 });
    await events.createIndex({ chatId: 1, createdAt: -1 });
    await events.createIndex({ provider: 1, model: 1 });
    await events.createIndex({ createdAt: 1 });
  }

  /**
   * Ensure a usage doc exists and reset the rolling counter at the start of a new month.
   * (Fixes the original's buggy date comparison: we compare year+month explicitly.)
   */
  async ensureAndMaybeReset(handle: string): Promise<void> {
    const now = new Date();
    const doc = await this.col.findOne({ handle });
    if (!doc) {
      await this.col.insertOne({
        handle,
        usage: 0,
        limit: this.defaultLimit,
        lastReset: now,
        inputTokens: 0,
        outputTokens: 0,
        estimatedTokens: 0,
        imageCalls: 0,
        transcriptionCalls: 0,
        visionCalls: 0,
        costEstimate: 0,
        updatedAt: now,
      });
      return;
    }
    const last = doc.lastReset ?? now;
    const newPeriod =
      now.getUTCFullYear() !== last.getUTCFullYear() || now.getUTCMonth() !== last.getUTCMonth();
    if (newPeriod) {
      await this.col.updateOne(
        { handle },
        {
          $set: {
            usage: 0,
            inputTokens: 0,
            outputTokens: 0,
            estimatedTokens: 0,
            imageCalls: 0,
            transcriptionCalls: 0,
            visionCalls: 0,
            costEstimate: 0,
            lastReset: now,
            updatedAt: now,
          },
        },
      );
    }
  }

  async getUsage(handle: string): Promise<number> {
    const doc = await this.col.findOne({ handle }, { projection: { usage: 1 } });
    return doc?.usage ?? 0;
  }

  async getLimit(handle: string): Promise<number> {
    const doc = await this.col.findOne({ handle }, { projection: { limit: 1 } });
    return doc?.limit ?? this.defaultLimit;
  }

  async getReport(handle: string): Promise<{ usage: number; limit: number; lastReset: Date }> {
    const doc = await this.col.findOne({ handle });
    return {
      usage: doc?.usage ?? 0,
      limit: doc?.limit ?? this.defaultLimit,
      lastReset: doc?.lastReset ?? new Date(),
    };
  }

  /** Record a usage delta against the rolling counters and append a detailed event. */
  async record(event: UsageEventInput): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { handle: event.handle },
      {
        $inc: {
          usage: event.points,
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
          estimatedTokens: event.estimatedTokens ?? 0,
          imageCalls: event.imageCalls ?? 0,
          transcriptionCalls: event.transcriptionCalls ?? 0,
          visionCalls: event.visionCalls ?? 0,
          costEstimate: event.costEstimate ?? 0,
        },
        $set: { updatedAt: now },
        $setOnInsert: { handle: event.handle, limit: this.defaultLimit, lastReset: now },
      },
      { upsert: true },
    );
    await this.events.insertOne({
      handle: event.handle,
      chatId: event.chatId,
      provider: event.provider,
      model: event.model,
      inputTokens: event.inputTokens ?? 0,
      outputTokens: event.outputTokens ?? 0,
      estimatedTokens: event.estimatedTokens ?? 0,
      imageCalls: event.imageCalls ?? 0,
      transcriptionCalls: event.transcriptionCalls ?? 0,
      visionCalls: event.visionCalls ?? 0,
      points: event.points,
      costEstimate: event.costEstimate ?? 0,
      createdAt: now,
    });
  }
}
