import { describe, expect, it, vi } from 'vitest';
import type { ChatContext, Person } from '../src/domain/types.js';
import {
  botinfoCommand,
  hardwareCommand,
  hostScopesFromArgs,
  modelsCommand,
  quotaCommand,
} from '../src/telegram/handlers/commands/systemInfo.js';
import type { HandlerInput } from '../src/telegram/handlers/types.js';

const person: Person = { telegramId: 7, userHandle: '@allowed' };
const context: ChatContext = {
  chatId: -100,
  isGroup: true,
  isBotMentioned: true,
  isGroupAdmin: false,
  isReplyToBot: false,
};

function input(services: unknown, args: string[] = []): HandlerInput {
  return {
    services: services as HandlerInput['services'],
    person,
    context,
    message: { messageText: '', timestamp: new Date() },
    args,
    botUsername: 'GoonersBot',
    addressed: true,
  };
}

describe('system information commands', () => {
  it('maps focused hardware arguments to the minimum collector scope', () => {
    expect(hostScopesFromArgs([])).toEqual(['hardware', 'sensors', 'storage']);
    expect(hostScopesFromArgs(['temperatura', 'ventole'])).toEqual(['sensors']);
    expect(hostScopesFromArgs(['cpu', 'e', 'dischi'])).toEqual(['hardware', 'storage']);
  });

  it('serves hardware, model, and quota reports without conversational quota admission', async () => {
    const report = vi.fn().mockResolvedValue('safe report');
    const services = {
      systemInfo: { report },
      bypassesGroupPlan: vi.fn().mockReturnValue(false),
    };

    await expect(hardwareCommand.handle(input(services, ['temp']))).resolves.toMatchObject({
      rawText: 'safe report',
      textFormat: 'plain',
    });
    expect(report).toHaveBeenLastCalledWith({
      chatId: -100,
      scopes: ['sensors'],
      operatorSession: false,
    });

    await modelsCommand.handle(input(services));
    expect(report).toHaveBeenLastCalledWith({
      chatId: -100,
      scopes: ['models'],
      operatorSession: false,
    });

    await quotaCommand.handle(input(services));
    expect(report).toHaveBeenLastCalledWith({
      chatId: -100,
      scopes: ['quota'],
      operatorSession: false,
    });

    for (const command of [hardwareCommand, modelsCommand, quotaCommand, botinfoCommand]) {
      expect(command.quotaConversation).not.toBe(true);
      expect(command.permissions).toEqual(['allowed_user', 'not_banned']);
    }
  });

  it('/botinfo exposes stable project facts but no endpoint or network details', async () => {
    const t = vi
      .fn()
      .mockReturnValue(
        'GoonersBot / GooNeuroBot — creato da funboy, TypeScript strict, GemRouter di funboy.',
      );
    const response = await botinfoCommand.handle(
      input({ getLanguage: vi.fn().mockResolvedValue('italian'), localizer: { t } }),
    );

    expect(response?.rawText).toContain('funboy');
    expect(response?.rawText).toContain('TypeScript');
    expect(response?.rawText).toContain('GemRouter');
    expect(response?.textFormat).toBe('plain');
  });
});
