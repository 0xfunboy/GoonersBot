import type { Db } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReminderSchema,
  nextAllowedNotificationAt,
  ReminderService,
  snapshotObservation,
  type Reminder,
  type WorkflowObservation,
} from '../src/companion/workflows/index.js';
import { executeReminderOperation } from '../src/companion/workflows/execute.js';

const scope = { actorTelegramId: 17, chatId: -100, threadId: 3 };
const url = 'https://example.org/releases';
const source = (text: string): WorkflowObservation => ({
  sources: [{ url, title: 'Releases', text }],
});

function fixture(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'monitor-1',
    key: 'update:1',
    scope,
    text: 'Avvisami degli aggiornamenti',
    kind: 'monitor',
    sourceUrls: [url],
    timezone: 'Europe/Rome',
    nextRunAt: new Date('2026-09-19T08:00:00Z'),
    intervalMinutes: 30,
    maxOccurrences: 20,
    maxChecks: 100,
    checkCount: 0,
    deliveredCount: 0,
    version: 1,
    fence: 1,
    status: 'checking',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function harness(observation: WorkflowObservation) {
  const updates: Record<string, unknown>[] = [];
  const send = vi.fn().mockResolvedValue({ messageId: 101 });
  const observe = vi.fn().mockResolvedValue(observation);
  const authorize = vi.fn().mockResolvedValue(true);
  const updateOne = vi.fn(async (_filter, update) => {
    updates.push(update);
    return { matchedCount: 1 };
  });
  const service = new ReminderService(
    {
      collection: () => ({
        findOne: vi.fn().mockResolvedValue({ id: 'monitor-1' }),
        updateOne,
      }),
    } as unknown as Db,
    { send, observe, authorize },
  );
  const deliver = (reminder: Reminder) =>
    (service as unknown as { deliver: (r: Reminder, c: AbortController) => Promise<void> }).deliver(
      reminder,
      new AbortController(),
    );
  return { updates, send, observe, authorize, deliver };
}

afterEach(() => vi.useRealTimers());

describe('durable content workflows', () => {
  it('normalizes whitespace without treating a missing source as a content change', () => {
    expect(snapshotObservation(source('release  1\nready'), [url]).hash).toBe(
      snapshotObservation(source('release 1 ready'), [url]).hash,
    );
    expect(() => snapshotObservation({ sources: [] }, [url])).toThrow('missing');
    expect(() => snapshotObservation(source('x'), ['https://other.example/'])).toThrow('identity');
  });

  it('requires recurring bounded monitors with source URLs and rejects all-day quiet hours', () => {
    const base = {
      key: 'k',
      scope,
      text: 'release',
      kind: 'monitor',
      sourceUrls: [url],
      runAt: '2026-09-20T08:00:00Z',
      timezone: 'Europe/Rome',
      intervalMinutes: 30,
    };
    expect(createReminderSchema.safeParse(base).success).toBe(true);
    expect(createReminderSchema.safeParse({ ...base, intervalMinutes: 1 }).success).toBe(false);
    expect(createReminderSchema.safeParse({ ...base, sourceUrls: undefined }).success).toBe(false);
    expect(
      createReminderSchema.safeParse({ ...base, quietHours: { startHour: 8, endHour: 8 } }).success,
    ).toBe(false);
  });

  it('resolves quiet hours across the DST transition and a daily notification budget', () => {
    expect(
      nextAllowedNotificationAt(new Date('2026-10-25T00:30:00Z'), 'Europe/Rome', {
        startHour: 22,
        endHour: 8,
      }),
    ).toEqual(new Date('2026-10-25T07:00:00Z'));
    expect(
      nextAllowedNotificationAt(
        new Date('2026-10-24T10:00:00Z'),
        'Europe/Rome',
        { startHour: 22, endHour: 8 },
        true,
      ),
    ).toEqual(new Date('2026-10-25T07:00:00Z'));
  });

  it('seeds a monitor without backfilling and never advances lastNotified on a check', async () => {
    const run = harness(source('version 1'));
    await run.deliver(fixture());
    expect(run.observe).toHaveBeenCalledOnce();
    expect(run.send).not.toHaveBeenCalled();
    expect(run.updates).toContainEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          lastObservedHash: expect.any(String),
          baselineHash: expect.any(String),
        }),
      }),
    );
    expect(JSON.stringify(run.updates)).not.toContain('lastNotifiedAt');
    expect(JSON.stringify(run.updates)).not.toContain('"status":"pending"');
  });

  it('retains a quiet-hours change and sends the coalesced observation in the next window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T22:00:00Z'));
    const baselineHash = snapshotObservation(source('version 1'), [url]).hash;
    const observedHash = snapshotObservation(source('version 2'), [url]).hash;
    const reminder = fixture({ baselineHash, quietHours: { startHour: 22, endHour: 8 } });
    const quiet = harness(source('version 2'));
    await quiet.deliver(reminder);
    expect(quiet.send).not.toHaveBeenCalled();
    expect(quiet.updates.at(-1)).toMatchObject({
      $set: {
        status: 'active',
        reason: 'Quiet hours',
        nextRunAt: new Date('2026-09-20T06:00:00Z'),
      },
    });
    vi.setSystemTime(new Date('2026-09-20T06:00:00Z'));
    const resumed = harness(source('version 2'));
    await resumed.deliver({ ...reminder, lastObservedHash: observedHash });
    expect(resumed.send).toHaveBeenCalledOnce();
    expect(resumed.send.mock.calls[0]?.[0].text).toContain('version 2');
    expect(resumed.updates.at(-1)).toMatchObject({
      $set: {
        lastNotifiedHash: observedHash,
        'delivery.status': 'confirmed',
      },
    });
    const firstDeferred = harness(source('version 1'));
    await firstDeferred.deliver(fixture({ baselineHash, notifyOnFirstObservation: true }));
    expect(firstDeferred.send).toHaveBeenCalledOnce();
  });

  it('distinguishes safe observation failure from an uncertain Telegram delivery', async () => {
    const readFailure = harness(source('version 2'));
    readFailure.observe.mockRejectedValue(new Error('fetch timeout'));
    await readFailure.deliver(fixture());
    expect(readFailure.send).not.toHaveBeenCalled();
    expect(readFailure.updates.at(-1)).toMatchObject({
      $set: { status: 'active', failureCount: 1 },
    });
    const sendFailure = harness(source('version 2'));
    sendFailure.send.mockRejectedValue(new Error('Telegram accepted but connection lost'));
    await sendFailure.deliver(fixture({ notifyOnFirstObservation: true }));
    expect(sendFailure.updates.at(-1)).toMatchObject({
      $set: {
        status: 'delivery_unknown',
        'delivery.status': 'unknown',
      },
    });
    expect(sendFailure.send).toHaveBeenCalledOnce();
  });

  it('renders a fresh report on each scheduled occurrence and rechecks consent before send', async () => {
    const run = harness(source('Latest verified change'));
    await run.deliver(fixture({ kind: 'report' }));
    expect(run.send).toHaveBeenCalledOnce();
    expect(run.send.mock.calls[0]?.[0].text).toContain('Riepilogo aggiornato');
    expect(run.send.mock.calls[0]?.[0].text).toContain(url);
    expect(run.authorize).toHaveBeenCalledTimes(2);
    const revoked = harness(source('change'));
    revoked.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    await revoked.deliver(fixture({ kind: 'report' }));
    expect(revoked.send).not.toHaveBeenCalled();
    expect(revoked.updates.at(-1)).toMatchObject({ $set: { status: 'cancelled' } });
  });

  it('dispatches a natural monitor with only host destination and explicit monitoring policy', async () => {
    const create = vi.fn().mockResolvedValue(fixture({ status: 'active' }));
    await executeReminderOperation({
      service: { create } as never,
      scope,
      args: {
        intent: 'create',
        kind: 'monitor',
        text: 'Avvisami degli aggiornamenti',
        sourceUrls: url,
        intervalMinutes: '30',
        timezone: 'Europe/Rome',
        quietStartHour: '22',
        quietEndHour: '8',
        maxNotificationsPerDay: '3',
      },
      requestKey: 'bot:17:message:999',
      operationId: 'request:0',
      allowWrite: true,
      language: 'it',
      signal: new AbortController().signal,
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      scope,
      kind: 'monitor',
      sourceUrls: [url],
      quietHours: { startHour: 22, endHour: 8 },
      maxNotificationsPerDay: 3,
    });
  });
});
