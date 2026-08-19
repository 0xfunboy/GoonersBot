import type { Context as GrammyContext } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/config/env.js';
import { Localizer } from '../src/config/index.js';
import { classifyAnimeUnityUrl } from '../src/anime/archive/animeUnity.js';
import { buildInlineKeyboard, parseCallbackData } from '../src/telegram/keyboards.js';
import { callbackHandlers } from '../src/telegram/handlers/callbacks/index.js';
import { archiveResultResponse, handleMessage } from '../src/telegram/handlers/message.js';
import { Services } from '../src/services/index.js';
import type { ChatContext, Person } from '../src/domain/types.js';
import type { HandlerInput } from '../src/telegram/handlers/types.js';

describe('anime archive confirmation UI', () => {
  it('renders SI and NO on one row while keeping only an opaque id in callback data', () => {
    const keyboard = buildInlineKeyboard({
      options: [
        { id: 'yes|n_8Qh2k', label: 'SI' },
        { id: 'no|n_8Qh2k', label: 'NO' },
      ],
      callback: 'anime_archive',
      buttonAction: 'anime_archive',
      columns: 2,
    });

    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(keyboard.inline_keyboard[0]?.map((button) => button.text)).toEqual(['SI', 'NO']);
    expect(keyboard.inline_keyboard[0]?.map((button) => button.callback_data)).toEqual([
      'anime_archive|yes|n_8Qh2k',
      'anime_archive|no|n_8Qh2k',
    ]);
    expect(parseCallbackData('anime_archive|yes|n_8Qh2k')).toEqual({
      action: 'anime_archive',
      args: ['yes', 'n_8Qh2k'],
    });
  });

  it('registers the confirmation in the central callback pipeline and rechecks admin in service', async () => {
    const confirmCallback = vi.fn(async () => ({
      status: 'cancelled' as const,
      offer: { id: 'ao_fixture' },
    }));
    const spec = callbackHandlers.find((candidate) => candidate.action === 'anime_archive');
    expect(spec).toMatchObject({
      permissions: ['allowed_user', 'not_banned'],
      needsTermsAccepted: true,
      ownerOnly: true,
    });

    const input = {
      services: {
        animeArchive: { confirmCallback },
        isAnimeArchiveAdmin: () => true,
        bypassesGroupPlan: () => false,
      },
      person: { telegramId: 123, userHandle: '@fixture' },
      context: { chatId: -100, threadId: 7, messageId: 501 },
      args: ['no', 'ao_fixture'],
    } as unknown as HandlerInput;
    await expect(spec?.handle(input)).resolves.toMatchObject({
      rawText: 'Va bene, richiesta annullata.',
      clearOriginKeyboard: true,
    });
    expect(confirmCallback).toHaveBeenCalledWith(
      ['no', 'ao_fixture'],
      expect.objectContaining({
        actorTelegramId: 123,
        chatId: -100,
        confirmationMessageId: 501,
        isAdmin: true,
      }),
    );
  });

  it('renders direct series and episode outcomes without exposing stored state', () => {
    const keyboard = {
      options: [
        { id: 'yes|ao_fixture', label: 'SI' },
        { id: 'no|ao_fixture', label: 'NO' },
      ],
      callback: 'anime_archive',
      buttonAction: 'anime_archive',
      columns: 2,
    };
    expect(
      archiveResultResponse({
        status: 'confirmation_required',
        offer: { id: 'ao_fixture' },
        keyboard,
        series: {
          title: 'Fixture',
          source: 'animeunity',
          episodes: [{ number: '1' }, { number: '2' }, { number: '3' }],
        },
      } as never),
    ).toMatchObject({
      rawText: expect.stringMatching(
        /Trovato su .*Fixture.*3 episodi attualmente disponibili.*accodare questi 3 episodi/s,
      ),
      keyboard,
    });
    expect(
      archiveResultResponse({
        status: 'confirmation_required',
        offer: { id: 'ao_episode' },
        keyboard,
        series: { title: 'Fixture', source: 'animeunity', episodes: [{ number: '7' }] },
        episode: { number: '7' },
      } as never),
    ).toMatchObject({
      rawText: expect.stringMatching(/Trovato su .*Fixture.*episodio 7.*Vuoi che te lo scarichi/s),
      keyboard,
    });
    expect(
      archiveResultResponse({
        status: 'queued',
        created: true,
        job: {
          source: 'animeunity',
          series: { title: 'Fixture' },
          episodes: [{ number: 7 }],
        },
      } as never),
    ).toMatchObject({ rawText: expect.stringMatching(/Trovato su .*Episodio in coda/s) });
  });
});

