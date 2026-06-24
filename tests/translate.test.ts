import { describe, expect, it, vi } from 'vitest';
import {
  parseTargetLanguage,
  translateCommand,
} from '../src/telegram/handlers/commands/translate.js';
import type { HandlerInput } from '../src/telegram/handlers/types.js';
import type { ChatContext, Person } from '../src/domain/types.js';

describe('parseTargetLanguage', () => {
  it('parses a bare language', () => {
    expect(parseTargetLanguage(['spagnolo'])).toBe('Spanish');
    expect(parseTargetLanguage(['english'])).toBe('English');
  });
  it('parses natural phrasing with a connective', () => {
    expect(parseTargetLanguage(['questo', 'messaggio', 'in', 'spagnolo'])).toBe('Spanish');
    expect(parseTargetLanguage(['in', 'inglese'])).toBe('English');
    expect(parseTargetLanguage(['to', 'german'])).toBe('German');
  });
  it('returns null when no target is given', () => {
    expect(parseTargetLanguage([])).toBeNull();
  });
  it('falls back to the trailing token for unlisted languages', () => {
    expect(parseTargetLanguage(['in', 'swahili'])).toBe('swahili');
  });
});

const person: Person = { telegramId: 1, userHandle: '@bob' };
const ctx = (over: Partial<ChatContext> = {}): ChatContext => ({
  chatId: -1,
  isGroup: true,
  isBotMentioned: false,
  isGroupAdmin: false,
  isReplyToBot: false,
  ...over,
});
function input(services: unknown, context: ChatContext, args: string[]): HandlerInput {
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

describe('/translate command', () => {
  it('asks for a target language when none given', async () => {
    const res = await translateCommand.handle(input({}, ctx({ repliedToText: 'ciao' }), []));
    expect(res?.text).toBe('translate_no_target');
  });

  it('shows usage when there is no replied message', async () => {
    const res = await translateCommand.handle(input({}, ctx(), ['spagnolo']));
    expect(res?.text).toBe('translate_usage');
  });

  it('translates the replied text into the target language', async () => {
    const chatCompletion = vi
      .fn()
      .mockResolvedValue({ text: 'hola mundo', model: 'm', usage: { estimated: true } });
    const services = {
      llm: { chatCompletion },
      modelForChat: vi.fn().mockResolvedValue('economy'),
    };
    const res = await translateCommand.handle(
      input(services, ctx({ repliedToText: 'ciao mondo', repliedToMessageId: 7 }), [
        'in',
        'spagnolo',
      ]),
    );
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(chatCompletion.mock.calls[0][0].system).toContain('Spanish');
    expect(chatCompletion.mock.calls[0][0].messages[0].content).toBe('ciao mondo');
    expect(chatCompletion.mock.calls[0][0].model).toBe('economy');
    expect(res?.rawText).toBe('hola mundo');
  });

  it('falls back to stored history when the reply text is not inline', async () => {
    const chatCompletion = vi
      .fn()
      .mockResolvedValue({ text: 'hello', model: 'm', usage: { estimated: true } });
    const findByMessageId = vi.fn().mockResolvedValue({ message: { messageText: 'ciao' } });
    const services = {
      llm: { chatCompletion },
      modelForChat: vi.fn().mockResolvedValue('economy'),
      storage: { messages: { findByMessageId } },
    };
    const res = await translateCommand.handle(
      input(services, ctx({ repliedToMessageId: 9 }), ['inglese']),
    );
    expect(findByMessageId).toHaveBeenCalledWith(-1, 9);
    expect(res?.rawText).toBe('hello');
  });
});
