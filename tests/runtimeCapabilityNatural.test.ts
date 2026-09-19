import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext, ToolExecutionOutput } from '../src/agent/types.js';
import { AgentRuntime, type AgentRuntimeInput } from '../src/services/agentRuntime.js';

describe('installed capability natural execution', () => {
  it('executes the recipe selected by Cortex without requiring its slash command', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      handled: true,
      text: 'Tre paper recenti con fonti.',
      status: 'reused',
      capabilityId: 'technical_papers',
      command: 'papers',
      installed: true,
      usage: { inputTokens: 10, outputTokens: 20, estimated: false },
      model: 'test',
      sources: ['https://example.org/paper'],
    });
    const acquire = vi.fn();
    const runtime = new AgentRuntime({
      config: { env: {}, brain: { cortex: {}, replyModel: 'test' }, linkMedia: {} } as never,
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
      capabilities: {
        enabled: true,
        hasCommand: (command: string) => command === 'papers',
        executeCommand,
        acquire,
      } as never,
      anime: { enabled: false } as never,
      animeArchive: { enabled: false } as never,
    });
    const input: AgentRuntimeInput = {
      request: 'cercami i paper recenti sui transformer',
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
    };
    const handlers = (
      runtime as unknown as {
        registry(value: AgentRuntimeInput): {
          capability_forge?: (context: ToolExecutionContext) => Promise<ToolExecutionOutput>;
        };
      }
    ).registry(input);

    const output = await handlers.capability_forge!({
      request: input.request,
      action: {
        id: 'papers_lookup',
        tool: 'capability_forge',
        purpose: 'use the installed technical-paper recipe',
        query: input.request,
        args: { command: 'papers' },
        dependsOn: [],
        optional: false,
        timeoutMs: 30_000,
        acceptance: { requireOutput: true, minEvidence: 1, requiredArtifactKinds: [] },
      },
      dependencies: new Map(),
      signal: new AbortController().signal,
      metadata: {},
    });

    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'papers',
        input: 'cercami i paper recenti sui transformer',
      }),
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(output).toMatchObject({ verified: true });
    expect(output.summary).toContain('Existing command executed successfully: /papers');
  });
});
