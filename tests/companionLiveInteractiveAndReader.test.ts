import { describe, expect, it, vi, afterEach } from 'vitest';
import { CompanionTaskProgressReporter } from '../src/companion/tasks/progress.js';
import { callbackHandlers } from '../src/telegram/handlers/callbacks/index.js';
import { CORTEX_FEWSHOT } from '../src/brain/cortex/prompt.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CompanionTaskProgressReporter with inline keyboard', () => {
  it('attaches cancel and details inline keyboard when taskId is provided', async () => {
    const editMessageText = vi.fn().mockResolvedValue(true);
    const deleteMessage = vi.fn().mockResolvedValue(true);

    const reporter = new CompanionTaskProgressReporter(
      { editMessageText, deleteMessage } as never,
      {
        chatId: 12345,
        messageId: 888,
        taskId: 'task-abc-123',
      },
    );

    await reporter.update(30, 'Elaborazione in corso...');
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledWith(
      12345,
      888,
      expect.stringContaining('[███░░░░░░░] 30% · Elaborazione in corso...'),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: [
            [
              expect.objectContaining({
                text: '⏹️ Annulla',
                callback_data: 'task_cancel|task-abc-123',
              }),
              expect.objectContaining({
                text: 'ℹ️ Dettagli',
                callback_data: 'task_info|task-abc-123',
              }),
            ],
          ],
        }),
      }),
    );
  });
});

describe('Task interactive callbacks (task_cancel and task_info)', () => {
  const cancelHandler = callbackHandlers.find((h) => h.action === 'task_cancel')!;
  const infoHandler = callbackHandlers.find((h) => h.action === 'task_info')!;

  it('registers task_cancel and task_info specs', () => {
    expect(cancelHandler).toBeDefined();
    expect(infoHandler).toBeDefined();
  });

  it('rejects cancellation from non-author and non-admin', async () => {
    const mockTask = {
      id: 'task-1',
      contract: {
        goal: 'Download huge model',
        scope: { actorTelegramId: 99999, chatId: 100 },
      },
      status: 'running',
      version: 1,
    };

    const services = {
      companionWork: {
        tasks: {
          getById: vi.fn().mockResolvedValue(mockTask),
          control: vi.fn(),
        },
      },
      permissions: {
        isBotAdminPerson: vi.fn().mockReturnValue(false),
      },
    };

    const res = await cancelHandler.handle({
      services: services as never,
      person: { telegramId: 11111 } as never,
      context: { chatId: 100, isGroupAdmin: false } as never,
      message: {} as never,
      args: ['task-1'],
      botUsername: 'GoonerBot',
      addressed: true,
    });

    expect(res).toEqual(
      expect.objectContaining({
        rawText: expect.stringContaining('Non hai i permessi per annullare'),
      }),
    );
    expect(services.companionWork.tasks.control).not.toHaveBeenCalled();
  });

  it('allows cancellation if caller is the author', async () => {
    const mockTask = {
      id: 'task-1',
      contract: {
        goal: 'Generate complex animation',
        scope: { actorTelegramId: 11111, chatId: 100 },
      },
      status: 'running',
      version: 2,
    };

    const services = {
      companionWork: {
        tasks: {
          getById: vi.fn().mockResolvedValue(mockTask),
          control: vi.fn().mockResolvedValue({ ...mockTask, status: 'cancelled' }),
        },
      },
      permissions: {
        isBotAdminPerson: vi.fn().mockReturnValue(false),
      },
    };

    const res = await cancelHandler.handle({
      services: services as never,
      person: { telegramId: 11111 } as never,
      context: { chatId: 100, isGroupAdmin: false } as never,
      message: {} as never,
      args: ['task-1'],
      botUsername: 'GoonerBot',
      addressed: true,
    });

    expect(res).toEqual(
      expect.objectContaining({
        deleteOrigin: true,
        rawText: expect.stringContaining('⏹️ Task annullato'),
      }),
    );
    expect(services.companionWork.tasks.control).toHaveBeenCalledWith({
      taskId: 'task-1',
      scope: mockTask.contract.scope,
      expectedVersion: 2,
      action: 'cancel',
    });
  });

  it('task_info displays status and elapsed time', async () => {
    const mockTask = {
      id: 'task-1',
      contract: { goal: 'Render photorealistic artwork' },
      status: 'running',
      createdAt: new Date(Date.now() - 45_000),
      attempts: 1,
    };

    const services = {
      companionWork: {
        tasks: {
          getById: vi.fn().mockResolvedValue(mockTask),
        },
      },
    };

    const res = await infoHandler.handle({
      services: services as never,
      person: { telegramId: 11111 } as never,
      context: { chatId: 100 } as never,
      message: {} as never,
      args: ['task-1'],
      botUsername: 'GoonerBot',
      addressed: true,
    });

    expect(res).toEqual(
      expect.objectContaining({
        rawText: expect.stringContaining('Render photorealistic artwork'),
      }),
    );
    expect(res?.rawText).toContain('running');
  });
});

describe('Cortex generative model test sample pattern', () => {
  it('includes compound web_search and image_gen in Cortex few-shot prompt for model tests', () => {
    expect(CORTEX_FEWSHOT).toContain('Qwen-Image-2.1');
    expect(CORTEX_FEWSHOT).toContain('"tool":"web_search"');
    expect(CORTEX_FEWSHOT).toContain('"tool":"image_gen"');
  });
});
