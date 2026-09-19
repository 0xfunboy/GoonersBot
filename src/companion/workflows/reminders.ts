import { randomUUID } from 'node:crypto';
import { MongoServerError, type Collection, type Db, type Filter } from 'mongodb';
import { z } from 'zod';
import { childLogger } from '../../utils/logger.js';
import type { TaskScope } from '../tasks/contracts.js';
import {
  isQuietAt,
  localDateKey,
  nextAllowedNotificationAt,
  renderWorkflowObservation,
  snapshotObservation,
  type ObservationSnapshot,
  type WorkflowObservation,
} from './observation.js';

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

const quietHoursSchema = z
  .object({
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(23),
  })
  .strict()
  .refine((value) => value.startHour !== value.endHour, 'Quiet hours cannot occupy the entire day');

const sourceUrlsSchema = z
  .array(
    z
      .string()
      .url()
      .max(2000)
      .refine((value) => {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      }, 'Workflow sources require public HTTP(S) URLs without credentials'),
  )
  .min(1)
  .max(4)
  .refine((urls) => new Set(urls).size === urls.length, 'Duplicate workflow source');

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
    kind: z.enum(['reminder', 'monitor', 'report']).optional(),
    sourceUrls: sourceUrlsSchema.optional(),
    quietHours: quietHoursSchema.optional(),
    maxChecks: z.number().int().min(1).max(10000).optional(),
    maxNotificationsPerDay: z.number().int().min(1).max(100).optional(),
    notifyOnFirstObservation: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) => !input.intervalMinutes || !input.weeklyWallTime,
    'Choose elapsed interval or weekly wall time, not both',
  )
  .refine(
    (input) => !input.kind || input.kind === 'reminder' || Boolean(input.sourceUrls?.length),
    'Monitors and reports need at least one source URL',
  )
  .refine(
    (input) => input.kind !== 'monitor' || Boolean(input.intervalMinutes || input.weeklyWallTime),
    'Monitors require a recurring schedule',
  )
  .refine(
    (input) => input.kind !== 'monitor' || !input.intervalMinutes || input.intervalMinutes >= 5,
    'Monitor checks must be at least five minutes apart',
  );

export type CreateReminderInput = z.infer<typeof createReminderSchema>;
export type ReminderStatus =
  | 'active'
  | 'checking'
  | 'sending'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'delivery_unknown';
export interface Reminder {
  id: string;
  key: string;
  scope: TaskScope;
  text: string;
  kind?: 'reminder' | 'monitor' | 'report';
  sourceUrls?: string[];
  quietHours?: z.infer<typeof quietHoursSchema>;
  maxChecks?: number;
  checkCount?: number;
  maxNotificationsPerDay?: number;
  notifyOnFirstObservation?: boolean;
  notifiedDay?: string;
  notifiedToday?: number;
  lastObservedHash?: string;
  lastNotifiedHash?: string;
  baselineHash?: string;
  failureCount?: number;
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
  sourceUrls?: string[];
  quietHours?: z.infer<typeof quietHoursSchema> | null;
  maxOccurrences?: number;
  maxChecks?: number;
  maxNotificationsPerDay?: number;
  notifyOnFirstObservation?: boolean;
}

