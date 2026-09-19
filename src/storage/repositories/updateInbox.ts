import { MongoServerError, type Collection, type Db } from 'mongodb';
import type { UpdateInboxDoc, UpdateInboxStatus } from '../../domain/entities.js';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES: UpdateInboxStatus[] = ['done', 'failed', 'cancelled', 'outcome_unknown'];

export interface UpdateInboxInput {
  botId: string;
  updateId: number;
  conversationKey: string;
  actorTelegramId: number | null;
  chatId: number | null;
  payload: Record<string, unknown>;
  receivedAt?: Date;
}

export interface UpdateInboxClaim {
  botId: string;
  updateId: number;
  ownerId: string;
  fence: number;
}

export type UpdateAdmission = 'inserted' | 'duplicate';

export class InboxCapacityError extends Error {
  constructor(
    readonly activeCount: number,
    readonly activeBytes: number,
    readonly maxCount: number,
    readonly maxBytes: number,
  ) {
    super(
      `Telegram durable inbox capacity reached (${activeCount}/${maxCount} updates, ${activeBytes}/${maxBytes} bytes)`,
    );
    this.name = 'InboxCapacityError';
  }
}

/** Durable Telegram ingress receipt, replay queue and lease authority. */
export class UpdateInboxRepo {
  private readonly col: Collection<UpdateInboxDoc>;

  constructor(db: Db) {
    this.col = db.collection<UpdateInboxDoc>('update_inbox');
  }

  static async ensureIndexes(db: Db, retentionDays = 30): Promise<void> {
    const col = db.collection<UpdateInboxDoc>('update_inbox');
    // Migrate the original single-bot index. update_id is scoped to a Telegram bot stream.
    const indexes = await col
      .listIndexes()
      .toArray()
      .catch((error: unknown) => {
        if (error instanceof MongoServerError && error.code === 26) return [];
        throw error;
      });
    for (const index of indexes) {
      if (index.name === '_id_') continue;
      const keys = Object.keys(index.key ?? {});
      if (index.unique && keys.length === 1 && keys[0] === 'updateId' && index.name) {
        await col.dropIndex(index.name);
      }
    }

    await col.createIndex({ botId: 1, updateId: 1 }, { unique: true });
    await col.createIndex({ botId: 1, status: 1, receivedAt: 1, updateId: 1 });
    await col.createIndex({ botId: 1, status: 1, leaseUntil: 1 });
    await col.createIndex({ conversationKey: 1, receivedAt: 1 });
    await col.createIndex({ actorTelegramId: 1, status: 1 });

    const ttlSeconds = Math.max(86_400, Math.round(retentionDays * 86_400));
    const ttl = indexes.find((index) => index.name === 'update_inbox_terminal_ttl');
    if (ttl && ttl.expireAfterSeconds !== ttlSeconds) {
      await col.dropIndex('update_inbox_terminal_ttl');
    }
    if (!ttl || ttl.expireAfterSeconds !== ttlSeconds) {
      await col.createIndex(
        { completedAt: 1 },
        {
          name: 'update_inbox_terminal_ttl',
          expireAfterSeconds: ttlSeconds,
          partialFilterExpression: { completedAt: { $type: 'date' } },
        },
      );
    }
  }

  /** One-time compatibility for receipts written before bot identity and fencing were introduced. */
  async adoptLegacy(botId: string): Promise<number> {
    const legacy = await this.col.find({ botId: { $exists: false } }).toArray();
    let migrated = 0;
    for (const entry of legacy) {
      const payloadBytes = entry.payload
        ? Buffer.byteLength(JSON.stringify(entry.payload), 'utf8')
        : 0;
      const result = await this.col.updateOne(
        { _id: entry._id, botId: { $exists: false } },
        {
          $set: {
            botId,
            actorTelegramId: null,
            chatId: null,
            payloadBytes,
            fence: 0,
            ownerId: null,
          },
        },
      );
      migrated += result.modifiedCount;
    }
    return migrated;
  }

