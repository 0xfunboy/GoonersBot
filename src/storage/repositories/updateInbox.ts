import type { Collection, Db } from 'mongodb';
import type { UpdateInboxDoc, UpdateInboxStatus } from '../../domain/entities.js';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export interface UpdateInboxInput {
  updateId: number;
  conversationKey: string;
  payload: Record<string, unknown>;
  receivedAt?: Date;
}

/** Durable Telegram ingress receipt and replay queue. */
export class UpdateInboxRepo {
  private readonly col: Collection<UpdateInboxDoc>;

  constructor(db: Db) {
    this.col = db.collection<UpdateInboxDoc>('update_inbox');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<UpdateInboxDoc>('update_inbox');
    await col.createIndex({ updateId: 1 }, { unique: true });
    await col.createIndex({ status: 1, updatedAt: 1 });
    await col.createIndex({ conversationKey: 1, receivedAt: 1 });
  }

  async enqueue(input: UpdateInboxInput): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { updateId: input.updateId },
      {
        $setOnInsert: {
          updateId: input.updateId,
          conversationKey: input.conversationKey,
          payload: input.payload,
          status: 'queued' satisfies UpdateInboxStatus,
          attempts: 0,
          leaseUntil: null,
          lastError: null,
          receivedAt: input.receivedAt ?? now,
          updatedAt: now,
          completedAt: null,
        },
      },
      { upsert: true },
    );
  }

  /** Atomically claims a new or expired update for one worker. */
  async claim(updateId: number, now = new Date(), leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
    const claimed = await this.col.findOneAndUpdate(
      {
        updateId,
        $or: [
          { status: 'queued' },
          { status: 'running', leaseUntil: { $lte: now } },
          { status: 'running', leaseUntil: null },
        ],
      },
      {
        $set: {
          status: 'running',
          leaseUntil: new Date(now.getTime() + leaseMs),
          updatedAt: now,
          lastError: null,
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after' },
    );
    return claimed !== null;
  }

  async complete(updateId: number): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { updateId, status: 'running' },
      {
        $set: {
          status: 'done',
          leaseUntil: null,
          lastError: null,
          completedAt: now,
          updatedAt: now,
        },
      },
    );
  }

  /** Release a claim when local backpressure cannot accept the work yet. */
  async release(updateId: number, reason: string): Promise<void> {
    await this.col.updateOne(
      { updateId, status: 'running' },
      {
        $set: {
          status: 'queued',
          leaseUntil: null,
          lastError: reason.slice(0, 500),
          updatedAt: new Date(),
        },
      },
    );
  }

  async fail(updateId: number, error: unknown): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { updateId, status: 'running' },
      {
        $set: {
          status: 'failed',
          leaseUntil: null,
          lastError:
            error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          updatedAt: now,
          completedAt: now,
        },
      },
    );
  }

  async listReplayable(limit = 32, now = new Date()): Promise<UpdateInboxDoc[]> {
    return this.col
      .find({
        $or: [
          { status: 'queued' },
          { status: 'running', leaseUntil: { $lte: now } },
          { status: 'running', leaseUntil: null },
        ],
      })
      .sort({ receivedAt: 1 })
      .limit(limit)
      .toArray();
  }
}
