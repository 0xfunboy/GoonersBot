import type { Context as GrammyContext } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { ChatContext, Person } from '../src/domain/types.js';
import type { Env } from '../src/config/env.js';
import { Localizer } from '../src/config/index.js';
import type { Services } from '../src/services/index.js';
import { handleMessage } from '../src/telegram/handlers/message.js';

describe('natural system information routing', () => {
  it('answers an explicit addressed request before history, inference, and quota admission', async () => {
    const report = vi.fn().mockResolvedValue('Sensori\n• Temperature: CPU 51.0 °C');
    const admitConversation = vi.fn();
    const getRecent = vi.fn();
    const services = {
      initializeContext: vi.fn().mockResolvedValue(undefined),
      permissions: { checkAll: vi.fn().mockResolvedValue(true) },
      conversation: {
        isStarted: vi.fn().mockResolvedValue(true),
        isTrackingEnabled: vi.fn().mockResolvedValue(true),
        getRecent,
      },
      linkMedia: { enabled: false, autoRehostEnabled: false },
      config: { linkMedia: { maxUrlsPerMessage: 2 } },
      terms: {
        hasDeclined: vi.fn().mockResolvedValue(false),
        hasAccepted: vi.fn().mockResolvedValue(true),
      },
      isApproved: vi.fn().mockReturnValue(true),
      bypassesGroupPlan: vi.fn().mockReturnValue(false),
      systemInfo: { report },
      quota: { admitConversation },
    } as unknown as Services;
    const reply = vi.fn().mockResolvedValue({ message_id: 99 });
    const ctx = {
      message: { message_id: 77 },
      reply,
    } as unknown as GrammyContext;
    const person: Person = { telegramId: 42, userHandle: '@allowed' };
    const context: ChatContext = {
      chatId: -100,
      messageId: 77,
      isGroup: true,
      isBotMentioned: true,
      isGroupAdmin: false,
      isReplyToBot: false,
    };

    await handleMessage(
      ctx,
      person,
      context,
      { messageText: 'GooNeuroBot, dimmi la temperatura della tua CPU', timestamp: new Date() },
      { services, env: {} as Env, botUsername: 'GooNeuroBot' },
    );

    expect(report).toHaveBeenCalledWith({
      chatId: -100,
      scopes: ['hardware', 'sensors'],
      operatorSession: false,
    });
    expect(reply).toHaveBeenCalledWith('Sensori\n• Temperature: CPU 51.0 °C', {
      reply_parameters: { message_id: 77 },
    });
    expect(getRecent).not.toHaveBeenCalled();
    expect(admitConversation).not.toHaveBeenCalled();
  });
});

describe('over-limit link routing', () => {
  it('sends the short deterministic duration notice and exits before conversation quota', async () => {
    const admitConversation = vi.fn();
    const addUserMessage = vi.fn().mockResolvedValue(undefined);
    const handleLink = vi.fn().mockResolvedValue({
      handled: false,
      reason: 'duration_exceeded',
      attemptedUrls: ['https://www.youtube.com/watch?v=_qDne3nQyNU'],
      failedUrls: ['https://www.youtube.com/watch?v=_qDne3nQyNU'],
      durationLimit: { durationSeconds: 1_050, maxDurationSeconds: 300 },
    });
    const services = {
      initializeContext: vi.fn().mockResolvedValue(undefined),
      permissions: { checkAll: vi.fn().mockResolvedValue(true) },
      conversation: {
        isStarted: vi.fn().mockResolvedValue(true),
        isTrackingEnabled: vi.fn().mockResolvedValue(true),
        getRecent: vi.fn().mockResolvedValue([]),
        addUserMessage,
      },
      linkMedia: {
        enabled: true,
        autoRehostEnabled: true,
        handleMessage: handleLink,
      },
      config: { linkMedia: { maxUrlsPerMessage: 2 } },
      storage: {
        chats: { getLinkMedia: vi.fn().mockResolvedValue(true) },
        botReplies: {
          getRecent: vi.fn().mockResolvedValue([]),
          getRecentFor: vi.fn().mockResolvedValue([]),
        },
      },
      terms: {
        hasDeclined: vi.fn().mockResolvedValue(false),
        hasAccepted: vi.fn().mockResolvedValue(true),
      },
      isApproved: vi.fn().mockReturnValue(true),
      bypassesGroupPlan: vi.fn().mockReturnValue(false),
      modes: { getActive: vi.fn().mockResolvedValue(null) },
      getLanguage: vi.fn().mockResolvedValue('italian'),
      localizer: new Localizer('italian'),
      stt: { enabled: false },
      quota: { admitConversation },
    } as unknown as Services;
    const reply = vi.fn().mockResolvedValue({ message_id: 100 });
    const ctx = {
      message: { message_id: 78 },
      reply,
    } as unknown as GrammyContext;
    const person: Person = { telegramId: 42, userHandle: '@allowed' };
    const context: ChatContext = {
      chatId: -100,
      messageId: 78,
      isGroup: true,
      isBotMentioned: true,
      isGroupAdmin: false,
      isReplyToBot: false,
    };

    await handleMessage(
      ctx,
      person,
      context,
      {
        messageText: 'https://www.youtube.com/watch?v=_qDne3nQyNU',
        timestamp: new Date(),
      },
      { services, env: {} as Env, botUsername: 'GooNeuroBot' },
    );

    expect(handleLink).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(
      'Rehost disabilitato: video da 17:30, limite 5:00.',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(addUserMessage).toHaveBeenCalledOnce();
    expect(admitConversation).not.toHaveBeenCalled();
  });
});
