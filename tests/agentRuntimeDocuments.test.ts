import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, type AgentRuntimeInput } from '../src/services/agentRuntime.js';
import type { ToolExecutionContext, ToolExecutionOutput } from '../src/agent/types.js';

function fixture(responses: string[], suppliedContent?: string) {
  const chatCompletion = vi.fn();
  for (const text of responses)
    chatCompletion.mockResolvedValueOnce({ text, finishReason: 'stop' });
  const runtime = new AgentRuntime({
    config: { env: { REPETITION_SIMILARITY_THRESHOLD: 0.78 } } as never,
    llm: { chatCompletion } as never,
  } as never);
  const input: AgentRuntimeInput = {
    request: 'Prepara una checklist in tre punti per organizzare un podcast',
    language: 'italian',
    person: { telegramId: 1, userHandle: '@alice' },
    context: {
      chatId: 1,
      isGroup: false,
      isGroupAdmin: false,
      isBotMentioned: false,
      isReplyToBot: false,
    },
    recentMessages: [],
    quotaBypass: true,
  };
  const registry = (
    runtime as unknown as {
      registry(input: AgentRuntimeInput): {
        document_create: (ctx: ToolExecutionContext) => Promise<ToolExecutionOutput>;
      };
    }
  ).registry(input);
  const run = () =>
    registry.document_create({
      request: input.request,
      action: {
        id: 'document',
        tool: 'document_create',
        purpose: input.request,
        args: {
          format: 'markdown',
          title: 'Checklist podcast',
          ...(suppliedContent ? { content: suppliedContent } : {}),
        },
        dependsOn: [],
        optional: false,
        timeoutMs: 5000,
        acceptance: { requireOutput: true, minEvidence: 0, requiredArtifactKinds: ['document'] },
      },
      dependencies: new Map(),
      signal: new AbortController().signal,
      metadata: {},
    });
  return { run, chatCompletion };
}

describe('document runtime content verification', () => {
  const content =
    '1. Scegli tema e ospiti.\n2. Registra una prova audio.\n3. Pubblica e controlla il feed.';

  it('retries one empty model placeholder and exposes actual file content to the composer', async () => {
    const { run, chatCompletion } = fixture(['[]', content]);
    const output = await run();
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(output.verified).toBe(true);
    expect(output.summary).toContain(content);
    expect((output.data as { buffer: Buffer }).buffer.toString()).toBe(content);
    expect(chatCompletion.mock.calls[1]?.[0].system).toContain('previous attempt');
  });

  it('fails closed after two placeholders instead of creating a bogus verified attachment', async () => {
    const { run, chatCompletion } = fixture(['[]', '{}']);
    const output = await run();
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(output.verified).toBe(false);
    expect(output.artifacts).toBeUndefined();
    expect(output.data).toBeUndefined();
  });

  it('regenerates a placeholder supplied by planning, but preserves actual supplied content', async () => {
    const invalid = fixture([content], '[]');
    expect((await invalid.run()).verified).toBe(true);
    expect(invalid.chatCompletion).toHaveBeenCalledOnce();
    const valid = fixture([], content);
    expect((await valid.run()).summary).toContain(content);
    expect(valid.chatCompletion).not.toHaveBeenCalled();
  });
});
