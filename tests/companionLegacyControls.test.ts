import { describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';
import { ExistingVisibleWorkReader } from '../src/companion/context/visibleWork.js';
import type { TurnUnderstanding } from '../src/companion/context/contracts.js';
import {
  AnimeArchiveJobsRepo,
  type AnimeArchiveJobDoc,
} from '../src/storage/repositories/animeArchive.js';

const person = { telegramId: 42, userHandle: '@human' };
const context = {
  chatId: -100,
  threadId: 7,
  isGroup: true,
  isGroupAdmin: false,
  isBotMentioned: true,
  isReplyToBot: true,
};
const decision = (kind: string, id = 'archive'): TurnUnderstanding =>
  ({
    interactions: [{ kind, referentIds: [`work:${id}`], objectiveIds: [] }],
    proposedOperations: [],
  }) as unknown as TurnUnderstanding;
const job = (): AnimeArchiveJobDoc =>
  ({
    id: 'archive',
    requesterTelegramId: 42,
    destination: { chatId: -100, threadId: 7 },
    state: 'running',
    scope: 'series',
    series: { title: 'Serie' },
    episodes: [
      { id: 'e6', number: 6, status: 'done', receipt: { messageId: 99 } },
      { id: 'e7', number: 7, status: 'pending' },
    ],
    updatedAt: new Date(),
  }) as AnimeArchiveJobDoc;

describe('natural legacy worker controls', () => {
  it('routes pause to the original archive owner with exact actor/topic/revision fences', async () => {
    const current = job();
    const cancelJob = vi.fn().mockResolvedValue({ ...current, state: 'cancelled', paused: true });
    const jobs = {
      listVisibleForActor: vi.fn().mockResolvedValue([current]),
      get: vi.fn().mockResolvedValue(current),
      cancelJob,
    };
    const reader = new ExistingVisibleWorkReader(
      { animeArchive: { jobs } } as never,
      { enabled: false } as never,
    );
    expect(await reader.control(decision('pause'), person, context, 'it')).toContain('in pausa');
    expect(cancelJob).toHaveBeenCalledWith(
      'archive',
      expect.any(Date),
      expect.objectContaining({
        actorTelegramId: 42,
        chatId: -100,
        threadId: 7,
        updatedAt: current.updatedAt,
      }),
      true,
    );
    expect(
      await reader.control(decision('cancel', 'different-task'), person, context, 'it'),
    ).toBeNull();
    expect(cancelJob).toHaveBeenCalledTimes(1);
  });

  it('refuses a job that moved outside the verified actor/topic scope', async () => {
    const current = job();
    const cancelJob = vi.fn();
    const jobs = {
      listVisibleForActor: vi.fn().mockResolvedValue([current]),
      get: vi.fn().mockResolvedValue({ ...current, requesterTelegramId: 77 }),
      cancelJob,
    };
    const reader = new ExistingVisibleWorkReader(
      { animeArchive: { jobs } } as never,
      { enabled: false } as never,
    );
    expect(await reader.control(decision('cancel'), person, context, 'it')).toBeNull();
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('narrowing to a verified episode keeps completed receipts and refuses uncertain delivery', async () => {
    const current = { ...job(), state: 'cancelled' };
    const findOne = vi.fn().mockResolvedValue(current);
    const findOneAndUpdate = vi.fn().mockResolvedValue(current);
    const repo = new AnimeArchiveJobsRepo({
      collection: () => ({ findOne, findOneAndUpdate }),
    } as unknown as Db);
    const authority = {
      actorTelegramId: 42,
      chatId: -100,
      threadId: 7,
      updatedAt: current.updatedAt,
    };
    await repo.amendEpisode('archive', 7, authority);
    const [filter, update] = findOneAndUpdate.mock.calls[0]!;
    expect(filter).toMatchObject({
      requesterTelegramId: 42,
      'destination.chatId': -100,
      'destination.threadId': 7,
      updatedAt: current.updatedAt,
    });
    expect(update.$set.episodes[0].receipt).toEqual({ messageId: 99 });
    expect(update.$set.episodes[1]).toMatchObject({ id: 'e7', status: 'pending' });
    findOne.mockResolvedValue({
      ...current,
      episodes: [{ ...current.episodes[0], deliveryOutcomeUnknown: true }],
    });
    expect(await repo.amendEpisode('archive', 7, authority)).toBeNull();
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
