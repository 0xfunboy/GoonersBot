import { describe, expect, it, vi } from 'vitest';
import { executeReminderOperation } from '../src/companion/workflows/execute.js';

const scope = { actorTelegramId: 17, chatId: -100, threadId: 3 };
const reminder = {
  id: 'one',
  version: 2,
  text: 'Controllare il report',
  timezone: 'Europe/Rome',
  nextRunAt: new Date('2026-09-21T08:00:00Z'),
  status: 'active',
};

describe('natural reminder dispatch authority', () => {
  it('uses host scope and a stable effect key even when model arguments contain other destinations', async () => {
    const create = vi.fn().mockResolvedValue(reminder);
    const input = {
      service: { create } as never,
      scope,
      requestKey: 'bot:1:update:50',
      operationId: 'request:0',
      args: {
        intent: 'create',
        text: reminder.text,
        delayMinutes: '20',
        actorTelegramId: 99,
        chatId: -500,
      },
      allowWrite: true,
      language: 'italian',
      signal: new AbortController().signal,
    };
    const first = await executeReminderOperation(input);
    await executeReminderOperation(input);
    expect(create.mock.calls[0]?.[0].scope).toEqual(scope);
    expect(create.mock.calls[0]?.[0].key).toBe(create.mock.calls[1]?.[0].key);
    expect(first.data).toMatchObject({ receiptId: 'one', status: 'active' });
  });

  it('asks which reminder the user means instead of cancelling an arbitrary match', async () => {
    const cancel = vi.fn();
    const result = await executeReminderOperation({
      service: {
        list: vi
          .fn()
          .mockResolvedValue([reminder, { ...reminder, id: 'two', text: 'Controllare il budget' }]),
        cancel,
      } as never,
      scope,
      args: { intent: 'cancel', match: 'Controllare' },
      allowWrite: true,
      language: 'italian',
      operationId: 'cancel',
      signal: new AbortController().signal,
    });
    expect(result.summary).toContain('Quale promemoria');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('refuses writes when host permission is absent', async () => {
    const create = vi.fn();
    await expect(
      executeReminderOperation({
        service: { create } as never,
        scope,
        args: { intent: 'create', text: 'test', delayMinutes: '10' },
        allowWrite: false,
        language: 'italian',
        operationId: 'create',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('host authorization');
    expect(create).not.toHaveBeenCalled();
  });
});
