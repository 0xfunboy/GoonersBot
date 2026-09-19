import { describe, expect, it, vi } from 'vitest';
import { plannedActionSchema } from '../src/agent/schemas.js';
import {
  createRequestContract,
  runDurableAction,
  TaskRetryableError,
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

  it('reuses an unchanged public read across amendments but invalidates a changed query', async () => {
    const { context, codec } = fixture();
    const action = plannedActionSchema.parse({
      id: 'search',
      tool: 'web_search',
      purpose: 'find sources for the report',
      query: 'original subject',
    });
    const invoke = vi.fn().mockResolvedValue({
      summary: 'Inspected source',
      verified: true,
      evidence: [{ source: 'https://example.org/report' }],
    });
    await runDurableAction(context, action, invoke, codec);
    context.task.contract.acceptedVersion += 1;
    await runDurableAction(context, action, invoke, codec);
    expect(invoke).toHaveBeenCalledTimes(1);
    await runDurableAction(context, { ...action, query: 'corrected subject' }, invoke, codec);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('persists a long retry deadline and resumes the same bounded read after restart', async () => {
    const { context, codec } = fixture();
    const action = plannedActionSchema.parse({
      id: 'search',
      tool: 'web_search',
      purpose: 'find source',
      query: 'subject',
    });
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 5000 }),
      )
      .mockResolvedValue({
        summary: 'Source found',
        verified: true,
        evidence: [{ source: 'https://example.org' }],
      });
    await expect(runDurableAction(context, action, invoke, codec)).rejects.toBeInstanceOf(
      TaskRetryableError,
    );
    await expect(runDurableAction(context, action, invoke, codec)).rejects.toBeInstanceOf(
      TaskRetryableError,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    const future = Date.now() + 6000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(future);
    try {
      expect((await runDurableAction(context, action, invoke, codec)).verified).toBe(true);
      await runDurableAction(context, action, invoke, codec);
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('schedules a timed-out read only after its handler acknowledges cancellation', async () => {
    const { context, codec } = fixture();
    const actionTimeout = new AbortController();
    const action = plannedActionSchema.parse({ id: 'search', tool: 'web_search', purpose: 'read' });
    const invoke = vi.fn(async () => {
      actionTimeout.abort(new Error('tool timed out after 100ms'));
      throw actionTimeout.signal.reason;
    });
    await expect(
      runDurableAction(context, action, invoke, codec, actionTimeout.signal),
    ).rejects.toBeInstanceOf(TaskRetryableError);
    expect(invoke).toHaveBeenCalledOnce();
  });
});
