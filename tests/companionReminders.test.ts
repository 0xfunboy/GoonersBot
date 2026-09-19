import { describe, expect, it } from 'vitest';
import {
  createReminderSchema,
  nextIntervalAt,
  nextWeeklyAt,
} from '../src/companion/workflows/index.js';

describe('persistent reminder schedules', () => {
  it('coalesces missed interval windows instead of replaying a notification burst', () => {
    expect(
      nextIntervalAt(new Date('2026-09-01T09:00:00Z'), 24 * 60, new Date('2026-09-19T11:00:00Z')),
    ).toEqual(new Date('2026-09-20T09:00:00Z'));
  });

  it('preserves a weekly local hour across the daylight-saving boundary', () => {
    expect(
      nextWeeklyAt(new Date('2026-10-23T09:00:00Z'), 'Europe/Rome', {
        weekdays: [1],
        hour: 9,
        minute: 0,
      }),
    ).toEqual(new Date('2026-10-26T08:00:00Z'));
  });

  it('does not schedule the repeated DST hour twice and skips a nonexistent local hour', () => {
    expect(
      nextWeeklyAt(new Date('2026-10-25T00:30:00Z'), 'Europe/Rome', {
        weekdays: [0],
        hour: 2,
        minute: 30,
      }),
    ).toEqual(new Date('2026-11-01T01:30:00Z'));
    expect(
      nextWeeklyAt(new Date('2026-03-28T08:00:00Z'), 'Europe/Rome', {
        weekdays: [0],
        hour: 2,
        minute: 30,
      }),
    ).toEqual(new Date('2026-04-05T00:30:00Z'));
  });

  it('requires a real timezone and forbids mixing elapsed and wall-clock recurrence', () => {
    const base = {
      key: 'bot:1:2',
      scope: { actorTelegramId: 1, chatId: -2 },
      text: 'Controlla il risultato',
      runAt: '2026-10-01T09:00:00+02:00',
      timezone: 'Europe/Rome',
    };
    expect(createReminderSchema.safeParse(base).success).toBe(true);
    expect(createReminderSchema.safeParse({ ...base, timezone: 'Romeish' }).success).toBe(false);
    expect(
      createReminderSchema.safeParse({
        ...base,
        intervalMinutes: 1,
        weeklyWallTime: { weekdays: [1], hour: 9, minute: 0 },
      }).success,
    ).toBe(false);
  });
});
