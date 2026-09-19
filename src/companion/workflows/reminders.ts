import { randomUUID } from 'node:crypto';
import { MongoServerError, type Collection, type Db, type Filter } from 'mongodb';
import { z } from 'zod';
import { childLogger } from '../../utils/logger.js';
import type { TaskScope } from '../tasks/contracts.js';

const log = childLogger('companion-reminders');
const scopeSchema = z
  .object({
    actorTelegramId: z.number().int().positive(),
    chatId: z.number().int(),
    threadId: z.number().int().optional(),
  })
  .strict();

const timezoneSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown IANA timezone');

const weeklySchema = z
  .object({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .strict();

export const createReminderSchema = z
  .object({
    key: z.string().min(1).max(240),
    scope: scopeSchema,
    text: z.string().trim().min(1).max(3500),
    runAt: z.string().datetime({ offset: true }),
    timezone: timezoneSchema,
    intervalMinutes: z.number().int().min(1).max(525600).optional(),
    weeklyWallTime: weeklySchema.optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    maxOccurrences: z.number().int().min(1).max(10000).optional(),
  })
  .strict()
  .refine(
    (input) => !input.intervalMinutes || !input.weeklyWallTime,
    'Choose elapsed interval or weekly wall time, not both',
  );

export type CreateReminderInput = z.infer<typeof createReminderSchema>;
export type ReminderStatus = 'active' | 'sending' | 'completed' | 'cancelled' | 'delivery_unknown';
export interface Reminder {
  id: string;
  key: string;
  scope: TaskScope;
  text: string;
  timezone: string;
  nextRunAt: Date;
  intervalMinutes?: number;
  weeklyWallTime?: z.infer<typeof weeklySchema>;
  expiresAt?: Date;
  maxOccurrences: number;
  deliveredCount: number;
  version: number;
  fence: number;
  status: ReminderStatus;
  createdAt: Date;
  updatedAt: Date;
  terminalAt?: Date;
  ownerId?: string | null;
  leaseUntil?: Date | null;
  lastObservedAt?: Date;
  lastNotifiedAt?: Date;
  delivery?: {
    key: string;
    status: 'pending' | 'confirmed' | 'unknown';
    startedAt: Date;
    messageId?: number;
    confirmedAt?: Date;
  };
  reason?: string;
}

export interface UpdateReminderInput {
  id: string;
  scope: TaskScope;
  expectedVersion: number;
  text?: string;
  runAt?: string;
  timezone?: string;
  intervalMinutes?: number | null;
  weeklyWallTime?: z.infer<typeof weeklySchema> | null;
  expiresAt?: string | null;
}

export interface ReminderServiceOptions {
  send: (reminder: Reminder, signal: AbortSignal) => Promise<{ messageId: number }>;
  /** Check current terms/membership/access immediately before every delivery. */
  authorize?: (scope: TaskScope) => Promise<boolean>;
  pollMs?: number;
  concurrency?: number;
}

function scoped(scope: TaskScope): Filter<Reminder> {
  const parsed = scopeSchema.parse(scope);
  return {
    'scope.actorTelegramId': parsed.actorTelegramId,
    'scope.chatId': parsed.chatId,
    'scope.threadId': parsed.threadId ?? null,
  };
}

/** Keep the original cadence but coalesce every missed window into one send after downtime. */
export function nextIntervalAt(previous: Date, intervalMinutes: number, now: Date): Date {
  const interval = intervalMinutes * 60_000;
  return new Date(
    previous.getTime() +
      Math.max(1, Math.floor((now.getTime() - previous.getTime()) / interval) + 1) * interval,
  );
}

/** Wall-clock weekly recurrence preserves local hour across DST, including repeated hours. */
export function nextWeeklyAt(
  after: Date,
  timezone: string,
  weekly: z.infer<typeof weeklySchema>,
  previousOccurrence?: Date,
): Date {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dateKey = (parts: Record<string, string>): string =>
    `${parts['year']}-${parts['month']}-${parts['day']}`;
  const afterParts = Object.fromEntries(
    formatter.formatToParts(after).map((part) => [part.type, part.value]),
  );
  const previousParts = previousOccurrence
    ? Object.fromEntries(
        formatter.formatToParts(previousOccurrence).map((part) => [part.type, part.value]),
      )
    : undefined;
  const skipDate = previousParts
    ? dateKey(previousParts)
    : Number(afterParts['hour']) * 60 + Number(afterParts['minute']) >=
        weekly.hour * 60 + weekly.minute
      ? dateKey(afterParts)
      : undefined;
  // Minute resolution makes DST gaps explicit: a missing local hour rolls to the next valid week.
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let time = start; time <= start + 15 * 86_400_000; time += 60_000) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(time)).map((part) => [part.type, part.value]),
    );
    if (
      dateKey(parts) !== skipDate &&
      weekly.weekdays.includes(weekdays.indexOf(parts['weekday'] ?? '')) &&
      Number(parts['hour']) === weekly.hour &&
      Number(parts['minute']) === weekly.minute
    )
      return new Date(time);
  }
  throw new Error('No next weekly occurrence within scheduling horizon');
}