describe('anime archive mixed URL routing', () => {
  it('handles AnimeUnity once and passes only the generic URL to LinkMedia', async () => {
    const animeUrl = 'https://www.animeunity.so/anime/123-fixture/456';
    const genericUrl = 'https://www.youtube.com/watch?v=generic123';
    const classification = classifyAnimeUnityUrl(animeUrl);
    expect(classification).not.toBeNull();

    const prepareUrl = vi.fn().mockResolvedValue({
      status: 'queued',
      created: true,
      job: { episodes: [{}] },
    });
    const classifyUrl = vi.fn((url: URL) => classifyAnimeUnityUrl(url));
    const classifyText = vi.fn().mockReturnValue([
      {
        url: animeUrl,
        classification,
        allowed: true,
      },
    ]);
    const handleLinkMedia = vi.fn().mockResolvedValue({
      handled: true,
      attemptedUrls: [genericUrl],
      handledUrls: [genericUrl],
    });
    const services = {
      initializeContext: vi.fn().mockResolvedValue(undefined),
      permissions: { checkAll: vi.fn().mockResolvedValue(true) },
      conversation: {
        isStarted: vi.fn().mockResolvedValue(true),
        isTrackingEnabled: vi.fn().mockResolvedValue(false),
        getRecent: vi.fn().mockResolvedValue([]),
      },
      animeArchive: {
        classifyText,
        classifyUrl,
        prepareUrl,
      },
      linkMedia: {
        enabled: true,
        autoRehostEnabled: true,
        handleMessage: handleLinkMedia,
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
      isAnimeArchiveAdmin: vi.fn().mockReturnValue(false),
      modes: { getActive: vi.fn().mockResolvedValue(null) },
      getLanguage: vi.fn().mockResolvedValue('italian'),
      localizer: new Localizer('italian'),
      stt: { enabled: false },
    } as unknown as Services;
    const reply = vi.fn().mockResolvedValue({ message_id: 901 });
    const ctx = {
      message: { message_id: 77 },
      chat: { id: -100 },
      reply,
    } as unknown as GrammyContext;
    const person: Person = { telegramId: 42, userHandle: '@allowed' };
    const context: ChatContext = {
      chatId: -100,
      messageId: 77,
      isGroup: true,
      isBotMentioned: false,
      isGroupAdmin: false,
      isReplyToBot: false,
    };

    await handleMessage(
      ctx,
      person,
      context,
      { messageText: `${animeUrl} ${genericUrl}`, timestamp: new Date() },
      { services, env: {} as Env, botUsername: 'GooNeuroBot' },
    );

    expect(classifyText).toHaveBeenCalledOnce();
    expect(prepareUrl).toHaveBeenCalledOnce();
    expect(prepareUrl).toHaveBeenCalledWith(expect.objectContaining({ url: animeUrl }));
    expect(handleLinkMedia).toHaveBeenCalledOnce();
    expect(handleLinkMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        text: genericUrl,
        addressed: false,
      }),
    );
    expect(handleLinkMedia.mock.calls[0]?.[0].text).not.toContain(animeUrl);
  });

  it('keeps an already attached natural offer when the factual reply cannot be delivered', async () => {
    const invalidateOffer = vi.fn().mockResolvedValue(null);
    const replaceConfirmationMessage = vi.fn();
    const prepareNaturalEpisodeOffer = vi.fn().mockResolvedValue({
      status: 'confirmation_required',
      offer: { id: 'ao_visible', confirmationMessageId: 700 },
      keyboard: {
        options: [
          { id: 'yes|ao_visible', label: 'SI' },
          { id: 'no|ao_visible', label: 'NO' },
        ],
        callback: 'anime_archive',
        buttonAction: 'anime_archive',
        columns: 2,
      },
      series: { title: 'Frieren' },
    });
    const services = {
      initializeContext: vi.fn().mockResolvedValue(undefined),
      permissions: {
        checkAll: vi.fn().mockResolvedValue(true),
        isBotAdmin: vi.fn().mockReturnValue(false),
      },
      conversation: {
        isStarted: vi.fn().mockResolvedValue(true),
        isTrackingEnabled: vi.fn().mockResolvedValue(false),
        getRecent: vi.fn().mockResolvedValue([]),
      },
      animeArchive: {
        enabled: true,
        classifyText: vi.fn().mockReturnValue([]),
        classifyUrl: vi.fn().mockReturnValue(null),
        prepareNaturalEpisodeOffer,
        invalidateOffer,
        replaceConfirmationMessage,
      },
      linkMedia: { enabled: false, autoRehostEnabled: false },
      config: {
        linkMedia: { maxUrlsPerMessage: 2 },
        ambient: { enabled: false, minDomainScore: 1, maxDomains: 2 },
        voice: {
          tts: { maxChars: 1_000, replyToVoice: false, autoVoiceProbability: 0 },
        },
      },
      storage: {
        chats: { getNsfwMode: vi.fn().mockResolvedValue('off') },
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
      bypassesGroupPlan: vi.fn().mockReturnValue(true),
      isAnimeArchiveAdmin: vi.fn().mockReturnValue(false),
      modes: { getActive: vi.fn().mockResolvedValue(null) },
      getLanguage: vi.fn().mockResolvedValue('italian'),
      localizer: new Localizer('italian'),
      stt: { enabled: false },
      tts: { enabled: false },
      autoengage: { decide: vi.fn().mockResolvedValue({ shouldReply: true }) },
      usage: { isUnderLimit: vi.fn().mockResolvedValue(true) },
      modelRouter: {
        route: vi.fn().mockReturnValue({
          model: 'fixture',
          nsfw: false,
          allowRefusalFallback: false,
        }),
      },
      planForTurn: vi.fn().mockResolvedValue({ id: 'fixture' }),
      modelForPlan: vi.fn().mockReturnValue('fixture'),
      isFreePlan: vi.fn().mockReturnValue(true),
      reply: {
        generateReply: vi.fn().mockResolvedValue({
          suppressed: false,
          text: 'Frieren ha un nuovo episodio.',
          model: 'fixture',
          usage: { inputTokens: 1, outputTokens: 1, estimated: false },
          styleVariant: 'default',
          evaluation: { action: 'reply' },
          animeArchiveLookup: { titles: ['Frieren'] },
        }),
      },
    } as unknown as Services;
    const reply = vi.fn().mockRejectedValue(new Error('Telegram unavailable'));
    const ctx = {
      message: { message_id: 77 },
      chat: { id: -100 },
      reply,
      replyWithChatAction: vi.fn().mockResolvedValue(undefined),
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

    await expect(
      handleMessage(
        ctx,
        person,
        context,
        { messageText: 'Parlami di Frieren', timestamp: new Date() },
        {
          services,
          env: {
            LLM_NSFW_DEFAULT_MODE: 'off',
            BRAIN_DEBUG_ENABLED: false,
          } as Env,
          botUsername: 'GooNeuroBot',
        },
      ),
    ).resolves.toBeUndefined();

    expect(prepareNaturalEpisodeOffer).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalled();
    expect(invalidateOffer).not.toHaveBeenCalled();
    expect(replaceConfirmationMessage).not.toHaveBeenCalled();
  });
});

describe('anime archive bulk authority', () => {
  const person: Person = { telegramId: 123, userHandle: '@fixture' };
  const context = (isGroup: boolean, isGroupAdmin: boolean): ChatContext => ({
    chatId: isGroup ? -100 : 123,
    isGroup,
    isGroupAdmin,
    isBotMentioned: true,
    isReplyToBot: false,
  });

  it('does not inherit the generic private-chat-is-admin shortcut', () => {
    const call = (botAdmin: boolean, chat: ChatContext): boolean =>
      Services.prototype.isAnimeArchiveAdmin.call(
        { permissions: { isBotAdmin: () => botAdmin } },
        person,
        chat,
      );

    expect(call(false, context(false, true))).toBe(false);
    expect(call(true, context(false, true))).toBe(true);
    expect(call(false, context(true, true))).toBe(true);
    expect(call(false, context(true, false))).toBe(false);
  });
});
