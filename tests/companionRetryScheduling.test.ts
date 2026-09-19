import { expect, it, vi } from 'vitest';
import { ToolOrchestrator } from '../src/agent/orchestrator.js';
import { TaskRetryableError } from '../src/companion/tasks/contracts.js';

it('drains concurrent peers before propagating durable retry control to the worker', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const peer = vi.fn(async () => {
    await pending;
    return { summary: 'Saved', verified: true };
  });
  const orchestrator = new ToolOrchestrator(
    [
      { name: 'web_search', description: 'search', risk: 'read' },
      { name: 'document_create', description: 'document', risk: 'generate' },
    ],
    {
      web_search: async () => {
        throw new TaskRetryableError('Try later');
      },
      document_create: peer,
    },
  );
  let settled = false;
  const run = orchestrator.execute(
    {
      goal: 'Prepare report',
      actions: [
        { id: 'search', tool: 'web_search', purpose: 'search' },
        { id: 'document', tool: 'document_create', purpose: 'prepare document' },
      ],
    },
    { request: 'Prepare report' },
  );
  const observed = run.catch((error: unknown) => {
    settled = true;
    return error;
  });
  await vi.waitFor(() => expect(peer).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  release();
  expect(await observed).toBeInstanceOf(TaskRetryableError);
});
