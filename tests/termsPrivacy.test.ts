import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { TermsService } from '../src/services/terms.js';
import { MongoSocialProfileStore } from '../src/social/mongoStore.js';
import { MemoryItemsRepo } from '../src/storage/repositories/memoryItems.js';
import { fakeStorage } from './helpers.js';

describe('terms-decline privacy cleanup', () => {
  it('clears legacy and durable memory/social data before recording the refusal', async () => {
    const deleteMessages = vi.fn().mockResolvedValue(undefined);
    const deleteFacts = vi.fn().mockResolvedValue(undefined);
    const deleteModes = vi.fn().mockResolvedValue(undefined);
    const scrubPii = vi.fn().mockResolvedValue(undefined);
    const deleteMemory = vi.fn().mockResolvedValue(3);
    const deleteSocial = vi.fn().mockResolvedValue({ membersDeleted: 2, chatStatesUpdated: 2 });
    const recordDecline = vi.fn().mockResolvedValue(undefined);
    const terms = new TermsService(
      fakeStorage({
        messages: { deleteByUser: deleteMessages },
        facts: { deleteByUser: deleteFacts },
        modes: { deleteByCreator: deleteModes },
        users: { scrubPii },
        memoryItems: { deleteByHandleEverywhere: deleteMemory },
        socialProfiles: { deleteByHandleEverywhere: deleteSocial },
        terms: { decline: recordDecline },
      }),
    );

    await terms.decline('@Alice');

    for (const cleanup of [
      deleteMessages,
      deleteFacts,
      deleteModes,
      scrubPii,
      deleteMemory,
      deleteSocial,
    ]) {
      expect(cleanup).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledWith('@Alice');
      expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
        recordDecline.mock.invocationCallOrder[0]!,
      );
    }
    expect(recordDecline).toHaveBeenCalledWith('@Alice');
  });

  it('hard-deletes every memory status tied to the handle across chats', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 4 });
    const db = {
      collection: () => ({ deleteMany }),
    } as unknown as Db;
    const repo = new MemoryItemsRepo(db);

    expect(await repo.deleteByHandleEverywhere(' Alice ')).toBe(4);
    expect(deleteMany).toHaveBeenCalledWith(
      {
        $or: [
          { subjectHandle: '@alice' },
          { involvedHandles: '@alice' },
          { createdByHandle: '@alice' },
        ],
      },
      { collation: { locale: 'en', strength: 2 } },
    );
  });

  it('deletes linked profiles and removes both relationship directions and targeted jokes', async () => {
    const find = vi.fn(() => ({
      toArray: vi.fn().mockResolvedValue([
        {
          handle: '@alice',
          aliases: ['@AliceOld', 'la sindaca'],
        },
      ]),
    }));
    const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 3 });
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 2 });
    const db = {
      collection(name: string) {
        if (name === 'social_member_profiles') return { find, deleteMany };
        if (name === 'social_chat_states') return { updateMany };
        throw new Error(`unexpected collection ${name}`);
      },
    } as unknown as Db;
    const store = new MongoSocialProfileStore(db);

    await expect(store.deleteByHandleEverywhere('ALICE')).resolves.toEqual({
      membersDeleted: 3,
      chatStatesUpdated: 2,
    });
    expect(deleteMany).toHaveBeenCalledWith(
      {
        $or: [
          { handle: { $in: ['@alice', '@aliceold'] } },
          { aliases: { $in: ['@alice', '@aliceold'] } },
        ],
      },
      { collation: { locale: 'en', strength: 2 } },
    );
    expect(updateMany).toHaveBeenCalledOnce();
    const [filter, pipeline] = updateMany.mock.calls[0]!;
    expect(filter).toEqual({
      $or: [
        { 'relationships.fromHandle': { $in: ['@alice', '@aliceold'] } },
        { 'relationships.toHandle': { $in: ['@alice', '@aliceold'] } },
        { 'runningJokes.targetHandles': { $in: ['@alice', '@aliceold'] } },
      ],
    });
    expect(pipeline).toEqual([
      {
        $set: {
          relationships: {
            $filter: {
              input: { $ifNull: ['$relationships', []] },
              as: 'relationship',
              cond: {
                $and: [
                  {
                    $eq: [{ $in: ['$$relationship.fromHandle', ['@alice', '@aliceold']] }, false],
                  },
                  {
                    $eq: [{ $in: ['$$relationship.toHandle', ['@alice', '@aliceold']] }, false],
                  },
                ],
              },
            },
          },
          runningJokes: {
            $filter: {
              input: { $ifNull: ['$runningJokes', []] },
              as: 'joke',
              cond: {
                $eq: [
                  {
                    $size: {
                      $setIntersection: [
                        { $ifNull: ['$$joke.targetHandles', []] },
                        ['@alice', '@aliceold'],
                      ],
                    },
                  },
                  0,
                ],
              },
            },
          },
          updatedAt: expect.any(Date),
          version: { $add: [{ $ifNull: ['$version', 0] }, 1] },
        },
      },
    ]);
    expect(updateMany.mock.calls[0]?.[2]).toEqual({
      collation: { locale: 'en', strength: 2 },
    });
  });

  it('turns an empty handle into a no-op instead of a broad delete', async () => {
    const memoryDelete = vi.fn();
    const memberFind = vi.fn();
    const memberDelete = vi.fn();
    const chatUpdate = vi.fn();
    const memoryRepo = new MemoryItemsRepo({
      collection: () => ({ deleteMany: memoryDelete }),
    } as unknown as Db);
    const socialStore = new MongoSocialProfileStore({
      collection(name: string) {
        return name === 'social_member_profiles'
          ? { find: memberFind, deleteMany: memberDelete }
          : { updateMany: chatUpdate };
      },
    } as unknown as Db);

    await expect(memoryRepo.deleteByHandleEverywhere('   ')).resolves.toBe(0);
    await expect(socialStore.deleteByHandleEverywhere('   ')).resolves.toEqual({
      membersDeleted: 0,
      chatStatesUpdated: 0,
    });
    expect(memoryDelete).not.toHaveBeenCalled();
    expect(memberFind).not.toHaveBeenCalled();
    expect(memberDelete).not.toHaveBeenCalled();
    expect(chatUpdate).not.toHaveBeenCalled();
  });
});
