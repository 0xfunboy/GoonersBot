import { describe, expect, it, vi } from 'vitest';
import type { ChatContext, Person } from '../src/domain/types.js';
import {
  adminCommand,
  formatTelegramId,
  idCommand,
  unadminCommand,
} from '../src/telegram/handlers/commands/identity.js';
import type { HandlerInput } from '../src/telegram/handlers/types.js';

const actor: Person = { telegramId: 10, userHandle: '@root', firstName: 'Root' };
const baseContext: ChatContext = {
  chatId: -100,
  isGroup: true,
  isBotMentioned: false,
  isGroupAdmin: false,
  isReplyToBot: false,
};

function input(
  services: Record<string, unknown>,
  options: { args?: string[]; context?: Partial<ChatContext> } = {},
): HandlerInput {
  return {
    services: services as HandlerInput['services'],
    person: actor,
    context: { ...baseContext, ...options.context },
    message: { messageText: '', timestamp: new Date() },
    args: options.args ?? [],
    botUsername: 'GoonersBot',
    addressed: true,
  };
}

function services() {
  const known = {
    handle: '@testuser',
    telegramId: 1_234_567_890,
    firstName: 'Test User',
    lastName: null,
    isPremium: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    storage: {
      users: {
        findByHandle: vi.fn(async (handle: string) =>
          handle.toLowerCase() === '@testuser' ? known : null,
        ),
        getByTelegramId: vi.fn(async (id: number) => (id === known.telegramId ? known : null)),
      },
    },
    permissions: {
      grantBotAdmin: vi.fn(async () => 'granted' as const),
      revokeBotAdmin: vi.fn(async () => 'revoked' as const),
      listRuntimeBotAdmins: vi.fn(async () => []),
    },
    config: { env: { ADMIN_HANDLES: ['@root'] } },
  };
}

describe('identity/admin commands', () => {
  it('/id on a reply uses the exact immutable Telegram id from the replied user', async () => {
    const result = await idCommand.handle(
      input(services(), {
        context: {
          repliedToTelegramId: 1_234_567_890,
          repliedToUserHandle: '@testuser',
          repliedToFirstName: 'Test User',
        },
      }),
    );
    expect(result?.rawText).toContain('1234567890:');
    expect(result?.rawText).toContain('formatted_id: "1.234.567.890"');
    expect(result?.rawText).toContain('username: "@testuser"');
  });

  it('/id accepts a dotted Telegram id and resolves current user metadata', async () => {
    const s = services();
    const result = await idCommand.handle(input(s, { args: ['1.234.567.890'] }));
    expect(s.storage.users.getByTelegramId).toHaveBeenCalledWith(1_234_567_890);
    expect(result?.rawText).toContain('first_name: "Test User"');
    expect(formatTelegramId(1_234_567_890)).toBe('1.234.567.890');
  });

  it('/admin by username persists authority using the resolved Telegram id', async () => {
    const s = services();
    const result = await adminCommand.handle(input(s, { args: ['@testuser'] }));
    expect(s.permissions.grantBotAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ telegramId: 1_234_567_890, userHandle: '@testuser' }),
      actor,
    );
    expect(result?.rawText).toContain('1.234.567.890');
  });

  it('/admin refuses a blind numeric target so a typo cannot promote an unknown id', async () => {
    const s = services();
    const result = await adminCommand.handle(input(s, { args: ['1.234.567.890'] }));
    expect(s.permissions.grantBotAdmin).not.toHaveBeenCalled();
    expect(result?.rawText).toContain('/admin @username');
  });

  it('/admin and /unadmin can target the exact author via reply without username lookup', async () => {
    const s = services();
    const context = {
      repliedToTelegramId: 99,
      repliedToUserHandle: '@id99',
      repliedToFirstName: 'NoUsername',
    };
    await adminCommand.handle(input(s, { context }));
    expect(s.permissions.grantBotAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ telegramId: 99, userHandle: '@id99' }),
      actor,
    );

    const result = await unadminCommand.handle(input(s, { context }));
    expect(s.permissions.revokeBotAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ telegramId: 99 }),
    );
    expect(result?.rawText).toContain('revocata');
  });
});