export class ReminderService {
  private readonly col: Collection<Reminder>;
  private readonly ownerId = randomUUID();
  private readonly running = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; actorId: number }
  >();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private ticking = false;
  private admission: Promise<unknown> = Promise.resolve();
  private readonly leaseMs = 60_000;

  constructor(
    db: Db,
    private readonly options: ReminderServiceOptions,
  ) {
    this.col = db.collection<Reminder>('companion_reminders');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<Reminder>('companion_reminders');
    await col.createIndex({ id: 1 }, { unique: true });
    await col.createIndex({ key: 1 }, { unique: true });
    await col.createIndex({ status: 1, nextRunAt: 1 });
    await col.createIndex({ status: 1, leaseUntil: 1 });
    await col.createIndex({ 'scope.actorTelegramId': 1, 'scope.chatId': 1, createdAt: -1 });
    await col.createIndex({ terminalAt: 1 }, { expireAfterSeconds: 30 * 86_400 });
  }

  create(input: CreateReminderInput): Promise<Reminder> {
    const result = this.admission.then(() => this.admit(input));
    this.admission = result.catch(() => undefined);
    return result;
  }

  private async admit(input: CreateReminderInput): Promise<Reminder> {
    const parsed = createReminderSchema.parse(input);
    const existing = await this.col.findOne({ key: parsed.key, ...scoped(parsed.scope) });
    if (existing) return existing;
    if (this.options.authorize && !(await this.options.authorize(parsed.scope)))
      throw new Error('Reminder access is unavailable');
    const now = new Date();
    const runAt = new Date(parsed.runAt);
    if (runAt.getTime() < now.getTime() - 60_000)
      throw new Error('Reminder time is in the past; specify a future time');
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= runAt.getTime())
      throw new Error('Reminder expiry must follow its first occurrence');
    if (
      (await this.col.countDocuments(
        {
          'scope.actorTelegramId': parsed.scope.actorTelegramId,
          status: { $in: ['active', 'sending', 'delivery_unknown'] },
        },
        { limit: 32 },
      )) >= 32
    )
      throw new Error('At most 32 active reminders per requester');
    const reminder: Reminder = {
      id: randomUUID(),
      key: parsed.key,
      scope: parsed.scope,
      text: parsed.text,
      timezone: parsed.timezone,
      nextRunAt: runAt,
      ...(parsed.intervalMinutes ? { intervalMinutes: parsed.intervalMinutes } : {}),
      ...(parsed.weeklyWallTime ? { weeklyWallTime: parsed.weeklyWallTime } : {}),
      ...(parsed.expiresAt ? { expiresAt: new Date(parsed.expiresAt) } : {}),
      maxOccurrences: parsed.maxOccurrences ?? 1000,
      deliveredCount: 0,
      version: 1,
      fence: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.col.insertOne(reminder);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const duplicate = await this.col.findOne({ key: parsed.key, ...scoped(parsed.scope) });
        if (duplicate) return duplicate;
      }
      throw error;
    }
    this.wake();
    return reminder;
  }

  list(scope: TaskScope): Promise<Reminder[]> {
    return this.col
      .find({ ...scoped(scope), status: { $in: ['active', 'sending', 'delivery_unknown'] } })
      .sort({ nextRunAt: 1 })
      .limit(32)
      .toArray();
  }

  async update(input: UpdateReminderInput): Promise<Reminder | null> {
    const current = await this.col.findOne({
      id: input.id,
      ...scoped(input.scope),
      version: input.expectedVersion,
      status: 'active',
    });
    if (!current) return null;
    const parsed = createReminderSchema.parse({
      key: current.key,
      scope: current.scope,
      text: input.text ?? current.text,
      timezone: input.timezone ?? current.timezone,
      runAt: input.runAt ?? current.nextRunAt.toISOString(),
      intervalMinutes:
        input.intervalMinutes === null
          ? undefined
          : (input.intervalMinutes ?? current.intervalMinutes),
      weeklyWallTime:
        input.weeklyWallTime === null
          ? undefined
          : (input.weeklyWallTime ?? current.weeklyWallTime),
      expiresAt:
        input.expiresAt === null
          ? undefined
          : (input.expiresAt ?? current.expiresAt?.toISOString()),
      maxOccurrences: current.maxOccurrences,
    });
    const nextRunAt = new Date(parsed.runAt);
    if (input.runAt && nextRunAt.getTime() < Date.now() - 60_000)
      throw new Error('Reminder time is in the past');
    const result = await this.col.findOneAndUpdate(
      { id: input.id, ...scoped(input.scope), version: input.expectedVersion, status: 'active' },
      {
        $set: {
          text: parsed.text,
          timezone: parsed.timezone,
          nextRunAt,
          updatedAt: new Date(),
          ...(parsed.intervalMinutes ? { intervalMinutes: parsed.intervalMinutes } : {}),
          ...(parsed.weeklyWallTime ? { weeklyWallTime: parsed.weeklyWallTime } : {}),
          ...(parsed.expiresAt ? { expiresAt: new Date(parsed.expiresAt) } : {}),
        },
        $unset: {
          ...(!parsed.intervalMinutes ? { intervalMinutes: '' as const } : {}),
          ...(!parsed.weeklyWallTime ? { weeklyWallTime: '' as const } : {}),
          ...(!parsed.expiresAt ? { expiresAt: '' as const } : {}),
        },
        $inc: { version: 1, fence: 1 },
      },
      { returnDocument: 'after' },
    );
    this.wake();
    return result;
  }

  async cancel(input: {
    id: string;
    scope: TaskScope;
    expectedVersion?: number;
  }): Promise<boolean> {
    const now = new Date();
    const result = await this.col.updateOne(
      {
        id: input.id,
        ...scoped(input.scope),
        ...(input.expectedVersion !== undefined ? { version: input.expectedVersion } : {}),
        status: { $in: ['active', 'sending', 'delivery_unknown'] },
      },
      {
        $set: {
          status: 'cancelled',
          reason: 'Cancelled by requester',
          updatedAt: now,
          terminalAt: now,
          ownerId: null,
          leaseUntil: null,
        },
        $inc: { version: 1, fence: 1 },
      },
    );
    if (result.matchedCount)
      this.running.get(input.id)?.controller.abort(new Error('Reminder cancelled'));
    return result.matchedCount === 1;
  }

  async revokeActor(actorTelegramId: number): Promise<number> {
    const now = new Date();
    const result = await this.col.updateMany(
      { 'scope.actorTelegramId': actorTelegramId },
      {
        $set: {
          status: 'cancelled',
          text: '[revoked]',
          reason: 'Requester access revoked',
          ownerId: null,
          leaseUntil: null,
          updatedAt: now,
          terminalAt: now,
        },
        $inc: { version: 1, fence: 1 },
      },
    );
    for (const entry of this.running.values())
      if (entry.actorId === actorTelegramId)
        entry.controller.abort(new Error('Requester access revoked'));
    return result.modifiedCount;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const entry of this.running.values())
      entry.controller.abort(new Error('Reminder worker stopped'));
    await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
  }

  private wake(): void {
    if (this.stopped || this.ticking) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, 0);
    this.timer.unref();
  }

  private authority(reminder: Reminder): Filter<Reminder> {
    return {
      id: reminder.id,
      status: 'sending',
      ownerId: this.ownerId,
      version: reminder.version,
      fence: reminder.fence,
      leaseUntil: { $gt: new Date() },
    };
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      await this.col.updateMany(
        { status: 'sending', leaseUntil: { $lte: now } },
        {
          $set: {
            status: 'delivery_unknown',
            'delivery.status': 'unknown',
            reason: 'Sender interrupted; receipt requires reconciliation',
            ownerId: null,
            leaseUntil: null,
            updatedAt: now,
          },
          $inc: { fence: 1 },
        },
      );
      await this.col.updateMany(
        { status: 'active', expiresAt: { $lte: now } },
        {
          $set: {
            status: 'completed',
            reason: 'Schedule expired',
            terminalAt: now,
            updatedAt: now,
          },
        },
      );
      const concurrency = Math.max(1, Math.min(this.options.concurrency ?? 2, 4));
      while (!this.stopped && this.running.size < concurrency) {
        const startedAt = new Date();
        const reminder = await this.col.findOneAndUpdate(
          { status: 'active', nextRunAt: { $lte: startedAt } },
          [
            {
              $set: {
                status: 'sending',
                ownerId: this.ownerId,
                leaseUntil: new Date(startedAt.getTime() + this.leaseMs),
                fence: { $add: ['$fence', 1] },
                updatedAt: startedAt,
                lastObservedAt: startedAt,
                delivery: {
                  key: {
                    $concat: [
                      '$id',
                      ':',
                      { $toString: '$version' },
                      ':',
                      { $toString: '$nextRunAt' },
                    ],
                  },
                  status: 'pending',
                  startedAt,
                },
              },
            },
          ],
          { sort: { nextRunAt: 1 }, returnDocument: 'after' },
        );
        if (!reminder) break;
        const controller = new AbortController();
        const promise = this.deliver(reminder, controller)
          .catch((error) =>
            log.warn({ error, reminderId: reminder.id }, 'reminder delivery failed'),
          )
          .finally(() => {
            this.running.delete(reminder.id);
            this.wake();
          });
        this.running.set(reminder.id, {
          promise,
          controller,
          actorId: reminder.scope.actorTelegramId,
        });
      }
    } catch (error) {
      log.warn({ error }, 'reminder polling failed');
    } finally {
      this.ticking = false;
      if (!this.stopped) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(
          () => {
            void this.tick();
          },
          Math.max(1000, this.options.pollMs ?? 15_000),
        );
        this.timer.unref();
      }
    }
  }

  private async deliver(reminder: Reminder, controller: AbortController): Promise<void> {
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.col
        .updateOne(this.authority(reminder), {
          $set: { leaseUntil: new Date(Date.now() + this.leaseMs) },
        })
        .then((result) => {
          if (!result.matchedCount) controller.abort(new Error('Reminder authority expired'));
        })
        .catch(() => controller.abort(new Error('Reminder heartbeat failed')))
        .finally(() => {
          heartbeatBusy = false;
        });
    }, 20_000);
    heartbeat.unref();
    const timeout = setTimeout(
      () => controller.abort(new Error('Reminder delivery timeout')),
      90_000,
    );
    timeout.unref();
    let abortListener: (() => void) | undefined;
    try {
      if (this.options.authorize && !(await this.options.authorize(reminder.scope))) {
        await this.col.updateOne(this.authority(reminder), {
          $set: {
            status: 'cancelled',
            reason: 'Access is no longer available',
            terminalAt: new Date(),
            ownerId: null,
            leaseUntil: null,
          },
        });
        return;
      }
      if (
        controller.signal.aborted ||
        !(await this.col.findOne(this.authority(reminder), { projection: { _id: 1 } }))
      )
        return;
      const receipt = await Promise.race([
        this.options.send(reminder, controller.signal),
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(controller.signal.reason);
          if (controller.signal.aborted) abortListener();
          else controller.signal.addEventListener('abort', abortListener, { once: true });
        }),
      ]);
      if (!Number.isSafeInteger(receipt.messageId) || receipt.messageId <= 0)
        throw new Error('Missing Telegram delivery receipt');
      const now = new Date();
      const next = reminder.weeklyWallTime
        ? nextWeeklyAt(now, reminder.timezone, reminder.weeklyWallTime, reminder.nextRunAt)
        : reminder.intervalMinutes
          ? nextIntervalAt(reminder.nextRunAt, reminder.intervalMinutes, now)
          : undefined;
      const complete =
        !next ||
        reminder.deliveredCount + 1 >= reminder.maxOccurrences ||
        Boolean(reminder.expiresAt && next >= reminder.expiresAt);
      const result = await this.col.updateOne(this.authority(reminder), {
        $set: {
          status: complete ? 'completed' : 'active',
          ownerId: null,
          leaseUntil: null,
          updatedAt: now,
          lastNotifiedAt: now,
          'delivery.status': 'confirmed',
          'delivery.messageId': receipt.messageId,
          'delivery.confirmedAt': now,
          ...(complete ? { terminalAt: now } : { nextRunAt: next! }),
        },
        $inc: { deliveredCount: 1 },
      });
      if (!result.matchedCount)
        log.warn(
          { reminderId: reminder.id },
          'reminder accepted but durable authority changed before receipt',
        );
    } catch (error) {
      // Includes Telegram accepting a message followed by a failed DB write. Never replay blindly.
      await this.col
        .updateOne(this.authority(reminder), {
          $set: {
            status: 'delivery_unknown',
            'delivery.status': 'unknown',
            reason: 'Delivery outcome requires reconciliation',
            ownerId: null,
            leaseUntil: null,
            updatedAt: new Date(),
          },
        })
        .catch((dbError) =>
          log.warn(
            { dbError, reminderId: reminder.id },
            'unknown reminder outcome will be recovered after lease expiry',
          ),
        );
      log.warn({ error, reminderId: reminder.id }, 'reminder outcome uncertain');
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  }
}
