import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/index.js';
import { buildMiningWindows, runMemoryMiningJob } from '../src/jobs/memoryMiningJob.js';
import type { LoreEngine } from '../src/memory/loreEngine.js';
import type { SocialLearningPipeline } from '../src/social/index.js';
import type { Storage } from '../src/storage/index.js';
import { buildChatContext } from '../src/telegram/context.js';
import { forgetCommand } from '../src/telegram/handlers/commands/facts.js';
import type { HandlerInput } from '../src/telegram/handlers/types.js';

describe('continuous social mining', () => {
  it('byte-packs every eligible message exactly once while preserving cursor order', () => {
    const timestamp = new Date('2026-07-28T06:00:00.000Z');
    const messages = Array.from({ length: 45 }, (_, index) => ({
      messageId: index + 1,
      handle: '@alice',
      isBot: false,
      message: { messageText: `#${index + 1} ${'x'.repeat(1_000)}`, timestamp },
    }));

    const windows = buildMiningWindows(messages, { timestamp: 0, messageId: 0 }, 20, 30, 5_000);
    const eligibleIds = windows.flatMap((window) => window.eligibleSourceMessageIds);

    expect(eligibleIds).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
    expect(new Set(eligibleIds).size).toBe(45);
    expect(windows.at(-1)?.cursor.messageId).toBe(45);
    expect(windows.length).toBeGreaterThan(2);
  });

  it('never drops or advances past a single oversized message', () => {
    const timestamp = new Date('2026-07-28T06:00:00.000Z');
    const windows = buildMiningWindows(
      [
        {
          messageId: 77,
          handle: '@alice',
          isBot: false,
          message: { messageText: '🧠'.repeat(20_000), timestamp },
        },
      ],
      { timestamp: 0, messageId: 0 },
      20,
      30,
      5_000,
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]?.eligibleSourceMessageIds).toEqual([77]);
    expect(windows[0]?.cursor.messageId).toBe(77);
  });

  it('drains every unseen message in a >30-message burst and disambiguates equal timestamps by id', async () => {
    const timestamp = new Date('2026-07-28T06:00:00.000Z');
    const messages = Array.from({ length: 45 }, (_, index) => ({
      messageId: index + 1,
      handle: index % 2 === 0 ? '@alice' : '@bob',
      isBot: false,
      message: { messageText: `messaggio ${index + 1}`, timestamp },
    }));
    const socialLearn = vi.fn().mockResolvedValue({
      proposed: 1,
      accepted: 1,
      rejected: 0,
      memberProfilesChanged: 1,
      chatStateChanged: false,
    });
    const loreMine = vi.fn().mockResolvedValue({
      stored: 1,
      reinforced: 0,
      updated: 0,
      expired: 0,
      candidates: 1,
    });
    const setLoreMiningCursor = vi.fn();
    const setSocialMiningCursor = vi.fn();
    const storage = {
      chats: {
        listForMining: vi.fn().mockResolvedValue([
          {
            chatId: -100,
            language: 'italian',
            nsfwMode: 'off',
          },
        ]),
        getLoreMiningCursor: vi
          .fn()
          .mockResolvedValue({ timestamp: timestamp.getTime(), messageId: 10 }),
        getSocialMiningCursor: vi
          .fn()
          .mockResolvedValue({ timestamp: timestamp.getTime(), messageId: 10 }),
        setLoreMiningCursor,
        setSocialMiningCursor,
      },
      messages: {
        getRecent: vi.fn().mockResolvedValue(messages),
      },
      jobs: { record: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Storage;
    const config = {
      env: {
        MEMORY_MINING_ENABLED: true,
        MAX_STORED_MESSAGES_PER_CHAT: 500,
        MEMORY_MINING_BATCH_MESSAGES: 20,
        MEMORY_MINING_CONTEXT_MESSAGES: 30,
        MEMORY_AUTO_MIN_CONFIDENCE: 0.75,
      },
      miningLlm: { model: 'gemma-4-31b-it' },
    } as unknown as AppConfig;

    await runMemoryMiningJob(storage, { mineAndStore: loreMine } as unknown as LoreEngine, config, {
      learn: socialLearn,
    } as unknown as SocialLearningPipeline);

    expect(loreMine).toHaveBeenCalledTimes(2);
    expect(socialLearn).toHaveBeenCalledTimes(2);
    expect(loreMine).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eligibleSourceMessageIds: Array.from({ length: 20 }, (_, index) => index + 11),
      }),
    );
    expect(loreMine).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eligibleSourceMessageIds: Array.from({ length: 15 }, (_, index) => index + 31),
      }),
    );
    for (const [request] of loreMine.mock.calls as Array<[{ messages: unknown[] }]>) {
      expect(request.messages.length).toBeLessThanOrEqual(30);
    }
    expect(setLoreMiningCursor).toHaveBeenNthCalledWith(1, -100, {
      timestamp: timestamp.getTime(),
      messageId: 30,
    });
    expect(setLoreMiningCursor).toHaveBeenNthCalledWith(2, -100, {
      timestamp: timestamp.getTime(),
      messageId: 45,
    });
    expect(setSocialMiningCursor).toHaveBeenNthCalledWith(1, -100, {
      timestamp: timestamp.getTime(),
      messageId: 30,
    });
    expect(setSocialMiningCursor).toHaveBeenNthCalledWith(2, -100, {
      timestamp: timestamp.getTime(),
      messageId: 45,
    });
    expect(storage.jobs.record).toHaveBeenCalledWith(
      'continuous_memory_mining',
      'done',
      expect.objectContaining({ chatId: -100, model: 'gemma-4-31b-it' }),
    );
  });

  it('does not advance the social cursor when only the degraded local baseline ran', async () => {
    const setSocialMiningCursor = vi.fn();
    const storage = {
      chats: {
        listForMining: vi.fn().mockResolvedValue([
          {
            chatId: -100,
            language: 'italian',
            nsfwMode: 'off',
          },
        ]),
        getLoreMiningCursor: vi.fn().mockResolvedValue({ timestamp: 0, messageId: 0 }),
        getSocialMiningCursor: vi.fn().mockResolvedValue({ timestamp: 0, messageId: 0 }),
        setLoreMiningCursor: vi.fn(),
        setSocialMiningCursor,
      },
      messages: {
        getRecent: vi.fn().mockResolvedValue([
          {
            messageId: 1,
            handle: '@alice',
            isBot: false,
            message: { messageText: 'adoro il jazz', timestamp: new Date(1_000) },
          },
          {
            messageId: 2,
            handle: '@bob',
            isBot: false,
            message: { messageText: 'ok', timestamp: new Date(2_000) },
          },
        ]),
      },
      jobs: { record: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Storage;
    const config = {
      env: {
        MEMORY_MINING_ENABLED: true,
        MAX_STORED_MESSAGES_PER_CHAT: 500,
        MEMORY_MINING_BATCH_MESSAGES: 20,
        MEMORY_MINING_CONTEXT_MESSAGES: 30,
        MEMORY_AUTO_MIN_CONFIDENCE: 0.75,
      },
      miningLlm: { model: 'gemma-4-31b-it' },
    } as unknown as AppConfig;
    const socialLearn = vi.fn().mockResolvedValue({
      proposed: 1,
      accepted: 1,
      rejected: 0,
      memberProfilesChanged: 1,
      chatStateChanged: false,
      degraded: true,
    });

    await runMemoryMiningJob(
      storage,
      {
        mineAndStore: vi.fn().mockResolvedValue({
          stored: 0,
          reinforced: 0,
          updated: 0,
          expired: 0,
          candidates: 0,
        }),
      } as unknown as LoreEngine,
      config,
      { learn: socialLearn } as unknown as SocialLearningPipeline,
    );

    expect(socialLearn).toHaveBeenCalled();
    expect(setSocialMiningCursor).not.toHaveBeenCalled();
  });
});

