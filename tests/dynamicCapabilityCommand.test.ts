import { describe, expect, it, vi } from 'vitest';
import type { ChatContext, Person } from '../src/domain/types.js';
import {
  executeDynamicCapabilityTurn,
  tryAcquireDynamicCommandRateLimit,
} from '../src/telegram/handlers/commands/dynamic.js';

const person: Person = { telegramId: 7, userHandle: '@seven' };
const context: ChatContext = {
  chatId: -100,
  isGroup: true,
  isBotMentioned: false,
  isGroupAdmin: false,
  isReplyToBot: false,
};

function dynamicServices(overrides: Record<string, unknown> = {}) {
  const executeCommand = vi.fn().mockResolvedValue({
    handled: true,
    text: 'grounded answer',
    usage: { inputTokens: 13, outputTokens: 7, estimated: false },
    model: 'economy-model',
    sources: [],
  });
  const admitConversation = vi.fn().mockResolvedValue({ allowed: true, tokenReservation: 500 });
  const recordLlmTokens = vi.fn().mockResolvedValue(undefined);
  const recordUsage = vi.fn().mockResolvedValue(undefined);
  return {
    services: {
      commandRateLimit: { tryAcquire: vi.fn().mockReturnValue(true) },
      capabilities: {
        hasCommand: vi.fn().mockReturnValue(true),
        executeCommand,
      },
      usage: {
        isUnderLimit: vi.fn().mockResolvedValue(true),
        getLimit: vi.fn().mockResolvedValue(10_000),
        record: recordUsage,
      },
      quota: { admitConversation, recordLlmTokens },
      bypassesGroupPlan: vi.fn().mockReturnValue(false),
      planForTurn: vi.fn().mockResolvedValue({ id: 'free' }),
      modelForPlan: vi.fn().mockReturnValue('economy-model'),
      llm: { name: 'fallback-router' },
      ...overrides,
    },
    executeCommand,
    admitConversation,
    recordLlmTokens,
    recordUsage,
  };
}

describe('dynamic capability command admission', () => {
  it('uses the static-command cooldown key', () => {
    const { services } = dynamicServices();
    expect(tryAcquireDynamicCommandRateLimit(services as never, -100, 7)).toBe(true);
    expect(services.commandRateLimit.tryAcquire).toHaveBeenCalledWith('-100:7');
  });

  it('admits, routes and records tokens like a normal addressed request', async () => {
    const { services, executeCommand, admitConversation, recordLlmTokens, recordUsage } =
      dynamicServices();
    const result = await executeDynamicCapabilityTurn({
      services: services as never,
      person,
      context,
      command: 'pkgfresh',
      input: 'frobnicator',
      language: 'italian',
    });

    expect(result).toMatchObject({ status: 'completed' });
    expect(admitConversation).toHaveBeenCalledWith({
      chatId: -100,
      telegramId: 7,
      passive: false,
      reserveTokens: true,
    });
    expect(executeCommand).toHaveBeenCalledWith({
      command: 'pkgfresh',
      input: 'frobnicator',
      language: 'italian',
      chatId: -100,
      model: 'economy-model',
    });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: '@seven',
        chatId: -100,
        inputTokens: 13,
        outputTokens: 7,
        points: 20,
      }),
    );
    expect(recordLlmTokens).toHaveBeenCalledWith(-100, 20, 500);
  });

  it('does not execute when group admission is denied', async () => {
    const { services, executeCommand, admitConversation, recordLlmTokens } = dynamicServices();
    admitConversation.mockResolvedValue({
      allowed: false,
      reason: 'conversation_hourly',
      retryAfterSeconds: 120,
    });

    await expect(
      executeDynamicCapabilityTurn({
        services: services as never,
        person,
        context,
        command: 'pkgfresh',
        input: 'frobnicator',
        language: 'italian',
      }),
    ).resolves.toEqual({
      status: 'quota_denied',
      reason: 'conversation_hourly',
      retryAfterSeconds: 120,
    });
    expect(executeCommand).not.toHaveBeenCalled();
    expect(recordLlmTokens).not.toHaveBeenCalled();
  });

  it('releases the reserved estimate when provider execution fails', async () => {
    const { services, executeCommand, recordLlmTokens } = dynamicServices();
    executeCommand.mockRejectedValue(new Error('provider unavailable'));

    await expect(
      executeDynamicCapabilityTurn({
        services: services as never,
        person,
        context,
        command: 'pkgfresh',
        input: 'frobnicator',
        language: 'italian',
      }),
    ).rejects.toThrow('provider unavailable');
    expect(recordLlmTokens).toHaveBeenCalledWith(-100, 0, 500);
  });
});