  /**
   * Admit before advancing Telegram's offset. Polling is the single writer, so measuring active
   * count/bytes immediately before insert provides deterministic backpressure without retaining
   * terminal payloads.
   */
  async enqueue(
    input: UpdateInboxInput,
    maxCount: number,
    maxBytes: number,
  ): Promise<UpdateAdmission> {
    const existing = await this.col.findOne(
      { botId: input.botId, updateId: input.updateId },
      { projection: { _id: 1 } },
    );
    if (existing) return 'duplicate';

    const payloadBytes = Buffer.byteLength(JSON.stringify(input.payload), 'utf8');
    const [usage] = await this.col
      .aggregate<{
        count: number;
        bytes: number;
      }>([
        { $match: { botId: input.botId, status: { $in: ['queued', 'running'] } } },
        { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$payloadBytes' } } },
      ])
      .toArray();
    const activeCount = usage?.count ?? 0;
    const activeBytes = usage?.bytes ?? 0;
    if (activeCount >= maxCount || activeBytes + payloadBytes > maxBytes) {
      throw new InboxCapacityError(activeCount, activeBytes, maxCount, maxBytes);
    }

    const now = new Date();
    try {
      await this.col.insertOne({
        botId: input.botId,
        updateId: input.updateId,
        conversationKey: input.conversationKey,
        actorTelegramId: input.actorTelegramId,
        chatId: input.chatId,
        payload: input.payload,
        payloadBytes,
        status: 'queued',
        attempts: 0,
        fence: 0,
        ownerId: null,
        leaseUntil: null,
        lastError: null,
        receivedAt: input.receivedAt ?? now,
        updatedAt: now,
        completedAt: null,
      });
      return 'inserted';
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) return 'duplicate';
      throw error;
    }
  }

  /** Claim only queued work. Expired running work is quarantined, never replayed blindly. */
  async claim(
    botId: string,
    updateId: number,
    ownerId: string,
    now = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<UpdateInboxClaim | null> {
    const claimed = await this.col.findOneAndUpdate(
      { botId, updateId, status: 'queued' },
      {
        $set: {
          status: 'running',
          ownerId,
          leaseUntil: new Date(now.getTime() + leaseMs),
          updatedAt: now,
          lastError: null,
        },
        $inc: { attempts: 1, fence: 1 },
      },
      { returnDocument: 'after' },
    );
    return claimed ? { botId, updateId, ownerId, fence: claimed.fence } : null;
  }

  async heartbeat(
    claim: UpdateInboxClaim,
    now = new Date(),
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<boolean> {
    const result = await this.col.updateOne(this.claimFilter(claim), {
      $set: { leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now },
    });
    return result.modifiedCount === 1;
  }

  async complete(claim: UpdateInboxClaim): Promise<boolean> {
    return this.finish(claim, 'done', null);
  }

  async fail(claim: UpdateInboxClaim, error: unknown): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    return this.finish(claim, 'failed', message.slice(0, 500));
  }

  private async finish(
    claim: UpdateInboxClaim,
    status: 'done' | 'failed',
    lastError: string | null,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.col.updateOne(this.claimFilter(claim), {
      $set: {
        status,
        ownerId: null,
        leaseUntil: null,
        lastError,
        payloadBytes: 0,
        updatedAt: now,
        completedAt: now,
      },
      $unset: { payload: '' },
    });
    return result.modifiedCount === 1;
  }

  /** A crashed legacy handler may already have caused an external effect; never replay it. */
  async quarantineExpired(botId: string, now = new Date()): Promise<number> {
    const result = await this.col.updateMany(
      {
        botId,
        status: 'running',
        $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: null }],
      },
      {
        $set: {
          status: 'outcome_unknown',
          ownerId: null,
          leaseUntil: null,
          lastError:
            'Worker lease expired; not replayed because an external effect may have occurred',
          payloadBytes: 0,
          updatedAt: now,
          completedAt: now,
        },
        $unset: { payload: '' },
      },
    );
    return result.modifiedCount;
  }

  async listQueued(botId: string, limit = 32): Promise<UpdateInboxDoc[]> {
    return this.col
      .find({ botId, status: 'queued', payload: { $exists: true } })
      .sort({ receivedAt: 1, updateId: 1 })
      .limit(limit)
      .toArray();
  }

  /** Privacy erasure keeps a payload-free tombstone so retries remain deduplicated. */
  async redactByActor(actorTelegramId: number): Promise<number> {
    const now = new Date();
    const result = await this.col.updateMany(
      { actorTelegramId, status: { $nin: TERMINAL_STATUSES } },
      {
        $set: {
          status: 'cancelled',
          ownerId: null,
          leaseUntil: null,
          lastError: 'User data erased',
          payloadBytes: 0,
          updatedAt: now,
          completedAt: now,
        },
        $unset: { payload: '' },
      },
    );
    return result.modifiedCount;
  }

  private claimFilter(claim: UpdateInboxClaim): Record<string, unknown> {
    return {
      botId: claim.botId,
      updateId: claim.updateId,
      status: 'running',
      ownerId: claim.ownerId,
      fence: claim.fence,
    };
  }
}
