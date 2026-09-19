import { randomUUID } from 'node:crypto';
import { MongoServerError, type Collection, type Db } from 'mongodb';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('workflow-ticks');

interface WorkflowTick {
  key: string;
  nextRunAt: Date;
  intervalMs: number;
  state: 'ready' | 'running' | 'uncertain';
  fence: number;
  ownerId?: string | null;
  leaseUntil?: Date | null;
  lastStartedAt?: Date;
  lastCompletedAt?: Date;
  updatedAt: Date;
}

/**
 * Migration owner for established follow/autopost schedulers. Subscription identity,
 * consent, quotas, and per-message receipts stay in the specialized repositories.
 * This coordinates polling, not Telegram delivery: an interrupted polling occurrence
 * is never replayed; the next cadence reevaluates the underlying durable subscriptions.
 */
export class WorkflowTickCoordinator {
  private readonly col: Collection<WorkflowTick>;
  private readonly ownerId = randomUUID();
  private readonly leaseMs = 120_000;

  constructor(db: Db) {
    this.col = db.collection<WorkflowTick>('companion_workflow_ticks');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    await db.collection('companion_workflow_ticks').createIndex({ key: 1 }, { unique: true });
  }

  async run(input: { key: string; intervalMs: number }, fn: () => Promise<void>): Promise<boolean> {
    if (
      !/^[a-z][a-z0-9:_-]{0,160}$/u.test(input.key) ||
      !Number.isSafeInteger(input.intervalMs) ||
      input.intervalMs < 1000
    )
      throw new Error('Invalid workflow polling identity or interval');
    const now = new Date();
    try {
      await this.col.updateOne(
        { key: input.key },
        {
          $setOnInsert: {
            key: input.key,
            state: 'ready',
            fence: 0,
            nextRunAt: now,
            intervalMs: input.intervalMs,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
    }
    // A lost callback may have sent something. Skip its window instead of replaying it.
    await this.col.updateOne(
      { key: input.key, state: 'running', leaseUntil: { $lte: now } },
      {
        $set: {
          state: 'uncertain',
          ownerId: null,
          leaseUntil: null,
          nextRunAt: new Date(now.getTime() + input.intervalMs),
          updatedAt: now,
        },
        $inc: { fence: 1 },
      },
    );
    const claimed = await this.col.findOneAndUpdate(
      { key: input.key, state: { $in: ['ready', 'uncertain'] }, nextRunAt: { $lte: now } },
      {
        $set: {
          state: 'running',
          ownerId: this.ownerId,
          leaseUntil: new Date(now.getTime() + this.leaseMs),
          lastStartedAt: now,
          intervalMs: input.intervalMs,
          updatedAt: now,
        },
        $inc: { fence: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!claimed) return false;
    const authority = {
      key: input.key,
      state: 'running' as const,
      ownerId: this.ownerId,
      fence: claimed.fence,
    };
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.col
        .updateOne(authority, {
          $set: { leaseUntil: new Date(Date.now() + this.leaseMs) },
        })
        .catch((error) => log.warn({ error, key: input.key }, 'workflow tick heartbeat failed'))
        .finally(() => {
          heartbeatBusy = false;
        });
    }, 30_000);
    heartbeat.unref();
    let complete = false;
    try {
      await fn();
      complete = true;
      return true;
    } finally {
      clearInterval(heartbeat);
      const finishedAt = new Date();
      const nextRunAt = new Date(
        claimed.nextRunAt.getTime() +
          Math.max(
            1,
            Math.floor((finishedAt.getTime() - claimed.nextRunAt.getTime()) / input.intervalMs) + 1,
          ) *
            input.intervalMs,
      );
      // Coalesce downtime and slow polls. The next poll is never an immediate catch-up burst.
      await this.col.updateOne(authority, {
        $set: {
          state: complete ? 'ready' : 'uncertain',
          ownerId: null,
          leaseUntil: null,
          nextRunAt,
          updatedAt: finishedAt,
          ...(complete ? { lastCompletedAt: finishedAt } : {}),
        },
      });
    }
  }
}
