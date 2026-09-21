import { describe, expect, it, vi } from 'vitest';
import { CompanionWorkService } from '../src/services/companionWork.js';
import {
  createRequestContract,
  type CompanionTask,
  type TaskOutcome,
} from '../src/companion/tasks/contracts.js';
import type { TaskExecutionContext } from '../src/companion/tasks/service.js';
import type { AgentRuntimeInput } from '../src/services/agentRuntime.js';

function fixture() {
  const input: AgentRuntimeInput = {
    request: 'Crea due immagini diverse',
    language: 'italian',
    person: { telegramId: 10, userHandle: '@alice' },
    context: {
      chatId: -20,
      threadId: 3,
      messageId: 4,
      isGroup: true,
      isBotMentioned: true,
      isReplyToBot: false,
    },
    recentMessages: [],
    requestedActions: [{ tool: 'image_gen', reason: 'due immagini', query: 'due immagini' }],
  };
  const now = new Date();
  const task: CompanionTask = {
    id: 'task-a',
    key: 'bot:1:update:2',
    contract: createRequestContract({
      goal: input.request,
      actorTelegramId: 10,
      chatId: -20,
      threadId: 3,
    }),
    payload: { input, groupPlan: 'free' },
    status: 'running',
    version: 1,
    fence: 1,
    ownerId: 'worker',
    leaseUntil: new Date(now.getTime() + 60000),
    startedAt: now,
    resumeAt: null,
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    revisions: 0,
    consumedMs: 0,
    replaySafe: true,
    summary: '',
    checkpoints: [],
    effects: [],
    events: [],
    messageIds: [4],
  };
  const runtime = {
    run: vi.fn().mockResolvedValue({
      text: 'Eccole, una per ciascuna idea.',
      sources: [],
      status: 'complete',
      runtimeArtifacts: [
        { actionId: 'image-a', data: { kind: 'image', buffer: Buffer.from('first') } },
        { actionId: 'image-b', data: { kind: 'image', buffer: Buffer.from('second') } },
      ],
    }),
  };
  const repository = {
    attachMessage: vi.fn().mockResolvedValue(true),
    listVisible: vi.fn().mockResolvedValue([task]),
    control: vi.fn().mockResolvedValue({ ...task, status: 'cancelled', version: 2 }),
    patchPresentation: vi.fn().mockResolvedValue(true),
  };
  const blobs = new Map<string, Buffer>();
  let index = 0;
  const artifacts = {
    put: vi.fn(async (buffer: Buffer, metadata: Record<string, unknown>) => {
      const id = `artifact-${++index}`;
      blobs.set(id, buffer);
      return { ...metadata, id };
    }),
    read: vi.fn(async (ref: { id: string }) => blobs.get(ref.id)),
  };
  const service = new CompanionWorkService({
    repository,
    runtime,
    artifacts,
    enabled: true,
    concurrency: 1,
    authorize: vi.fn().mockResolvedValue(true),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    remember: vi.fn().mockResolvedValue(undefined),
  } as never);
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 40 }),
    sendPhoto: vi
      .fn()
      .mockResolvedValueOnce({ message_id: 41 })
      .mockResolvedValueOnce({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };
  // Attach the test sender without starting the real poller.
  (service as unknown as { api: unknown }).api = api;
  const receipts = new Map<string, unknown>();
  const checkpoints = new Map<string, unknown>();
  const context: TaskExecutionContext = {
    task,
    signal: new AbortController().signal,
    assertAuthority: vi.fn(),
    checkpoint: async (key, value) => {
      checkpoints.set(key, value);
    },
    getCheckpoint: <T>(key: string) => checkpoints.get(key) as T | undefined,
    phase: vi.fn(),
    effect: async <T>(key: string, run: () => Promise<T>): Promise<T> => {
      if (receipts.has(key)) return receipts.get(key) as T;
      const result = await run();
      receipts.set(key, result);
      return result;
    },
  };
  const execute = () =>
    (service as unknown as { execute(ctx: TaskExecutionContext): Promise<TaskOutcome> }).execute(
      context,
    );
  return { input, task, runtime, repository, artifacts, service, api, receipts, context, execute };
}

describe('companion work host bridge', () => {
  it('delivers two distinct images and reuses each receipt after restart', async () => {
    const f = fixture();
    expect((await f.execute()).status).toBe('completed');
    expect((await f.execute()).status).toBe('completed');
    expect(f.runtime.run).toHaveBeenCalledTimes(1);
    expect(f.artifacts.put.mock.calls.map((call) => call[0].toString())).toEqual([
      'first',
      'second',
    ]);
    expect(f.api.sendPhoto).toHaveBeenCalledTimes(2);
    expect(f.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.receipts.get('artifact:v1:0:artifact-1')).toEqual({
      messageId: 41,
      artifactId: 'artifact-1',
    });
    expect(f.receipts.get('artifact:v1:1:artifact-2')).toEqual({
      messageId: 42,
      artifactId: 'artifact-2',
    });
    expect(f.api.deleteMessage).toHaveBeenCalledWith(-20, 4);
  });

  it('handles status and cancellation without invoking the runtime', async () => {
    const f = fixture();
    const understanding = {
      interactions: [
        { kind: 'status', referentIds: ['work:task-a'] },
        { kind: 'cancel', referentIds: ['work:task-a'] },
      ],
    };
    const text = await f.service.control(
      understanding as never,
      f.input.person,
      f.input.context,
      'italian',
    );
    expect(text).toContain('Ci sto lavorando');
    expect(text).toContain('Ho fermato');
    expect(f.repository.control).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cancel',
        expectedVersion: 1,
        scope: { actorTelegramId: 10, chatId: -20, threadId: 3 },
      }),
    );
    expect(f.runtime.run).not.toHaveBeenCalled();
  });

  it('keeps missing input waiting without invoking any provider or delivery', async () => {
    const f = fixture();
    f.task.payload['pending'] = { prompt: 'Quale episodio intendi?' };
    expect(await f.execute()).toMatchObject({
      status: 'waiting_for_user',
      reason: 'missing_input',
    });
    expect(f.runtime.run).not.toHaveBeenCalled();
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });

  it('a request for a serious tone preserves the active plan and execution', async () => {
    const f = fixture();
    const text = await f.service.control(
      {
        interactions: [{ kind: 'amend_work', referentIds: ['work:task-a'] }],
        proposedOperations: [],
        socialPosture: { socialSignal: { humorAllowed: false } },
      } as never,
      f.input.person,
      f.input.context,
      'it',
      'parla seriamente',
    );
    expect(text).toContain('niente battute');
    expect(f.repository.patchPresentation).toHaveBeenCalledWith(
      'task-a',
      { actorTelegramId: 10, chatId: -20, threadId: 3 },
      1,
      { humorAllowed: false },
    );
    expect(f.repository.control).not.toHaveBeenCalled();
    expect(f.runtime.run).not.toHaveBeenCalled();
  });
});