export interface ReminderServiceOptions {
  send: (reminder: Reminder, signal: AbortSignal) => Promise<{ messageId: number }>;
  /** Check current terms/membership/access immediately before every delivery. */
  authorize?: (scope: TaskScope) => Promise<boolean>;
  /** Host-owned bounded SSRF-safe reader. Source content is untrusted data, not instructions. */
  observe?: (reminder: Reminder, signal: AbortSignal) => Promise<WorkflowObservation>;
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
    if (parsed.kind && parsed.kind !== 'reminder' && !this.options.observe)
      throw new Error('Live source observation is unavailable; no monitor or report was created');
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
          status: { $in: ['active', 'checking', 'sending', 'paused', 'delivery_unknown'] },
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
      kind: parsed.kind ?? 'reminder',
      ...(parsed.sourceUrls ? { sourceUrls: parsed.sourceUrls } : {}),
      ...(parsed.quietHours ? { quietHours: parsed.quietHours } : {}),
      maxChecks: parsed.maxChecks ?? 10000,
      checkCount: 0,
      maxNotificationsPerDay: parsed.maxNotificationsPerDay ?? 20,
      notifyOnFirstObservation: parsed.notifyOnFirstObservation ?? false,
      timezone: parsed.timezone,
      nextRunAt: runAt,
      ...(parsed.intervalMinutes ? { intervalMinutes: parsed.intervalMinutes } : {}),
      ...(parsed.weeklyWallTime ? { weeklyWallTime: parsed.weeklyWallTime } : {}),
      ...(parsed.expiresAt
        ? { expiresAt: new Date(parsed.expiresAt) }
        : parsed.kind === 'monitor' || parsed.kind === 'report'
          ? { expiresAt: new Date(runAt.getTime() + 30 * 86_400_000) }
          : {}),
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
      .find({
        ...scoped(scope),
        status: { $in: ['active', 'checking', 'sending', 'paused', 'delivery_unknown'] },
      })
      .sort({ nextRunAt: 1 })
      .limit(32)
      .toArray();
  }

  async update(input: UpdateReminderInput): Promise<Reminder | null> {
    const current = await this.col.findOne({
      id: input.id,
      ...scoped(input.scope),
      version: input.expectedVersion,
      status: { $in: ['active', 'paused'] },
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
      maxOccurrences: input.maxOccurrences ?? current.maxOccurrences,
      kind: current.kind ?? 'reminder',
      sourceUrls: input.sourceUrls ?? current.sourceUrls,
      quietHours: input.quietHours === null ? undefined : (input.quietHours ?? current.quietHours),
      maxChecks: input.maxChecks ?? current.maxChecks,
      maxNotificationsPerDay: input.maxNotificationsPerDay ?? current.maxNotificationsPerDay,
      notifyOnFirstObservation: input.notifyOnFirstObservation ?? current.notifyOnFirstObservation,
    });
    const nextRunAt = new Date(parsed.runAt);
    if (input.runAt && nextRunAt.getTime() < Date.now() - 60_000)
      throw new Error('Reminder time is in the past');
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= nextRunAt.getTime())
      throw new Error('Reminder expiry must follow its next occurrence');
    const result = await this.col.findOneAndUpdate(
      {
        id: input.id,
        ...scoped(input.scope),
        version: input.expectedVersion,
        status: { $in: ['active', 'paused'] },
      },
      {
        $set: {
          text: parsed.text,
          status: 'active',
          failureCount: 0,
          timezone: parsed.timezone,
          nextRunAt,
          maxOccurrences: parsed.maxOccurrences ?? current.maxOccurrences,
          ...(parsed.sourceUrls ? { sourceUrls: parsed.sourceUrls } : {}),
          ...(parsed.quietHours ? { quietHours: parsed.quietHours } : {}),
          ...(parsed.maxChecks ? { maxChecks: parsed.maxChecks } : {}),
          ...(parsed.maxNotificationsPerDay
            ? { maxNotificationsPerDay: parsed.maxNotificationsPerDay }
            : {}),
          ...(parsed.notifyOnFirstObservation !== undefined
            ? { notifyOnFirstObservation: parsed.notifyOnFirstObservation }
            : {}),
          updatedAt: new Date(),
          ...(parsed.intervalMinutes ? { intervalMinutes: parsed.intervalMinutes } : {}),
          ...(parsed.weeklyWallTime ? { weeklyWallTime: parsed.weeklyWallTime } : {}),
          ...(parsed.expiresAt ? { expiresAt: new Date(parsed.expiresAt) } : {}),
        },
        $unset: {
          ...(!parsed.intervalMinutes ? { intervalMinutes: '' as const } : {}),
          ...(!parsed.weeklyWallTime ? { weeklyWallTime: '' as const } : {}),
          ...(!parsed.expiresAt ? { expiresAt: '' as const } : {}),
          ...(!parsed.quietHours ? { quietHours: '' as const } : {}),
          ...(input.sourceUrls
            ? {
                lastObservedHash: '' as const,
                lastNotifiedHash: '' as const,
                baselineHash: '' as const,
              }
            : {}),
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
        status: { $in: ['active', 'checking', 'sending', 'paused', 'delivery_unknown'] },
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
        $unset: { sourceUrls: '', lastObservedHash: '', lastNotifiedHash: '', baselineHash: '' },
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
      status: { $in: ['checking', 'sending'] },
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
      // Reading public sources has no external effect: a crashed check can safely retry.
      await this.col.updateMany(
        { status: 'checking', leaseUntil: { $lte: now } },
        {
          $set: {
            status: 'active',
            ownerId: null,
            leaseUntil: null,
            nextRunAt: new Date(now.getTime() + 5 * 60_000),
            updatedAt: now,
            reason: 'Source check interrupted; safely rescheduled',
          },
          $inc: { fence: 1 },
        },
      );
      await this.col.updateMany(
        { status: { $in: ['active', 'paused'] }, expiresAt: { $lte: now } },
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
          {
            $set: {
              status: 'checking',
              ownerId: this.ownerId,
              leaseUntil: new Date(startedAt.getTime() + this.leaseMs),
              updatedAt: startedAt,
            },
            $inc: { fence: 1 },
          },
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
    let sending = false;
    let snapshot: ObservationSnapshot | undefined;
    const awaitBounded = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          if (abortListener) controller.signal.removeEventListener('abort', abortListener);
          abortListener = () => reject(controller.signal.reason);
          if (controller.signal.aborted) abortListener();
          else controller.signal.addEventListener('abort', abortListener, { once: true });
        }),
      ]);
    try {
      if (this.options.authorize && !(await awaitBounded(this.options.authorize(reminder.scope)))) {
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
      const now = new Date();
      if (
        reminder.deliveredCount >= reminder.maxOccurrences ||
        (reminder.checkCount ?? 0) >= (reminder.maxChecks ?? 10000)
      ) {
        await this.releaseCheck(reminder, now, undefined, 'Workflow budget exhausted');
        return;
      }
      let outgoing = reminder;
      if (reminder.kind === 'monitor' || reminder.kind === 'report') {
        if (!this.options.observe || !reminder.sourceUrls?.length)
          throw new Error('Workflow source reader is unavailable');
        const counted = await this.col.updateOne(this.authority(reminder), {
          $inc: { checkCount: 1 },
        });
        if (!counted.matchedCount) return;
        reminder.checkCount = (reminder.checkCount ?? 0) + 1;
        snapshot = snapshotObservation(
          await awaitBounded(this.options.observe(reminder, controller.signal)),
          reminder.sourceUrls,
        );
        controller.signal.throwIfAborted();
        const observedAt = new Date();
        const observed = await this.col.updateOne(this.authority(reminder), {
          $set: {
            lastObservedAt: observedAt,
            lastObservedHash: snapshot.hash,
            ...(reminder.baselineHash ? {} : { baselineHash: snapshot.hash }),
            failureCount: 0,
            updatedAt: observedAt,
          },
        });
        if (!observed.matchedCount) return;
        const changed =
          reminder.notifyOnFirstObservation && !reminder.lastNotifiedAt
            ? true
            : reminder.baselineHash || reminder.lastObservedHash
              ? snapshot.hash !==
                (reminder.lastNotifiedHash ?? reminder.baselineHash ?? reminder.lastObservedHash)
              : Boolean(reminder.notifyOnFirstObservation);
        if (reminder.kind === 'monitor' && !changed) {
          await this.releaseCheck(
            reminder,
            observedAt,
            this.nextOccurrence(reminder, observedAt),
            'No source change',
          );
          return;
        }
        outgoing = { ...reminder, text: renderWorkflowObservation(reminder, snapshot, observedAt) };
      }
      const notificationTime = new Date();
      const day = localDateKey(notificationTime, reminder.timezone);
      const notifiedToday = reminder.notifiedDay === day ? (reminder.notifiedToday ?? 0) : 0;
      const dailyBudgetReached = notifiedToday >= (reminder.maxNotificationsPerDay ?? 20);
      if (
        dailyBudgetReached ||
        isQuietAt(notificationTime, reminder.timezone, reminder.quietHours)
      ) {
        await this.releaseCheck(
          reminder,
          notificationTime,
          nextAllowedNotificationAt(
            notificationTime,
            reminder.timezone,
            reminder.quietHours,
            dailyBudgetReached,
          ),
          dailyBudgetReached ? 'Daily notification budget reached' : 'Quiet hours',
        );
        return;
      }
      if (this.options.authorize && !(await awaitBounded(this.options.authorize(reminder.scope)))) {
        await this.cancel({
          id: reminder.id,
          scope: reminder.scope,
          expectedVersion: reminder.version,
        });
        return;
      }
      controller.signal.throwIfAborted();
      // Persist effect intent immediately before Telegram, never while merely fetching a page.
      sending = true;
      const intent = await this.col.updateOne(
        { ...this.authority(reminder), status: 'checking' },
        {
          $set: {
            status: 'sending',
            delivery: {
              key: `${reminder.id}:${reminder.version}:${reminder.nextRunAt.toISOString()}`,
              status: 'pending',
              startedAt: new Date(),
            },
          },
        },
      );
      if (!intent.matchedCount) return;
      controller.signal.throwIfAborted();
      const receipt = await awaitBounded(this.options.send(outgoing, controller.signal));
      if (!Number.isSafeInteger(receipt.messageId) || receipt.messageId <= 0)
        throw new Error('Missing Telegram delivery receipt');
      const deliveredAt = new Date();
      const next = this.nextOccurrence(reminder, deliveredAt);
      const complete =
        !next ||
        reminder.deliveredCount + 1 >= reminder.maxOccurrences ||
        (reminder.checkCount ?? 0) >= (reminder.maxChecks ?? 10000) ||
        Boolean(reminder.expiresAt && next >= reminder.expiresAt);
      const result = await this.col.updateOne(this.authority(reminder), {
        $set: {
          status: complete ? 'completed' : 'active',
          ownerId: null,
          leaseUntil: null,
          updatedAt: deliveredAt,
          lastNotifiedAt: deliveredAt,
          ...(snapshot ? { lastNotifiedHash: snapshot.hash } : { lastObservedAt: deliveredAt }),
          notifiedDay: day,
          notifiedToday: notifiedToday + 1,
          failureCount: 0,
          'delivery.status': 'confirmed',
          'delivery.messageId': receipt.messageId,
          'delivery.confirmedAt': deliveredAt,
          ...(complete ? { terminalAt: deliveredAt } : { nextRunAt: next! }),
        },
        $inc: { deliveredCount: 1 },
      });
      if (!result.matchedCount)
        log.warn(
          { reminderId: reminder.id },
          'reminder accepted but durable authority changed before receipt',
        );
    } catch (error) {
      if (!sending) {
        // Failures before intent are safely retryable, but bounded to avoid endless busy loops.
        const failures = (reminder.failureCount ?? 0) + 1;
        const now = new Date();
        await this.col
          .updateOne(this.authority(reminder), {
            $set: {
              failureCount: failures,
              status: failures >= 5 ? 'paused' : 'active',
              reason:
                failures >= 5
                  ? 'Source observation repeatedly unavailable'
                  : 'Source observation unavailable; retry scheduled',
              ownerId: null,
              leaseUntil: null,
              updatedAt: now,
              ...(failures >= 5
                ? {}
                : {
                    nextRunAt: new Date(
                      now.getTime() + Math.min(60, 5 * 2 ** (failures - 1)) * 60_000,
                    ),
                  }),
            },
          })
          .catch((dbError) =>
            log.warn(
              { dbError, reminderId: reminder.id },
              'source check recovery deferred to lease expiry',
            ),
          );
        log.warn(
          { error, reminderId: reminder.id },
          'workflow source check failed before any send',
        );
        return;
      }
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

  private nextOccurrence(reminder: Reminder, now: Date): Date | undefined {
    return reminder.weeklyWallTime
      ? nextWeeklyAt(now, reminder.timezone, reminder.weeklyWallTime, reminder.nextRunAt)
      : reminder.intervalMinutes
        ? nextIntervalAt(reminder.nextRunAt, reminder.intervalMinutes, now)
        : undefined;
  }

  private async releaseCheck(
    reminder: Reminder,
    now: Date,
    next: Date | undefined,
    reason: string,
  ): Promise<void> {
    const complete =
      !next ||
      Boolean(reminder.expiresAt && next >= reminder.expiresAt) ||
      (reminder.checkCount ?? 0) >= (reminder.maxChecks ?? 10000);
    await this.col.updateOne(this.authority(reminder), {
      $set: {
        status: complete ? 'completed' : 'active',
        reason,
        ownerId: null,
        leaseUntil: null,
        updatedAt: now,
        ...(complete ? { terminalAt: now } : { nextRunAt: next }),
      },
    });
  }
}
