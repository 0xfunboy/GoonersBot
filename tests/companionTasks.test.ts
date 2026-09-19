import type { Db } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompanionTaskRepository,
  CompanionTaskService,
  createRequestContract,
  type CompanionTask,
} from '../src/companion/tasks/index.js';

function taskFixture(): CompanionTask {
  const now = new Date();
  return {
    id: 'task-a',
    key: 'bot:1:update:2',
    contract: createRequestContract({
      goal: 'Leggi la pagina',
      actorTelegramId: 10,
      chatId: -20,
      threadId: 3,
    }),
    payload: {},
    status: 'running',
    version: 2,
    fence: 8,
    ownerId: 'worker',
    leaseUntil: new Date(now.getTime() + 60000),
    startedAt: now,
    resumeAt: null,
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    revisions: 0,
    consumedMs: 0,
    replaySafe: true,
    summary: '',
    checkpoints: [],
    effects: [],
    events: [],
    messageIds: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('durable companion task boundaries', () => {
  it('fences external intents by owner, claim, revision, live lease and unique effect key', async () => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const repo = new CompanionTaskRepository({
      collection: () => ({ updateOne }),
    } as unknown as Db);
    await repo.beginEffect(
      { id: 'task-a', ownerId: 'worker', fence: 8, version: 2 },
      'deliver:v2:1',
    );
    expect(updateOne.mock.calls[0]?.[0]).toMatchObject({
      id: 'task-a',
      ownerId: 'worker',
      fence: 8,
      version: 2,
      leaseUntil: { $gt: expect.any(Date) },
      'effects.key': { $ne: 'deliver:v2:1' },
    });
    expect(updateOne.mock.calls[0]?.[1]).toMatchObject({
      $push: {
        effects: { key: 'deliver:v2:1', status: 'pending' },
      },
    });
  });

  it('recovers read checkpoints but quarantines an unconfirmed external effect', async () => {
    const safe = taskFixture();
    const unknown = {
      ...taskFixture(),
      id: 'task-b',
      effects: [{ key: 'send:1', status: 'pending' as const, startedAt: new Date() }],
    };
    const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    const repo = new CompanionTaskRepository({
      collection: () => ({
        find: () => ({ limit: () => ({ toArray: async () => [safe, unknown] }) }),
        updateOne,
      }),
    } as unknown as Db);
    expect(await repo.recoverExpired()).toBe(2);
    expect(updateOne.mock.calls[0]?.[1].$set.status).toBe('queued');
    expect(updateOne.mock.calls[1]?.[1].$set.status).toBe('delivery_unknown');
    expect(updateOne.mock.calls[1]?.[0]).toMatchObject({
      id: 'task-b',
      fence: 8,
      version: 2,
      leaseUntil: { $lte: expect.any(Date) },
    });
  });

  it('scopes natural controls and atomically rejects a newly started effect during resume', async () => {
    const task = { ...taskFixture(), status: 'waiting_for_user' };
    const findOne = vi.fn().mockResolvedValue(task);
    const findOneAndUpdate = vi.fn().mockResolvedValue(null);
    const repo = new CompanionTaskRepository({
      collection: () => ({ findOne, findOneAndUpdate }),
    } as unknown as Db);
    const scope = { actorTelegramId: 10, chatId: -20, threadId: 3 };
    expect(
      await repo.control({ taskId: 'task-a', scope, expectedVersion: 2, action: 'resume' }),
    ).toBeNull();
    expect(findOneAndUpdate.mock.calls[0]?.[0]).toMatchObject({
      id: 'task-a',
      version: 2,
      'contract.scope.actorTelegramId': 10,
      'contract.scope.chatId': -20,
      'contract.scope.threadId': 3,
      effects: { $not: { $elemMatch: { status: 'pending' } } },
    });
  });

  it('persists a delivery intent before calling Telegram and refuses success without receipt', async () => {
    const task = taskFixture();
    const order: string[] = [];
    const finish = vi.fn().mockResolvedValue(true);
    const repository = {
      recoverExpired: vi.fn().mockResolvedValue(0),
      claim: vi.fn().mockResolvedValueOnce(task).mockResolvedValue(null),
      hasAuthority: vi.fn().mockResolvedValue(true),
      heartbeat: vi.fn().mockResolvedValue(true),
      beginEffect: vi.fn(async () => {
        order.push('intent');
        return true;
      }),
      confirmEffect: vi.fn(async () => {
        order.push('receipt-failed');
        throw new Error('database unavailable');
      }),
      finish,
    } as unknown as CompanionTaskRepository;
    const service = new CompanionTaskService(repository, {
      execute: async (ctx) => {
        await ctx.effect('deliver:v1:1', async () => {
          order.push('telegram-accepted');
          return { messageId: 42 };
        });
        return {
          status: 'completed',
          summary: 'done',
          deliverables: [{ id: 'answer', verified: true, delivered: true }],
        };
      },
    });
    service.start();
    await vi.waitFor(() => expect(finish).toHaveBeenCalled());
    await service.stop();
    expect(order).toEqual(['intent', 'telegram-accepted', 'receipt-failed']);
    expect(finish.mock.calls[0]?.[1].status).toBe('delivery_unknown');
  });

  it('reuses a confirmed artifact receipt and does not let prose mark undelivered work completed', async () => {
    const task = taskFixture();
    task.effects = [
      {
        key: 'generation:v1',
        status: 'confirmed',
        startedAt: new Date(),
        receipt: { artifactId: 'saved' },
      },
    ];
    const provider = vi.fn();
    const finish = vi.fn().mockResolvedValue(true);
    const repository = {
      recoverExpired: vi.fn().mockResolvedValue(0),
      claim: vi.fn().mockResolvedValueOnce(task).mockResolvedValue(null),
      hasAuthority: vi.fn().mockResolvedValue(true),
      heartbeat: vi.fn().mockResolvedValue(true),
      finish,
    } as unknown as CompanionTaskRepository;
    const service = new CompanionTaskService(repository, {
      execute: async (ctx) => {
        expect(await ctx.effect('generation:v1', provider)).toEqual({ artifactId: 'saved' });
        return { status: 'completed', summary: 'done' };
      },
    });
    service.start();
    await vi.waitFor(() => expect(finish).toHaveBeenCalled());
    await service.stop();
    expect(provider).not.toHaveBeenCalled();
    expect(finish.mock.calls[0]?.[1]).toMatchObject({
      status: 'partial',
      reason: 'Unverified deliverables: answer',
    });
  });
});
