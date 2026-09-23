import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { recordCurrentLlmUsage } from '../src/providers/llm/requestContext.js';
import { runCallback, runCommand, type DispatchDeps } from '../src/telegram/dispatch.js';
import type { CallbackSpec, CommandSpec } from '../src/telegram/handlers/types.js';

import { delCommand } from '../src/telegram/handlers/commands/del.js';

function telegramContext(
  kind: 'command' | 'callback' = 'command',
  callbackOwnerId?: number,
): Context {
  const common = {
    chat: { id: -100, type: 'supergroup', title: 'Test chat' },
    from: { id: 7, is_bot: false, first_name: 'Alice', username: 'alice' },
    getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
    reply: vi.fn().mockResolvedValue({ message_id: 99 }),
    replyWithPhoto: vi.fn(),
    replyWithVideo: vi.fn(),
    replyWithVoice: vi.fn(),
    api: {
      token: 'test-token',
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  };
  return {
    ...common,
    ...(kind === 'command'
      ? {
          message: {
            message_id: 11,
            date: 1_700_000_000,
            text: '/meter hello world',
          },
        }
      : {
          callbackQuery: {
            id: 'callback-id',
            data: 'change|value',
            ...(callbackOwnerId === undefined
              ? {}
              : {
                  message: {
                    message_id: 10,
                    date: 1_700_000_000,
                    chat: common.chat,
                    reply_to_message: {
                      message_id: 9,
                      date: 1_700_000_000,
                      chat: common.chat,
                      from: { id: callbackOwnerId, is_bot: false, first_name: 'Owner' },
                    },
                  },
                }),
          },
          answerCallbackQuery: vi.fn().mockResolvedValue(true),
        }),
  } as unknown as Context;
}

function dispatchDeps(overrides: Record<string, unknown> = {}): DispatchDeps {
  const services = {
    commandRateLimit: { tryAcquire: vi.fn().mockReturnValue(true) },
    initializeContext: vi.fn().mockResolvedValue(undefined),
    permissions: { checkAll: vi.fn().mockResolvedValue(true) },
    terms: {
      hasDeclined: vi.fn().mockResolvedValue(false),
      hasAccepted: vi.fn().mockResolvedValue(true),
    },
    isApproved: vi.fn().mockReturnValue(true),
    adminContact: vi.fn().mockReturnValue('@admin'),
    bypassesGroupPlan: vi.fn().mockReturnValue(false),
    usage: {
      isUnderLimit: vi.fn().mockResolvedValue(true),
      getLimit: vi.fn().mockResolvedValue(1_000),
      record: vi.fn().mockResolvedValue(undefined),
    },
    quota: {
      admitConversation: vi.fn().mockResolvedValue({ allowed: true }),
      recordLlmTokens: vi.fn().mockResolvedValue(undefined),
    },
    planForTurn: vi.fn().mockResolvedValue({ id: 'free' }),
    modelForPlan: vi.fn().mockReturnValue('economy-model'),
    config: { llm: { model: 'default-model' } },
    llm: { name: 'test-llm' },
    getLanguage: vi.fn().mockResolvedValue('english'),
    localizer: {
      t: vi.fn((key: string) => key),
    },
    ...overrides,
  };
  return { services: services as unknown as DispatchDeps['services'], botUsername: 'GoonersBot' };
}

const meteredCommand = (handle = vi.fn()): CommandSpec => ({
  command: 'meter',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: 1,
  quotaConversation: true,
  handle,
});

describe('command dispatch accounting', () => {
  it('preflights personal usage and settles provider-metered tokens in both ledgers', async () => {
    const ctx = telegramContext();
    const handle = vi.fn().mockImplementation(async () => {
      recordCurrentLlmUsage({
        inputTokens: 12,
        outputTokens: 8,
        estimated: false,
      });
      return { rawText: 'ok' };
    });
    const deps = dispatchDeps();

    await runCommand(ctx, meteredCommand(handle), deps);

    expect(deps.services.usage.isUnderLimit).toHaveBeenCalledWith(
      '@alice',
      '/meter hello world',
      false,
      false,
    );
    expect(deps.services.quota.admitConversation).toHaveBeenCalledWith({
      chatId: -100,
      telegramId: 7,
      passive: false,
      reserveTokens: false,
    });
    expect(deps.services.quota.recordLlmTokens).toHaveBeenCalledWith(-100, 20, 0);
    expect(deps.services.usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: '@alice',
        chatId: -100,
        provider: 'test-llm',
        model: 'economy-model',
        inputTokens: 12,
        outputTokens: 8,
        points: 20,
      }),
    );
    expect(handle).toHaveBeenCalledOnce();
  });

  it('rejects an over-limit command before group admission or handler work', async () => {
    const ctx = telegramContext();
    const handle = vi.fn();
    const deps = dispatchDeps({
      usage: {
        isUnderLimit: vi.fn().mockResolvedValue(false),
        getLimit: vi.fn().mockResolvedValue(50),
        record: vi.fn(),
      },
    });

    await runCommand(ctx, meteredCommand(handle), deps);

    expect(handle).not.toHaveBeenCalled();
    expect(deps.services.quota.admitConversation).not.toHaveBeenCalled();
    expect(deps.services.usage.getLimit).toHaveBeenCalledWith('@alice');
    expect(ctx.reply).toHaveBeenCalledWith(
      'usage_limit_exceeded',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('records successful generated-media usage even when the command used no LLM', async () => {
    const ctx = telegramContext();
    const handle = vi.fn().mockResolvedValue({
      rawText: 'done',
      imageBuffer: Buffer.from('image'),
      usage: { imageCalls: 1 },
    });
    const deps = dispatchDeps();

    await runCommand(ctx, meteredCommand(handle), deps);

    expect(deps.services.usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        imageCalls: 1,
        points: 100,
      }),
    );
  });

  it('deletes replied message and origin command message when requested (used by /del)', async () => {
    const ctx = telegramContext();
    const handle = vi.fn().mockResolvedValue({
      deleteRepliedMessage: 42,
      deleteOriginCommand: true,
    });
    const deps = dispatchDeps();

    await runCommand(ctx, meteredCommand(handle), deps);

    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(-100, 42);
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(-100, 11);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('delCommand rejects when not used in reply to a message', async () => {
    const result = await delCommand.handle({
      services: {} as any,
      person: { telegramId: 1, userHandle: '@admin' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: true,
        isReplyToBot: false,
      },
      message: { messageText: '/del', timestamp: new Date() },
      args: [],
      botUsername: 'GoonersBot',
      addressed: true,
    });
    expect(result).toEqual({
      text: 'del_needs_reply',
      ephemeralMs: 5000,
      deleteOriginCommand: true,
    });
  });

  it('delCommand rejects when replying to a non-bot message', async () => {
    const result = await delCommand.handle({
      services: {} as any,
      person: { telegramId: 1, userHandle: '@admin' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: true,
        isReplyToBot: false,
        repliedToMessageId: 42,
      },
      message: { messageText: '/del', timestamp: new Date() },
      args: [],
      botUsername: 'GoonersBot',
      addressed: true,
    });
    expect(result).toEqual({
      text: 'del_not_bot_message',
      ephemeralMs: 5000,
      deleteOriginCommand: true,
    });
  });

  it('delCommand succeeds and returns delete instructions when replying to a bot message', async () => {
    const result = await delCommand.handle({
      services: {} as any,
      person: { telegramId: 1, userHandle: '@admin' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: true,
        isReplyToBot: true,
        repliedToMessageId: 55,
      },
      message: { messageText: '/del', timestamp: new Date() },
      args: [],
      botUsername: 'GoonersBot',
      addressed: true,
    });
    expect(result).toEqual({
      deleteRepliedMessage: 55,
      deleteOriginCommand: true,
    });
  });
});

describe('callback approval gate', () => {
  const callback = (approvalExempt = false, handle = vi.fn()): CallbackSpec => ({
    action: 'change',
    permissions: ['allowed_user', 'not_banned'],
    needsTermsAccepted: false,
    approvalExempt,
    handle,
  });

  it('blocks non-onboarding callbacks in an unapproved chat', async () => {
    const ctx = telegramContext('callback');
    const handle = vi.fn();
    const deps = dispatchDeps({ isApproved: vi.fn().mockReturnValue(false) });

    await runCallback(ctx, callback(false, handle), deps);

    expect(handle).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'approval_required',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('lets explicitly public onboarding callbacks run before approval', async () => {
    const ctx = telegramContext('callback');
    const handle = vi.fn().mockResolvedValue({ rawText: 'accepted' });
    const deps = dispatchDeps({ isApproved: vi.fn().mockReturnValue(false) });

    await runCallback(ctx, callback(true, handle), deps);

    expect(handle).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith(
      'accepted',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('keeps a consumed action prompt in chat while removing its keyboard', async () => {
    const ctx = telegramContext('callback', 7);
    const handle = vi.fn().mockResolvedValue({ rawText: 'queued', clearOriginKeyboard: true });
    const deps = dispatchDeps();

    await runCallback(ctx, { ...callback(true, handle), ownerOnly: true }, deps);

    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(-100, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(ctx.reply).toHaveBeenCalledWith(
      'queued',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('ignores an owner-only keyboard pressed by a different group member', async () => {
    const ctx = telegramContext('callback', 99);
    const handle = vi.fn();
    const deps = dispatchDeps();

    await runCallback(ctx, { ...callback(true, handle), ownerOnly: true }, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
    expect(handle).not.toHaveBeenCalled();
    expect(deps.services.initializeContext).not.toHaveBeenCalled();
  });
});
