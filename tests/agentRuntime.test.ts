import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, type AgentRuntimeInput } from '../src/services/agentRuntime.js';
import type { ToolExecutionContext, ToolExecutionOutput } from '../src/agent/types.js';

describe('AgentRuntime live provider bridge', () => {
  it('budgets the image tool for visual-QA corrective render rounds', () => {
    const runtime = new AgentRuntime({
      config: {
        env: {
          IMAGE_GENERATION_QA_ENABLED: true,
          IMAGE_GENERATION_QA_MAX_RETRIES: 1,
        },
        llm: { requestTimeoutMs: 10_000, freeFallbacks: [] },
        brain: { cortex: { model: 'test' }, replyModel: 'test' },
        linkMedia: { enabled: false },
        music: { timeoutMs: 10_000 },
        voice: { tts: { timeoutMs: 10_000 } },
        agnes: {
          image: { timeoutMs: 120_000 },
          video: { timeoutMs: 10_000 },
        },
        stableDiffusion: { queueTimeoutMs: 120_000, timeoutMs: 120_000 },
        search: { timeoutMs: 1_000 },
      } as never,
      llm: { capabilities: { chat: true } } as never,
      media: { canGenerateImage: true } as never,
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

    const definitions = (
      runtime as unknown as {
        definitions(input: Record<string, unknown>): Array<{ name: string; timeoutMs?: number }>;
      }
    ).definitions({});

    expect(definitions.find((definition) => definition.name === 'image_gen')?.timeoutMs).toBe(
      800_000,
    );
  });

  it.each(['blocked_dependency', 'proposal_saved', 'validation_failed'] as const)(
    'does not verify or announce a persistent command for %s capability outcomes',
    async (status) => {
      const acquire = vi.fn().mockResolvedValue({
        handled: false,
        text: `Lifecycle outcome: ${status}`,
        status,
        // Adversarial legacy fields: neither is proof that this acquisition succeeded.
        installed: true,
        capabilityId: 'existing_manifest',
        command: 'existingcmd',
        usage: { inputTokens: 0, outputTokens: 0, estimated: true },
        model: null,
        sources: [],
      });
      const runtime = new AgentRuntime({
        config: {
          env: { REPETITION_SIMILARITY_THRESHOLD: 0.78 },
          brain: { cortex: { model: 'test' }, replyModel: 'test' },
          linkMedia: { enabled: false },
        } as never,
        llm: { capabilities: { chat: true } } as never,
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
        capabilities: { enabled: true, acquire } as never,
      });
      const input: AgentRuntimeInput = {
        request: 'impara questa capacità',
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
        allowCapabilityInstall: true,
      };
      const registry = (
        runtime as unknown as {
          registry(value: AgentRuntimeInput): {
            capability_forge?: (context: ToolExecutionContext) => Promise<ToolExecutionOutput>;
          };
        }
      ).registry(input);
      const handler = registry.capability_forge;
      expect(handler).toBeDefined();
      const output = await handler!({
        request: input.request,
        action: {
          id: 'learn',
          tool: 'capability_forge',
          purpose: 'learn a capability',
          query: input.request,
          args: {},
          dependsOn: [],
          optional: false,
          timeoutMs: 5_000,
          acceptance: { requireOutput: true, minEvidence: 0, requiredArtifactKinds: [] },
        },
        dependencies: new Map(),
        signal: new AbortController().signal,
        metadata: {},
      });

      expect(output.verified).toBe(false);
      expect(output.summary).not.toMatch(
        /persistent command|installed and verified|executed successfully/i,
      );
      expect(output.data).toMatchObject({ kind: 'capability', status, installed: false });
    },
  );

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

  it('replans an image when a dependency prompt describes a different scene', async () => {
    const jsonCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        goal: 'generate the requested dog image',
        actions: [
          {
            id: 'wrong_prompt',
            tool: 'media_prompt',
            purpose: 'prepare a cat image',
            query: 'un gatto rosso',
            args: { kind: 'image' },
            dependsOn: [],
            optional: false,
            timeoutMs: 5_000,
            acceptance: { requireOutput: true, minEvidence: 0, requiredArtifactKinds: [] },
          },
          {
            id: 'make_image',
            tool: 'image_gen',
            purpose: 'generate a dog image',
            query: 'un cane blu',
            args: {},
            dependsOn: ['wrong_prompt'],
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
          format: 'mixed',
          mustInclude: [],
          tone: 'direct',
        },
      })
      .mockResolvedValueOnce({
        message: 'Fatto: cane blu generato.',
        usedActionIds: ['wrong_prompt', 'make_image'],
        uncertainties: [],
      });
    const prepared = (request: string) => ({
      prompt: `${request} pony`,
      negativePrompt: 'bad quality',
      providerPrompts: { agnes: `${request} agnes`, pony: `${request} pony` },
      scene: {},
      creativeBrief: request,
      qualityBrief: request,
      profile: 'realistic',
      medium: 'digital_illustration',
      rating: 'safe',
      aspectRatio: '1:1',
      preferredProvider: 'agnes',
      model: 'test',
      usedFallback: false,
    });
    const prepare = vi.fn(async (request: string) => prepared(request));
    const generateImage = vi.fn(async (_prompt: string, options: { providerPrompts: unknown }) => ({
      buffer: Buffer.from('dog-image'),
      model: 'agnes',
      provider: 'agnes',
      generationAttempts: 1,
      qaVisionCalls: 1,
      options,
    }));
    const runtime = new AgentRuntime({
      config: {
        brain: { cortex: { model: 'test' }, replyModel: 'test' },
        env: { REPETITION_SIMILARITY_THRESHOLD: 0.78 },
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
      llm: { capabilities: { chat: true }, jsonCompletion } as never,
      media: { canGenerateImage: true, generateImage } as never,
      music: { enabled: false } as never,
      video: { enabled: false } as never,
      tts: { enabled: false } as never,
      grounding: { enabled: false } as never,
      knowledge: { enabled: false } as never,
      imageFinder: { findPoseReference: vi.fn(async () => null) } as never,
      imagePrompts: { prepare } as never,
      videoPrompts: {} as never,
      quota: {} as never,
      capabilities: { enabled: false } as never,
    });

    const result = await runtime.run({
      request: 'fammi un cane blu',
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

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]?.[0]).toBe('un gatto rosso');
    expect(prepare.mock.calls[1]?.[0]).toBe('un cane blu');
    expect(generateImage).toHaveBeenCalledWith(
      'un cane blu pony',
      expect.objectContaining({
        providerPrompts: { agnes: 'un cane blu agnes', pony: 'un cane blu pony' },
      }),
    );
    expect(result?.imageBuffer?.toString()).toBe('dog-image');
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

  it('keeps a pure link-media plan silent until Telegram attempts the rehost', async () => {
    const mediaUrl = 'https://www.instagram.com/reel/example/';
    const jsonCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        goal: 'rehost the supplied reel',
        actions: [
          {
            id: 'link_media_1',
            tool: 'link_media',
            purpose: 'prepare the reel for rehosting',
            query: mediaUrl,
            args: { url: mediaUrl },
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
          tone: 'direct',
        },
      })
      // Even an overconfident composer cannot announce success before the Telegram transport runs.
      .mockResolvedValueOnce({
        message: 'Il reel e pronto e recuperato.',
        usedActionIds: ['link_media_1'],
        uncertainties: [],
      });
    const runtime = new AgentRuntime({
      config: {
        brain: { cortex: { model: 'test' }, replyModel: 'test' },
        env: { REPETITION_SIMILARITY_THRESHOLD: 0.78 },
        linkMedia: { enabled: true },
      } as never,
      llm: { capabilities: { chat: true }, jsonCompletion } as never,
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
      request: mediaUrl,
      language: 'italian',
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: true,
        isGroupAdmin: false,
        isReplyToBot: false,
      },
      requestedActions: [
        {
          tool: 'link_media',
          query: mediaUrl,
          args: { url: mediaUrl },
          reason: 'rehost the supplied reel',
        },
      ],
      recentMessages: [],
      quotaBypass: true,
    });

    expect(result?.status).toBe('complete');
    expect(result?.linkMediaUrl).toBe(mediaUrl);
    expect(result?.text).toBe('');
    const compositionPrompt = (jsonCompletion.mock.calls[1]?.[0] as { prompt?: string } | undefined)
      ?.prompt;
    expect(compositionPrompt).toContain('Telegram rehost is still pending');
    expect(compositionPrompt).not.toContain('Resolved media for Telegram delivery');
  });

  it('keeps a pure link-media resolution failure visible', async () => {
    const jsonCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        goal: 'find and rehost a missing reel',
        actions: [
          {
            id: 'link_media_1',
            tool: 'link_media',
            purpose: 'find the requested reel',
            query: 'a reel that cannot be found',
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
          tone: 'direct',
        },
      })
      .mockResolvedValueOnce({
        message: 'Non ho trovato un contenuto scaricabile per questa richiesta.',
        usedActionIds: [],
        uncertainties: ['media URL not found'],
      });
    const findMediaUrl = vi.fn().mockResolvedValue(null);
    const runtime = new AgentRuntime({
      config: {
        brain: { cortex: { model: 'test' }, replyModel: 'test' },
        env: { REPETITION_SIMILARITY_THRESHOLD: 0.78 },
        linkMedia: { enabled: true },
      } as never,
      llm: { capabilities: { chat: true }, jsonCompletion } as never,
      media: { canGenerateImage: false } as never,
      music: { enabled: false } as never,
      video: { enabled: false } as never,
      tts: { enabled: false } as never,
      grounding: { enabled: true, findMediaUrl } as never,
      knowledge: { enabled: false } as never,
      imageFinder: {} as never,
      imagePrompts: {} as never,
      videoPrompts: {} as never,
      quota: {} as never,
      capabilities: { enabled: false } as never,
    });

    const result = await runtime.run({
      request: 'trovami e scaricami quel reel introvabile',
      language: 'italian',
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: true,
        isGroupAdmin: false,
        isReplyToBot: false,
      },
      requestedActions: [
        {
          tool: 'link_media',
          query: 'a reel that cannot be found',
          reason: 'find the requested reel',
        },
      ],
      recentMessages: [],
      quotaBypass: true,
    });

    expect(findMediaUrl).toHaveBeenCalledOnce();
    expect(result?.status).toBe('failed');
    expect(result?.linkMediaUrl).toBeUndefined();
    expect(result?.text).toContain('Non ho trovato');
  });
});
