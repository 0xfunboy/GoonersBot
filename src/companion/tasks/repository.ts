import { randomUUID } from 'node:crypto';
import { MongoServerError, type Collection, type Db, type Filter } from 'mongodb';
import {
  requestContractSchema,
  type CompanionTask,
  type RequestContract,
  type TaskClaim,
  type TaskControlEvent,
  type TaskOutcome,
  type TaskScope,
} from './contracts.js';

const ACTIVE = [
  'queued',
  'running',
  'verifying',
  'delivering',
  'waiting_for_user',
  'waiting_for_access',
  'waiting_for_schedule',
  'retry_scheduled',
] as const;
const EXECUTING = ['running', 'verifying', 'delivering'] as const;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_CHECKPOINT_BYTES = 128 * 1024;

function boundedJson(value: unknown, maxBytes: number): void {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new Error(
      'Task payload exceeds durable storage budget; store large artifacts by reference',
    );
  }
}

function scopeFilter(scope: TaskScope): Filter<CompanionTask> {
  return {
    'contract.scope.actorTelegramId': scope.actorTelegramId,
    'contract.scope.chatId': scope.chatId,
    // Mongo may encode optional JS fields as null; null also matches an absent topic.
    'contract.scope.threadId': scope.threadId ?? null,
  };
}

export interface EnqueueTaskInput {
  key: string;
  contract: RequestContract;
  payload: Record<string, unknown>;
  /** True only when every possible external effect is protected by ctx.effect(). */
  replaySafe?: boolean;
}

/** State, checkpoint, event and delivery intent share one Mongo document: no replica set required. */
export class CompanionTaskRepository {
  private readonly col: Collection<CompanionTask>;
  constructor(db: Db) {
    this.col = db.collection<CompanionTask>('companion_tasks');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<CompanionTask>('companion_tasks');
    await col.createIndex({ id: 1 }, { unique: true });
    await col.createIndex({ key: 1 }, { unique: true });
    await col.createIndex({ status: 1, resumeAt: 1, createdAt: 1 });
    await col.createIndex({ status: 1, leaseUntil: 1 });
    await col.createIndex({
      'contract.scope.actorTelegramId': 1,
      'contract.scope.chatId': 1,
      updatedAt: -1,
    });
    await col.createIndex({ terminalAt: 1 }, { expireAfterSeconds: 30 * 86_400 });
  }

