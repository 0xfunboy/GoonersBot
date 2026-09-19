import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { InboxCapacityError, UpdateInboxRepo } from '../src/storage/repositories/updateInbox.js';

describe('durable Telegram inbox fencing', () => {
  it('claims only queued work and fences every terminal write by bot, owner and generation', async () => {
    const findOneAndUpdate = vi.fn().mockResolvedValue({ fence: 7 });
    const updateOne = vi
      .fn()
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 });
    const db = {
      collection: () => ({ findOneAndUpdate, updateOne }),
    } as unknown as Db;
    const repo = new UpdateInboxRepo(db);
    const now = new Date('2026-09-19T00:00:00.000Z');

    const claim = await repo.claim('bot-a', 42, 'worker-a', now, 30_000);
    expect(claim).toEqual({ botId: 'bot-a', updateId: 42, ownerId: 'worker-a', fence: 7 });
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { botId: 'bot-a', updateId: 42, status: 'queued' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'running',
          ownerId: 'worker-a',
          leaseUntil: new Date('2026-09-19T00:00:30.000Z'),
        }),
        $inc: { attempts: 1, fence: 1 },
      }),
      { returnDocument: 'after' },
    );

    await expect(repo.complete(claim!)).resolves.toBe(true);
    await expect(repo.complete(claim!)).resolves.toBe(false);
    expect(updateOne.mock.calls[0]?.[0]).toEqual({
      botId: 'bot-a',
      updateId: 42,
      status: 'running',
      ownerId: 'worker-a',
      fence: 7,
    });
  });

  it('quarantines expired running work instead of making it replayable', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 2 });
    const db = {
      collection: () => ({ updateMany }),
    } as unknown as Db;
    const repo = new UpdateInboxRepo(db);
    const now = new Date('2026-09-19T00:00:00.000Z');

    await expect(repo.quarantineExpired('bot-a', now)).resolves.toBe(2);
    expect(updateMany).toHaveBeenCalledWith(
      {
        botId: 'bot-a',
        status: 'running',
        $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: null }],
      },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'outcome_unknown' }),
        $unset: { payload: '' },
      }),
    );
  });

  it('rejects admission when either the durable count or byte budget is exhausted', async () => {
    const findOne = vi.fn().mockResolvedValue(null);
    const aggregate = vi
      .fn()
      .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ count: 2, bytes: 20 }]) })
      .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ count: 1, bytes: 95 }]) });
    const insertOne = vi.fn();
    const db = {
      collection: () => ({ findOne, aggregate, insertOne }),
    } as unknown as Db;
    const repo = new UpdateInboxRepo(db);
    const input = {
      botId: 'bot-a',
      updateId: 1,
      conversationKey: 'chat:1',
      actorTelegramId: 1,
      chatId: 1,
      payload: { update_id: 1, message: { text: 'hello' } },
    };

    await expect(repo.enqueue(input, 2, 1_000)).rejects.toBeInstanceOf(InboxCapacityError);
    await expect(repo.enqueue(input, 10, 100)).rejects.toBeInstanceOf(InboxCapacityError);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('acknowledges an existing bot-scoped receipt without consuming capacity', async () => {
    const findOne = vi.fn().mockResolvedValue({ _id: 'existing' });
    const aggregate = vi.fn();
    const insertOne = vi.fn();
    const db = {
      collection: () => ({ findOne, aggregate, insertOne }),
    } as unknown as Db;
    const repo = new UpdateInboxRepo(db);

    await expect(
      repo.enqueue(
        {
          botId: 'bot-a',
          updateId: 1,
          conversationKey: 'chat:1',
          actorTelegramId: 1,
          chatId: 1,
          payload: { update_id: 1 },
        },
        1,
        1,
      ),
    ).resolves.toBe('duplicate');
    expect(findOne).toHaveBeenCalledWith(
      { botId: 'bot-a', updateId: 1 },
      { projection: { _id: 1 } },
    );
    expect(aggregate).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
  });
});
