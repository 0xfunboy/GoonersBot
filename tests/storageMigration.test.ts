import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { Storage } from '../src/storage/index.js';
import { ChatsRepo } from '../src/storage/repositories/chats.js';
import {
  ACTIVE_MEMORY_SUBJECT_TEXT_UNIQUE_INDEX,
  MemoryItemsRepo,
} from '../src/storage/repositories/memoryItems.js';

describe('storage migration compatibility', () => {
  it('resumes a partial legacy-fact migration and never resurrects an existing expired item', async () => {
    const facts = [
      {
        chatId: -100,
        userHandle: '@alice',
        fact: 'Alice monta video',
        source: 'manual',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        chatId: -100,
        userHandle: '@bob',
        fact: 'Bob usa Blender',
        source: 'introduction',
        createdAt: new Date('2025-01-02T00:00:00Z'),
      },
    ];
    const memories: Array<Record<string, unknown>> = [
      {
        chatId: -100,
        subjectType: 'user',
        subjectHandle: '@alice',
        normalizedText: 'alice monta video',
        source: 'migration',
        status: 'expired',
      },
    ];
    const insertOne = vi.fn(async (doc: Record<string, unknown>) => {
      memories.push(doc);
      return { insertedId: 'new-memory' };
    });
    const db = {
      collection(name: string) {
        if (name === 'facts') {
          return { find: () => ({ toArray: async () => facts }) };
        }
        if (name === 'memory_items') {
          return {
            findOne: async (filter: {
              chatId: number;
              subjectType: string;
              subjectHandle: string | null;
              normalizedText: string;
            }) =>
              memories.find(
                (memory) =>
                  memory['chatId'] === filter.chatId &&
                  memory['subjectType'] === filter.subjectType &&
                  memory['subjectHandle'] === filter.subjectHandle &&
                  memory['normalizedText'] === filter.normalizedText,
              ) ?? null,
            insertOne,
          };
        }
        throw new Error(`unexpected collection ${name}`);
      },
    } as unknown as Db;
    const migrate = Storage.prototype.migrateLegacyFacts as unknown as (this: {
      db: Db;
    }) => Promise<number>;

    expect(await migrate.call({ db })).toBe(1);
    expect(await migrate.call({ db })).toBe(0);
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(memories).toContainEqual(
      expect.objectContaining({
        chatId: -100,
        subjectHandle: '@bob',
        normalizedText: 'bob usa blender',
        category: 'role',
        source: 'migration',
        status: 'active',
        revision: 1,
        history: [],
      }),
    );
    expect(
      memories.filter((memory) => memory['normalizedText'] === 'alice monta video'),
    ).toHaveLength(1);
  });

  it('installs the subject-aware unique index before removing the legacy named index', async () => {
    const createIndex = vi.fn(async () => 'created');
    const dropIndex = vi.fn(async () => undefined);
    const indexes = vi.fn(async () => [
      { name: '_id_', key: { _id: 1 }, unique: true },
      {
        name: 'legacy_custom_name',
        key: { chatId: 1, normalizedText: 1 },
        unique: true,
        partialFilterExpression: { status: 'active' },
      },
    ]);
    const db = {
      collection: () => ({ createIndex, dropIndex, indexes }),
    } as unknown as Db;

    await MemoryItemsRepo.ensureIndexes(db);

    expect(createIndex).toHaveBeenCalledWith(
      { chatId: 1, subjectType: 1, subjectHandle: 1, normalizedText: 1 },
      {
        name: ACTIVE_MEMORY_SUBJECT_TEXT_UNIQUE_INDEX,
        unique: true,
        partialFilterExpression: { status: 'active' },
      },
    );
    expect(dropIndex).toHaveBeenCalledWith('legacy_custom_name');
    expect(createIndex.mock.invocationCallOrder.at(-1) as number).toBeLessThan(
      dropIndex.mock.invocationCallOrder[0] as number,
    );
  });

  it('writes mining cursors monotonically and ignores invalid timestamps', async () => {
    const updateOne = vi.fn(async () => ({ acknowledged: true }));
    const db = {
      collection: () => ({ updateOne }),
    } as unknown as Db;
    const chats = new ChatsRepo(db);

    await chats.setLastMinedAt(-100, 200);
    await chats.setLastSocialMinedAt(-100, 300);
    await chats.setLastSocialMinedAt(-100, Number.NaN);

    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenNthCalledWith(
      1,
      { chatId: -100 },
      {
        $max: { lastMinedAt: 200 },
        $set: { updatedAt: expect.any(Date) },
      },
    );
    expect(updateOne).toHaveBeenNthCalledWith(
      2,
      { chatId: -100 },
      {
        $max: { lastSocialMinedAt: 300 },
        $set: { updatedAt: expect.any(Date) },
      },
    );
  });

  it('atomically stops every autonomous feature when Telegram reports removal', async () => {
    const updateOne = vi.fn(async () => ({ acknowledged: true }));
    const db = {
      collection: () => ({ updateOne }),
    } as unknown as Db;
    const chats = new ChatsRepo(db);

    await chats.setTelegramMembership(-100, 'kicked', {
      chatName: 'Removed group',
      audited: true,
    });

    expect(updateOne).toHaveBeenCalledWith(
      { chatId: -100 },
      {
        $set: expect.objectContaining({
          telegramMembershipStatus: 'kicked',
          chatName: 'Removed group',
          isStarted: false,
          autoengage: false,
          autopost: false,
          conversationTracker: false,
          telegramMembershipAuditedAt: expect.any(Date),
        }),
      },
    );
  });

  it('requires approval and active Telegram membership in the mining query', async () => {
    const find = vi.fn(() => ({ toArray: async () => [] }));
    const db = {
      collection: () => ({ find }),
    } as unknown as Db;
    const chats = new ChatsRepo(db);

    await chats.listForMining([-100, -200]);

    expect(find).toHaveBeenCalledWith(
      {
        chatId: { $in: [-100, -200] },
        isStarted: true,
        telegramMembershipStatus: { $in: ['member', 'administrator'] },
      },
      { projection: { chatId: 1, language: 1, nsfwMode: 1 } },
    );
  });
});