  async enqueue(input: EnqueueTaskInput, maxActive = 100): Promise<CompanionTask> {
    if (!input.key || input.key.length > 240) throw new Error('Invalid task deduplication key');
    const contract = requestContractSchema.parse(input.contract);
    boundedJson(input.payload, MAX_PAYLOAD_BYTES);
    const existing = await this.col.findOne({ key: input.key });
    if (existing) {
      if (
        existing.contract.scope.actorTelegramId !== contract.scope.actorTelegramId ||
        existing.contract.scope.chatId !== contract.scope.chatId ||
        existing.contract.scope.threadId !== contract.scope.threadId
      )
        throw new Error('Task key scope mismatch');
      return existing;
    }
    if (
      (await this.col.countDocuments({ status: { $in: [...ACTIVE] } }, { limit: maxActive })) >=
      maxActive
    ) {
      throw new Error('Companion work queue is full');
    }
    const now = new Date();
    const task: CompanionTask = {
      id: randomUUID(),
      key: input.key,
      contract,
      payload: input.payload,
      status: 'queued',
      version: 1,
      fence: 0,
      ownerId: null,
      leaseUntil: null,
      startedAt: null,
      resumeAt: null,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      revisions: 0,
      consumedMs: 0,
      replaySafe: input.replaySafe ?? false,
      summary: '',
      checkpoints: [],
      effects: [],
      messageIds: contract.scope.messageId ? [contract.scope.messageId] : [],
      events: [{ at: now, type: 'queued', version: 1 }],
    };
    try {
      await this.col.insertOne(task);
      return task;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const duplicate = await this.col.findOne({
          key: input.key,
          ...scopeFilter(contract.scope),
        });
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  async getVisible(id: string, scope: TaskScope): Promise<CompanionTask | null> {
    return this.col.findOne({ id, ...scopeFilter(scope) });
  }

  async listVisible(scope: TaskScope, limit = 12): Promise<CompanionTask[]> {
    return this.col
      .find(scopeFilter(scope))
      .sort({ updatedAt: -1 })
      .limit(Math.max(1, Math.min(limit, 30)))
      .toArray();
  }

  async attachMessage(taskId: string, scope: TaskScope, messageId: number): Promise<boolean> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return false;
    const result = await this.col.updateOne(
      { id: taskId, ...scopeFilter(scope), 'messageIds.63': { $exists: false } },
      { $addToSet: { messageIds: messageId } },
    );
    return result.matchedCount === 1;
  }

  async revokeActor(actorTelegramId: number): Promise<number> {
    const now = new Date();
    const result = await this.col.updateMany(
      { 'contract.scope.actorTelegramId': actorTelegramId },
      {
        $set: {
          status: 'cancelled',
          payload: {},
          checkpoints: [],
          effects: [],
          result: null,
          'contract.goal': '[revoked]',
          'contract.deliverables': [],
          'contract.constraints': [],
          'contract.successCriteria': [],
          ownerId: null,
          leaseUntil: null,
          startedAt: null,
          reason: 'Requester access revoked',
          summary: '',
          updatedAt: now,
          terminalAt: now,
          events: [],
          messageIds: [],
        },
        $inc: { fence: 1, version: 1 },
      },
    );
    return result.modifiedCount;
  }

  async listForActor(actorTelegramId: number): Promise<CompanionTask[]> {
    return this.col
      .find({ 'contract.scope.actorTelegramId': actorTelegramId })
      .limit(1000)
      .toArray();
  }

  async claim(ownerId: string, leaseMs: number, now = new Date()): Promise<CompanionTask | null> {
    return this.col.findOneAndUpdate(
      {
        $or: [
          { status: 'queued' },
          { status: 'retry_scheduled', resumeAt: { $lte: now } },
          { status: 'waiting_for_schedule', resumeAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: 'running',
          ownerId,
          startedAt: now,
          leaseUntil: new Date(now.getTime() + leaseMs),
          updatedAt: now,
          resumeAt: null,
        },
        $inc: { fence: 1, attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    );
  }

  private authority(claim: TaskClaim, now = new Date()): Filter<CompanionTask> {
    return {
      id: claim.id,
      ownerId: claim.ownerId,
      fence: claim.fence,
      version: claim.version,
      status: { $in: [...EXECUTING] },
      leaseUntil: { $gt: now },
    };
  }

  async hasAuthority(claim: TaskClaim): Promise<boolean> {
    return Boolean(await this.col.findOne(this.authority(claim), { projection: { _id: 1 } }));
  }

  async heartbeat(claim: TaskClaim, leaseMs: number): Promise<boolean> {
    const now = new Date();
    const result = await this.col.updateOne(this.authority(claim, now), {
      $set: { leaseUntil: new Date(now.getTime() + leaseMs) },
    });
    return result.matchedCount === 1;
  }

  async phase(claim: TaskClaim, status: 'verifying' | 'delivering'): Promise<boolean> {
    const result = await this.col.updateOne(this.authority(claim), {
      $set: { status, updatedAt: new Date() },
    });
    return result.matchedCount === 1;
  }

  async checkpoint(claim: TaskClaim, key: string, value: unknown): Promise<boolean> {
    if (!/^[\w:-]{1,120}$/.test(key)) throw new Error('Invalid checkpoint key');
    boundedJson(value, MAX_CHECKPOINT_BYTES);
    const now = new Date();
    // $filter and $concatArrays atomically replace this one key while retaining every other step.
    const result = await this.col.updateOne(
      {
        ...this.authority(claim, now),
        $or: [{ 'checkpoints.key': key }, { 'checkpoints.31': { $exists: false } }],
      },
      [
        {
          $set: {
            updatedAt: now,
            checkpoints: {
              $concatArrays: [
                {
                  $filter: {
                    input: '$checkpoints',
                    as: 'checkpoint',
                    cond: { $ne: ['$$checkpoint.key', { $literal: key }] },
                  },
                },
                { $literal: [{ key, value, at: now }] },
              ],
            },
          },
        },
      ],
    );
    return result.matchedCount === 1;
  }

  async beginEffect(claim: TaskClaim, key: string): Promise<boolean> {
    if (!/^[\w:.-]{1,200}$/.test(key)) throw new Error('Invalid effect key');
    const now = new Date();
    const result = await this.col.updateOne(
      {
        ...this.authority(claim, now),
        'effects.key': { $ne: key },
        'effects.31': { $exists: false },
      },
      {
        $set: { updatedAt: now },
        $push: {
          effects: { key, status: 'pending', startedAt: now },
          events: {
            $each: [{ at: now, type: 'effect_started', version: claim.version, detail: key }],
            $slice: -100,
          },
        },
      },
    );
    return result.matchedCount === 1;
  }

  async confirmEffect(claim: TaskClaim, key: string, receipt: unknown): Promise<boolean> {
    boundedJson(receipt ?? null, MAX_CHECKPOINT_BYTES);
    const now = new Date();
    const result = await this.col.updateOne(
      { ...this.authority(claim, now), effects: { $elemMatch: { key, status: 'pending' } } },
      {
        $set: {
          'effects.$.status': 'confirmed',
          'effects.$.receipt': receipt ?? null,
          'effects.$.completedAt': now,
          updatedAt: now,
        },
        $push: {
          events: {
            $each: [{ at: now, type: 'effect_confirmed', version: claim.version, detail: key }],
            $slice: -100,
          },
        },
      },
    );
    return result.matchedCount === 1;
  }

  async finish(
    claim: TaskClaim,
    outcome: TaskOutcome | { status: 'delivery_unknown'; summary: string; reason?: string },
  ): Promise<boolean> {
    if ('result' in outcome) boundedJson(outcome.result ?? null, MAX_CHECKPOINT_BYTES);
    const now = new Date();
    const terminal = ['completed', 'partial', 'failed', 'cancelled'].includes(outcome.status);
    const result = await this.col.updateOne(
      {
        ...this.authority(claim, now),
        ...(outcome.status !== 'delivery_unknown'
          ? { effects: { $not: { $elemMatch: { status: 'pending' } } } }
          : {}),
      },
      [
        {
          $set: {
            status: outcome.status,
            summary: { $literal: outcome.summary.slice(0, 12000) },
            reason: { $literal: outcome.reason ?? null },
            result: { $literal: 'result' in outcome ? (outcome.result ?? null) : null },
            resumeAt: 'resumeAt' in outcome ? (outcome.resumeAt ?? null) : null,
            consumedMs: {
              $add: ['$consumedMs', { $max: [0, { $subtract: [now, '$startedAt'] }] }],
            },
            ownerId: null,
            leaseUntil: null,
            startedAt: null,
            updatedAt: now,
            ...(terminal ? { terminalAt: now } : {}),
            events: {
              $slice: [
                {
                  $concatArrays: [
                    '$events',
                    {
                      $literal: [
                        {
                          at: now,
                          type: outcome.status,
                          version: claim.version,
                          detail: outcome.reason,
                        },
                      ],
                    },
                  ],
                },
                -100,
              ],
            },
          },
        },
      ],
    );
    return result.matchedCount === 1;
  }

  async recoverExpired(now = new Date()): Promise<number> {
    // Recovery is itself conditional on the expired fence, so a concurrent heartbeat wins safely.
    const expired = await this.col
      .find({ status: { $in: [...EXECUTING] }, leaseUntil: { $lte: now } })
      .limit(100)
      .toArray();
    let recovered = 0;
    for (const task of expired) {
      const uncertain =
        !task.replaySafe || task.effects.some((effect) => effect.status === 'pending');
      const result = await this.col.updateOne(
        {
          id: task.id,
          version: task.version,
          fence: task.fence,
          status: task.status,
          leaseUntil: { $lte: now },
        },
        {
          $set: {
            status: uncertain ? 'delivery_unknown' : 'queued',
            ownerId: null,
            leaseUntil: null,
            startedAt: null,
            updatedAt: now,
            reason: uncertain
              ? 'Worker interrupted; external outcome requires reconciliation'
              : 'Resuming durable checkpoints after worker interruption',
          },
          $inc: {
            fence: 1,
            consumedMs: Math.max(0, now.getTime() - (task.startedAt ?? now).getTime()),
          },
          $push: {
            events: {
              $each: [
                {
                  at: now,
                  type: uncertain ? 'outcome_unknown' : 'recovered',
                  version: task.version,
                },
              ],
              $slice: -100,
            },
          },
        },
      );
      recovered += result.modifiedCount;
    }
    return recovered;
  }

  async control(input: TaskControlEvent): Promise<CompanionTask | null> {
    const current = await this.getVisible(input.taskId, input.scope);
    if (!current || current.version !== input.expectedVersion) return null;
    if (['completed', 'cancelled', 'delivery_unknown'].includes(current.status)) return null;
    if (
      input.action === 'resume' &&
      ![
        'waiting_for_user',
        'waiting_for_access',
        'waiting_for_schedule',
        'retry_scheduled',
        'partial',
        'failed',
      ].includes(current.status)
    )
      return null;
    if (
      (input.action === 'resume' || input.action === 'amend') &&
      current.effects.some((effect) => effect.status === 'pending')
    )
      return null;
    let contract = current.contract;
    if (input.action === 'amend') {
      if (!input.contract || current.revisions >= current.contract.budget.maxRevisions) return null;
      const proposed = requestContractSchema.parse(input.contract);
      if (
        proposed.scope.actorTelegramId !== input.scope.actorTelegramId ||
        proposed.scope.chatId !== input.scope.chatId ||
        proposed.scope.threadId !== input.scope.threadId
      )
        return null;
      // Corrections preserve the original goal and budget. New deliverables require a new task.
      if (
        proposed.deliverables.map((d) => d.id).join('\n') !==
        current.contract.deliverables.map((d) => d.id).join('\n')
      )
        return null;
      contract = {
        ...proposed,
        goal: current.contract.goal,
        budget: current.contract.budget,
        acceptedVersion: current.contract.acceptedVersion + 1,
      };
    }
    if (input.payload) boundedJson(input.payload, MAX_PAYLOAD_BYTES);
    const now = new Date();
    const status =
      input.action === 'cancel'
        ? 'cancelled'
        : input.action === 'pause'
          ? 'waiting_for_user'
          : 'queued';
    return this.col.findOneAndUpdate(
      {
        id: input.taskId,
        version: input.expectedVersion,
        fence: current.fence,
        status: current.status,
        ...scopeFilter(input.scope),
        ...(input.action === 'resume' || input.action === 'amend'
          ? { effects: { $not: { $elemMatch: { status: 'pending' } } } }
          : {}),
      },
      {
        $set: {
          status,
          contract,
          ...(input.payload ? { payload: input.payload } : {}),
          ownerId: null,
          leaseUntil: null,
          startedAt: null,
          resumeAt: null,
          updatedAt: now,
          ...(input.action === 'cancel' ? { terminalAt: now } : {}),
          reason:
            input.action === 'pause'
              ? 'Paused by requester'
              : input.action === 'cancel'
                ? 'Cancelled by requester; confirmed external effects remain'
                : '',
        },
        ...(input.action !== 'cancel' ? { $unset: { terminalAt: '' as const } } : {}),
        $inc: {
          version: 1,
          fence: 1,
          revisions: input.action === 'amend' ? 1 : 0,
          consumedMs: current.startedAt
            ? Math.max(0, now.getTime() - current.startedAt.getTime())
            : 0,
        },
        $push: {
          events: {
            $each: [{ at: now, type: input.action, version: current.version + 1 }],
            $slice: -100,
          },
        },
      },
      { returnDocument: 'after' },
    );
  }
}
