import { describe, expect, it, vi } from 'vitest';
import { modeCommand, addmodeCommand } from '../src/telegram/handlers/commands/modes.js';
import { clearfactsCommand } from '../src/telegram/handlers/commands/facts.js';
import { nsfwCommand } from '../src/telegram/handlers/commands/nsfw.js';
import { callbackHandlers } from '../src/telegram/handlers/callbacks/index.js';
import type { HandlerInput } from '../src/telegram/handlers/types.js';
import type { ChatContext, Person } from '../src/domain/types.js';

const person: Person = { telegramId: 1, userHandle: '@bob' };
const context = (over: Partial<ChatContext> = {}): ChatContext => ({
  chatId: -1,
  isGroup: true,
  isBotMentioned: false,
  isGroupAdmin: false,
  isReplyToBot: false,
  ...over,
});

function input(services: unknown, args: string[], ctx = context()): HandlerInput {
  return {
    services: services as HandlerInput['services'],
    person,
    context: ctx,
    message: { messageText: '', timestamp: new Date() },
    args,
    botUsername: 'GoonerBot',
    addressed: true,
  };
}

describe('mode commands', () => {
  it('/mode returns a modes keyboard', async () => {
    const services = {
      modes: { list: vi.fn().mockResolvedValue([{ id: 'm1', name: 'Roast' }]) },
    };
    const res = await modeCommand.handle(input(services, []));
    expect(res?.text).toBe('choose_mode');
    expect(res?.keyboard?.options).toEqual([{ id: 'm1', label: 'Roast' }]);
    expect(res?.keyboard?.buttonAction).toBe('set_chat_mode');
  });

  it('/addmode stores a custom mode', async () => {
    const services = { modes: { add: vi.fn().mockResolvedValue('Hype') } };
    const res = await addmodeCommand.handle(input(services, ['Hype.', 'loud', 'energy']));
    expect(res?.text).toBe('mode_added');
    expect(res?.vars).toEqual({ mode_name: 'Hype' });
  });

  it('/addmode with empty args is rejected', async () => {
    const services = { modes: { add: vi.fn() } };
    const res = await addmodeCommand.handle(input(services, []));
    expect(res?.text).toBe('invalid_mode_args');
  });
});

describe('set/delete mode callbacks', () => {
  const setMode = callbackHandlers.find((c) => c.action === 'set_chat_mode')!;
  const delMode = callbackHandlers.find((c) => c.action === 'delete_chat_mode')!;

  it('set_chat_mode activates a mode', async () => {
    const services = {
      modes: {
        getNameById: vi.fn().mockResolvedValue('Roast'),
        setActive: vi.fn().mockResolvedValue(true),
      },
    };
    const res = await setMode.handle(input(services, ['m1']));
    expect(res?.text).toBe('mode_set');
    expect(res?.vars).toEqual({ mode_name: 'Roast' });
  });

  it('delete_chat_mode deletes a mode', async () => {
    const services = {
      modes: {
        getNameById: vi.fn().mockResolvedValue('Roast'),
        delete: vi.fn().mockResolvedValue(true),
      },
    };
    const res = await delMode.handle(input(services, ['m1']));
    expect(res?.text).toBe('mode_deleted');
  });
});

describe('terms callback', () => {
  const terms = callbackHandlers.find((c) => c.action === 'terms_response')!;

  it('accept records acceptance', async () => {
    const accept = vi.fn().mockResolvedValue(undefined);
    const services = { terms: { accept, decline: vi.fn() } };
    const res = await terms.handle(input(services, ['accept']));
    expect(accept).toHaveBeenCalledWith('@bob');
    expect(res?.text).toBe('terms_accepted');
  });

  it('decline wipes data', async () => {
    const decline = vi.fn().mockResolvedValue(undefined);
    const services = { terms: { accept: vi.fn(), decline } };
    const res = await terms.handle(input(services, ['decline']));
    expect(decline).toHaveBeenCalledWith('@bob');
    expect(res?.text).toBe('terms_declined');
  });
});

