import { describe, expect, it, vi } from 'vitest';
import { plannedActionSchema } from '../src/agent/schemas.js';
import {
  createRequestContract,
  runDurableAction,
  type CompanionTask,
  type TaskExecutionContext,
} from '../src/companion/tasks/index.js';

function fixture() {
  const checkpoints = new Map<string, unknown>();
  const receipts = new Map<string, unknown>();
  const controller = new AbortController();
  const context: TaskExecutionContext = {
    task: {
      contract: createRequestContract({
        goal: 'Cerca e crea una immagine',
        actorTelegramId: 1,
        chatId: 1,
      }),
    } as CompanionTask,
    signal: controller.signal,
    assertAuthority: vi.fn().mockResolvedValue(undefined),
    phase: vi.fn(),
    getCheckpoint: <T>(key: string) => checkpoints.get(key) as T | undefined,
    checkpoint: async (key, value) => {
      checkpoints.set(key, value);
    },
    effect: async <T>(key: string, run: () => Promise<T>): Promise<T> => {
      if (receipts.has(key)) return receipts.get(key) as T;
      const receipt = await run();
      receipts.set(key, receipt);
      return receipt;
    },
  };
  const codec = {
    encode: async (value: unknown) => value,
    decode: async (value: unknown) => value as never,
  };
  return { context, controller, codec };
}

describe('durable per-action continuation', () => {
  it('retries a known transient read once, then restores successful steps after downstream failure', async () => {
    const { context, codec } = fixture();
    const read = plannedActionSchema.parse({
      id: 'search',
      tool: 'web_search',
      purpose: 'find source',
      query: 'cats',
    });
    const generate = plannedActionSchema.parse({
      id: 'draw',
      tool: 'image_gen',
      purpose: 'draw',
      query: 'cat',
    });
    const search = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('temporarily unavailable'), { status: 503 }))
      .mockResolvedValue({
        summary: 'Found source',
        verified: true,
        evidence: [{ source: 'https://example.org/cats' }],
      });
    const draw = vi.fn().mockResolvedValue({
      summary: 'Generated',
      verified: true,
      artifacts: [{ kind: 'image', id: 'artifact-1' }],
    });
    await runDurableAction(context, read, search, codec);
    await runDurableAction(context, generate, draw, codec);
    // Simulate worker restart after the next step/composer failed: persistence is retained.
    await runDurableAction(context, read, search, codec);
    await runDurableAction(context, generate, draw, codec);
    expect(search).toHaveBeenCalledTimes(2);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('does not start another action after cancellation or retry a semantic failure', async () => {
    const { context, controller, codec } = fixture();
    const action = plannedActionSchema.parse({
      id: 'search',
      tool: 'web_search',
      purpose: 'find source',
    });
    const invoke = vi.fn().mockResolvedValue({ summary: 'Wrong result', verified: false });
    expect((await runDurableAction(context, action, invoke, codec)).verified).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    controller.abort(new Error('User cancelled'));
    await expect(runDurableAction(context, action, invoke, codec)).rejects.toThrow(
      'User cancelled',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