describe('Telegram reply identity', () => {
  it('uses the stable id fallback when the replied-to user has no username', async () => {
    const ctx = {
      chat: { id: 1, type: 'private', first_name: 'Alice' },
      from: { id: 10, is_bot: false, first_name: 'Alice' },
      message: {
        message_id: 55,
        date: 1,
        text: 'risposta',
        chat: { id: 1, type: 'private', first_name: 'Alice' },
        from: { id: 10, is_bot: false, first_name: 'Alice' },
        reply_to_message: {
          message_id: 54,
          date: 1,
          text: 'originale',
          chat: { id: 1, type: 'private', first_name: 'Alice' },
          from: { id: 42, is_bot: false, first_name: 'Bob' },
        },
      },
    } as unknown as Context;

    await expect(buildChatContext(ctx, 'GoonersBot')).resolves.toMatchObject({
      repliedToUserHandle: '@id42',
      repliedToMessageId: 54,
    });
  });
});

describe('/forget social provenance', () => {
  it('removes both lore and social observations linked to the replied message', async () => {
    const expireBySourceMessage = vi.fn().mockResolvedValue(0);
    const forgetBySourceMessage = vi.fn().mockResolvedValue(2);
    const findByMessageId = vi.fn().mockResolvedValue({
      messageId: 77,
      handle: '@alice',
      isBot: false,
      message: { messageText: 'dato personale', timestamp: new Date() },
    });
    const result = await forgetCommand.handle({
      services: {
        lore: { expireBySourceMessage },
        social: { forgetBySourceMessage },
        storage: { messages: { findByMessageId } },
        permissions: { isBotAdmin: vi.fn().mockReturnValue(false) },
      },
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: false,
        isReplyToBot: false,
        repliedToMessageId: 77,
      },
      message: { messageText: '/forget', timestamp: new Date() },
      args: [],
      botUsername: 'GoonersBot',
      addressed: true,
    } as unknown as HandlerInput);

    expect(expireBySourceMessage).toHaveBeenCalledWith(-100, 77);
    expect(forgetBySourceMessage).toHaveBeenCalledWith(-100, 77);
    expect(findByMessageId).toHaveBeenCalledWith(-100, 77);
    expect(result?.text).toBe('forget_done');
  });

  it('does not let a non-admin erase observations sourced from another member', async () => {
    const expireBySourceMessage = vi.fn();
    const forgetBySourceMessage = vi.fn();
    const result = await forgetCommand.handle({
      services: {
        lore: { expireBySourceMessage },
        social: { forgetBySourceMessage },
        storage: {
          messages: {
            findByMessageId: vi.fn().mockResolvedValue({
              messageId: 77,
              handle: '@bob',
              isBot: false,
              message: { messageText: 'amo il jazz', timestamp: new Date() },
            }),
          },
        },
        permissions: { isBotAdmin: vi.fn().mockReturnValue(false) },
      },
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: false,
        isReplyToBot: false,
        repliedToMessageId: 77,
      },
      message: { messageText: '/forget', timestamp: new Date() },
      args: [],
      botUsername: 'GoonersBot',
      addressed: true,
    } as unknown as HandlerInput);

    expect(result?.text).toBe('forget_forbidden');
    expect(expireBySourceMessage).not.toHaveBeenCalled();
    expect(forgetBySourceMessage).not.toHaveBeenCalled();
  });

  it('lets a group admin erase observations sourced from another member', async () => {
    const expireBySourceMessage = vi.fn().mockResolvedValue(1);
    const forgetBySourceMessage = vi.fn().mockResolvedValue(0);
    const result = await forgetCommand.handle({
      services: {
        lore: { expireBySourceMessage },
        social: { forgetBySourceMessage },
        storage: {
          messages: {
            findByMessageId: vi.fn().mockResolvedValue({
              messageId: 77,
              handle: '@bob',
              isBot: false,
              message: { messageText: 'amo il jazz', timestamp: new Date() },
            }),
          },
        },
        permissions: { isBotAdmin: vi.fn().mockReturnValue(false) },
      },
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: true,
        isReplyToBot: false,
        repliedToMessageId: 77,
      },
      message: { messageText: '/forget', timestamp: new Date() },
      args: [],
      botUsername: 'GoonersBot',
      addressed: true,
    } as unknown as HandlerInput);

    expect(result?.text).toBe('forget_done');
    expect(expireBySourceMessage).toHaveBeenCalledWith(-100, 77);
    expect(forgetBySourceMessage).toHaveBeenCalledWith(-100, 77);
  });
});