describe('/nsfw command', () => {
  function nsfwServices(opts: { configured: boolean; current?: string }) {
    return {
      modelRouter: { nsfwConfigured: opts.configured },
      storage: {
        chats: {
          getNsfwMode: vi.fn().mockResolvedValue(opts.current ?? 'off'),
          setNsfwMode: vi.fn().mockResolvedValue(undefined),
        },
      },
      config: { env: { LLM_NSFW_DEFAULT_MODE: 'off' } },
    };
  }

  it('reports unavailable when no NSFW model configured', async () => {
    const services = nsfwServices({ configured: false });
    const res = await nsfwCommand.handle(
      input(services, ['base'], context({ isGroupAdmin: true })),
    );
    expect(res?.text).toBe('nsfw_unavailable');
  });

  it('sets base mode (on => base)', async () => {
    const services = nsfwServices({ configured: true });
    const res = await nsfwCommand.handle(input(services, ['on'], context({ isGroupAdmin: true })));
    expect(res?.text).toBe('nsfw_set_base');
    expect(services.storage.chats.setNsfwMode).toHaveBeenCalledWith(-1, 'base');
  });

  it('sets smart mode', async () => {
    const services = nsfwServices({ configured: true });
    const res = await nsfwCommand.handle(
      input(services, ['smart'], context({ isGroupAdmin: true })),
    );
    expect(res?.text).toBe('nsfw_set_smart');
  });

  it('rejects invalid arg', async () => {
    const services = nsfwServices({ configured: true });
    const res = await nsfwCommand.handle(
      input(services, ['maybe'], context({ isGroupAdmin: true })),
    );
    expect(res?.text).toBe('nsfw_invalid');
  });

  it('reports status with no arg', async () => {
    const services = nsfwServices({ configured: true, current: 'smart' });
    const res = await nsfwCommand.handle(input(services, [], context({ isGroupAdmin: true })));
    expect(res?.text).toBe('nsfw_status');
    expect(res?.vars).toEqual({ mode: 'smart' });
  });
});

describe('clearfacts permission adaptation', () => {
  const notBotAdmin = { isBotAdmin: () => false };

  it('blocks clearing another user’s facts without admin', async () => {
    const services = { facts: { clearForUser: vi.fn() }, permissions: notBotAdmin };
    const res = await clearfactsCommand.handle(
      input(services, ['@alice'], context({ isGroupAdmin: false })),
    );
    expect(res?.text).toBe('clearfacts_forbidden');
    expect(services.facts.clearForUser as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('allows self-clear for anyone', async () => {
    const clearForUser = vi.fn().mockResolvedValue(0);
    const services = { facts: { clearForUser }, permissions: notBotAdmin };
    const res = await clearfactsCommand.handle(
      input(services, [], context({ isGroupAdmin: false })),
    );
    expect(res?.text).toBe('facts_cleared');
    expect(clearForUser).toHaveBeenCalledWith(-1, '@bob');
  });

  it('allows admins to clear others', async () => {
    const clearForUser = vi.fn().mockResolvedValue(2);
    const services = { facts: { clearForUser }, permissions: notBotAdmin };
    const res = await clearfactsCommand.handle(
      input(services, ['@alice'], context({ isGroupAdmin: true })),
    );
    expect(res?.text).toBe('facts_cleared');
    expect(clearForUser).toHaveBeenCalledWith(-1, '@alice');
  });

  it('allows a bot admin to clear others even without group admin', async () => {
    const clearForUser = vi.fn().mockResolvedValue(1);
    const services = { facts: { clearForUser }, permissions: { isBotAdmin: () => true } };
    const res = await clearfactsCommand.handle(
      input(services, ['@alice'], context({ isGroupAdmin: false })),
    );
    expect(res?.text).toBe('facts_cleared');
  });
});
