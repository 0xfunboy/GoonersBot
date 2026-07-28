import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/services/agentRuntime.js';

describe('AgentRuntime live provider bridge', () => {
  it('executes a translation and feeds its verified output into TTS in the same turn', async () => {
    const jsonCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        goal: 'translate and speak',
        actions: [
          {
            id: 'translate_it',
            tool: 'translate',
            purpose: 'translate the supplied sentence',
            query: 'ciao mondo',
            args: { targetLanguage: 'Spanish' },
            dependsOn: [],
            optional: false,
            timeoutMs: 5_000,
            acceptance: { requireOutput: true, minEvidence: 0, requiredArtifactKinds: [] },
          },
          {
            id: 'speak_it',
            tool: 'tts',
            purpose: 'deliver the translation as voice',
            args: {},
            dependsOn: ['translate_it'],
            optional: false,
            timeoutMs: 5_000,
            acceptance: {
              requireOutput: true,
              minEvidence: 0,
              requiredArtifactKinds: ['audio'],
            },
          },
        ],
        finalResponse: {
          language: 'Italian',
          format: 'mixed',
          mustInclude: [],
          tone: 'loyal friend',
        },
      })
      .mockResolvedValueOnce({
        message: 'Tradotto e mandato anche vocale.',
        usedActionIds: ['translate_it', 'speak_it'],
        uncertainties: [],
      });
    const chatCompletion = vi.fn().mockResolvedValue({
      text: 'hola mundo',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
    });
    const synth = vi.fn().mockResolvedValue(Buffer.from('voice'));
    const llm = {
      capabilities: { chat: true },
      jsonCompletion,
      chatCompletion,
    };
    const runtime = new AgentRuntime({
      config: {
        brain: {
          cortex: { model: 'test' },
          replyModel: 'test',
        },
        linkMedia: { enabled: false },
      } as never,
      llm: llm as never,
      media: { canGenerateImage: false } as never,
      music: { enabled: false } as never,
      video: { enabled: false } as never,
      tts: { enabled: true, synth } as never,
      grounding: { enabled: false } as never,
      knowledge: { enabled: false } as never,
      imageFinder: {} as never,
      imagePrompts: {} as never,
      videoPrompts: {} as never,
      quota: {} as never,
      capabilities: { enabled: false } as never,
    });

    const result = await runtime.run({
      request: 'Traduci "ciao mondo" in spagnolo e mandamelo vocale',
      language: 'italian',
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: true,
        isGroupAdmin: false,
        isReplyToBot: false,
      },
      recentMessages: [],
      quotaBypass: true,
    });

    expect(result?.status).toBe('complete');
    expect(result?.actionCount).toBe(2);
    expect(result?.text).toContain('vocale');
    expect(result?.audioBuffer?.toString()).toBe('voice');
    expect(chatCompletion).toHaveBeenCalledOnce();
    expect(synth).toHaveBeenCalledWith('hola mundo', 'italian', expect.any(AbortSignal));
  });

  it('blocks a multilingual minor request inside AgentRuntime before quota or generation', async () => {
    const jsonCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        goal: 'make an image',
        actions: [
          {
            id: 'make_image',
            tool: 'image_gen',
            purpose: 'generate the requested image',
            query: 'ritratto di una ragazzina di 16 anni',
            args: {},
            dependsOn: [],
            optional: false,
            timeoutMs: 30_000,
            acceptance: {
              requireOutput: true,
              minEvidence: 0,
              requiredArtifactKinds: ['image'],
            },
          },
        ],
        finalResponse: {
          language: 'Italian',
          format: 'text',
          mustInclude: [],
          tone: 'direct',
        },
      })
      .mockResolvedValueOnce({
        message: 'Richiesta rifiutata.',
        usedActionIds: [],
        uncertainties: [],
      });
    const prepare = vi.fn();
    const generateImage = vi.fn();
    const reserve = vi.fn();
    const runtime = new AgentRuntime({
      config: {
        brain: { cortex: { model: 'test' }, replyModel: 'test' },
        llm: { requestTimeoutMs: 1_000, freeFallbacks: [] },
        linkMedia: { enabled: false },
        music: { timeoutMs: 10_000 },
        voice: { tts: { timeoutMs: 10_000 } },
        agnes: {
          image: { timeoutMs: 10_000 },
          video: { timeoutMs: 10_000 },
        },
        stableDiffusion: { queueTimeoutMs: 10_000, timeoutMs: 10_000 },
        search: { timeoutMs: 1_000 },
      } as never,
      llm: {
        capabilities: { chat: true },
        jsonCompletion,
      } as never,
      media: { canGenerateImage: true, generateImage } as never,
      music: { enabled: false } as never,
      video: { enabled: false } as never,
      tts: { enabled: false } as never,
      grounding: { enabled: false } as never,
      knowledge: { enabled: false } as never,
      imageFinder: {} as never,
      imagePrompts: { prepare } as never,
      videoPrompts: {} as never,
      quota: { reserve } as never,
      capabilities: { enabled: false } as never,
    });

    const result = await runtime.run({
      request: 'fammi il ritratto di una ragazzina di 16 anni',
      language: 'italian',
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: true,
        isGroupAdmin: false,
        isReplyToBot: false,
      },
      recentMessages: [],
    });

    expect(result?.status).toBe('failed');
    expect(result?.imageBuffer).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('applies the gratitude social floor to multi-tool answers and rewrites hostile output', async () => {
    const jsonCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        goal: 'recall the relevant group context',
        actions: [
          {
            id: 'recall',
            tool: 'group_rag',
            purpose: 'recall the completed help',
            args: {},
            dependsOn: [],
            optional: false,
            timeoutMs: 5_000,
            acceptance: { requireOutput: true, minEvidence: 0, requiredArtifactKinds: [] },
          },
        ],
        finalResponse: {
          language: 'Italian',
          format: 'text',
          mustInclude: [],
          tone: 'warm',
        },
      })
      .mockResolvedValueOnce({
        message: 'Prego coglione, ora piantala e arrangiati.',
        usedActionIds: ['recall'],
        uncertainties: [],
      });
    const chatCompletion = vi.fn().mockResolvedValue({
      text: 'Figurati. Quando serve davvero, ci sono.',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
    });
    const runtime = new AgentRuntime({
      config: {
        brain: { cortex: { model: 'test' }, replyModel: 'test' },
        env: { REPETITION_SIMILARITY_THRESHOLD: 0.78 },
        linkMedia: { enabled: false },
      } as never,
      llm: {
        capabilities: { chat: true },
        jsonCompletion,
        chatCompletion,
      } as never,
      media: { canGenerateImage: false } as never,
      music: { enabled: false } as never,
      video: { enabled: false } as never,
      tts: { enabled: false } as never,
      grounding: { enabled: false } as never,
      knowledge: { enabled: false } as never,
      imageFinder: {} as never,
      imagePrompts: {} as never,
      videoPrompts: {} as never,
      quota: {} as never,
      capabilities: { enabled: false } as never,
    });

    const result = await runtime.run({
      request: 'grazie mille per avermi aiutato',
      language: 'italian',
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: true,
        isGroupAdmin: false,
        isReplyToBot: false,
      },
      socialContext: '- MEMBER @alice: appreciates practical help',
      socialSignal: {
        situation: 'gratitude',
        supportNeed: 'none',
        posture: 'steady',
        humorAllowed: false,
        roastCeiling: 'none',
        memoryPolicy: 'avoid_callbacks',
        responseOrder: 'play_first',
        confidence: 0.99,
        cues: ['direct gratitude'],
      },
      recentMessages: [],
      quotaBypass: true,
    });

    expect(result?.text).toBe('Figurati. Quando serve davvero, ci sono.');
    expect(result?.text).not.toMatch(/coglione|piantala/i);
    expect(chatCompletion).toHaveBeenCalledOnce();
  });

  it('keeps document analysis executable when JSON planning fails', async () => {
    const chatCompletion = vi.fn().mockResolvedValue({
      text: 'Il documento assegna 40% al marketing e 60% allo sviluppo, con revisione a settembre.',
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 10, estimated: false },
    });
    const runtime = new AgentRuntime({
      config: {
        brain: { cortex: { model: 'test' }, replyModel: 'test' },
        env: { REPETITION_SIMILARITY_THRESHOLD: 0.78 },
        llm: { requestTimeoutMs: 1_000, freeFallbacks: [] },
        linkMedia: { enabled: false },
        search: { timeoutMs: 1_000 },
      } as never,
      llm: {
        capabilities: { chat: true },
        jsonCompletion: vi.fn().mockResolvedValue(null),
        chatCompletion,
      } as never,
      media: { canGenerateImage: false } as never,
      music: { enabled: false } as never,
      video: { enabled: false } as never,
      tts: { enabled: false } as never,
      grounding: { enabled: false } as never,
      knowledge: { enabled: false } as never,
      imageFinder: {} as never,
      imagePrompts: {} as never,
      videoPrompts: {} as never,
      quota: {} as never,
      capabilities: { enabled: false } as never,
    });

    const result = await runtime.run({
      request: 'riassumi il PDF allegato',
      language: 'italian',
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: true,
        isGroupAdmin: false,
        isReplyToBot: false,
      },
      documentContext:
        '--- DOCUMENT name="budget.pdf" type=application/pdf ---\nMarketing 40%. Sviluppo 60%. Revisione settembre.\n--- END DOCUMENT ---',
      requestedActions: [
        {
          tool: 'document_read',
          reason: 'read and summarize the attached PDF',
        },
      ],
      recentMessages: [],
      quotaBypass: true,
    });

    expect(result?.status).toBe('complete');
    expect(result?.actionCount).toBe(1);
    expect(result?.text).toContain('40%');
    expect(chatCompletion).toHaveBeenCalledOnce();
  });
});
