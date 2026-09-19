import { randomUUID } from 'node:crypto';
import { childLogger } from '../../utils/logger.js';
import {
  TaskAuthorityError,
  TaskEffectUnknownError,
  TaskRetryableError,
  taskRetryResumeAt,
  type CompanionTask,
  type TaskClaim,
  type TaskControlEvent,
  type TaskOutcome,
  type TaskScope,
} from './contracts.js';
import { CompanionTaskRepository, type EnqueueTaskInput } from './repository.js';

const log = childLogger('companion-tasks');

export interface TaskExecutionContext {
  task: CompanionTask;
  signal: AbortSignal;
  checkpoint(key: string, value: unknown): Promise<void>;
  getCheckpoint<T = unknown>(key: string): T | undefined;
  /** Persist intent first and receipt afterward. Unknown effects are never automatically repeated. */
  effect<T>(key: string, run: () => Promise<T>): Promise<T>;
  assertAuthority(): Promise<void>;
  phase(status: 'verifying' | 'delivering'): Promise<void>;
}

export interface CompanionTaskServiceOptions {
  execute: (context: TaskExecutionContext) => Promise<TaskOutcome>;
  concurrency?: number;
  pollMs?: number;
  leaseMs?: number;
  maxActive?: number;
}

/** A bounded worker lane separate from conversation/control handling; checkpoints survive restart. */
export class CompanionTaskService {
  private readonly ownerId = randomUUID();
  private readonly active = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; actorTelegramId: number }
  >();
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private ticking = false;
  private admission: Promise<unknown> = Promise.resolve();

  constructor(
    readonly repository: CompanionTaskRepository,
    private readonly options: CompanionTaskServiceOptions,
  ) {
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4));
    this.leaseMs = Math.max(5000, options.leaseMs ?? 60_000);
  }

  async enqueue(input: EnqueueTaskInput): Promise<CompanionTask> {
    // Admission is serialized so concurrent incoming turns cannot overrun this worker's queue cap.
    const result = this.admission.then(() =>
      this.repository.enqueue(input, this.options.maxActive ?? 100),
    );
    this.admission = result.catch(() => undefined);
    const task = await result;
    this.wake();
    return task;
  }

  getVisible(taskId: string, scope: TaskScope): Promise<CompanionTask | null> {
    return this.repository.getVisible(taskId, scope);
  }

  listVisible(scope: TaskScope, limit = 12): Promise<CompanionTask[]> {
    return this.repository.listVisible(scope, limit);
  }

  attachMessage(taskId: string, scope: TaskScope, messageId: number): Promise<boolean> {
    return this.repository.attachMessage(taskId, scope, messageId);
  }

  async control(input: TaskControlEvent): Promise<CompanionTask | null> {
    const task = await this.repository.control(input);
    if (task) {
      this.active.get(task.id)?.controller.abort(new TaskAuthorityError());
      this.wake();
    }
    return task;
  }

  async revokeActor(actorTelegramId: number): Promise<number> {
    const affected = await this.repository.revokeActor(actorTelegramId);
    for (const entry of this.active.values()) {
      if (entry.actorTelegramId === actorTelegramId)
        entry.controller.abort(new TaskAuthorityError());
    }
    return affected;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const entry of this.active.values()) entry.controller.abort(new TaskAuthorityError());
    // Do not make shutdown wait indefinitely for an uncooperative SDK; its lease will expire.
    await Promise.race([
      Promise.allSettled([...this.active.values()].map((entry) => entry.promise)),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        timeout.unref();
      }),
    ]);
  }

  private wake(): void {
    if (this.stopped || this.ticking) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, 0);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.repository.recoverExpired();
      while (!this.stopped && this.active.size < this.concurrency) {
        const task = await this.repository.claim(this.ownerId, this.leaseMs);
        if (!task) break;
        const controller = new AbortController();
        const promise = this.execute(task, controller)
          .catch((error) => {
            log.error({ error, taskId: task.id }, 'durable companion task failed');
          })
          .finally(() => {
            this.active.delete(task.id);
            this.wake();
          });
        this.active.set(task.id, {
          promise,
          controller,
          actorTelegramId: task.contract.scope.actorTelegramId,
        });
      }
    } catch (error) {
      log.warn({ error }, 'companion worker polling failed; retrying later');
    } finally {
      this.ticking = false;
      if (!this.stopped) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(
          () => {
            void this.tick();
          },
          Math.max(250, this.options.pollMs ?? 1000),
        );
        this.timer.unref();
      }
    }
  }

  private async execute(task: CompanionTask, controller: AbortController): Promise<void> {
    const claim: TaskClaim = {
      id: task.id,
      version: task.version,
      fence: task.fence,
      ownerId: this.ownerId,
    };
    const budget = task.contract.budget;
    const remainingMs = Math.min(
      budget.maxElapsedMs - task.consumedMs,
      task.contract.deadline ? Date.parse(task.contract.deadline) - Date.now() : Infinity,
    );
    if (remainingMs <= 0 || task.attempts > budget.maxAttempts) {
      await this.repository.finish(claim, {
        status: 'partial',
        summary:
          'Il lavoro ha raggiunto il budget disponibile; i risultati verificati sono conservati.',
        reason: 'budget_exhausted',
      });
      return;
    }
    let heartbeatBusy = false;
    const heartbeat = setInterval(
      () => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void this.repository
          .heartbeat(claim, this.leaseMs)
          .then((alive) => {
            if (!alive) controller.abort(new TaskAuthorityError());
          })
          .catch(() => controller.abort(new TaskAuthorityError()))
          .finally(() => {
            heartbeatBusy = false;
          });
      },
      Math.max(1000, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref();
    let budgetExpired = false;
    const timeout = setTimeout(() => {
      budgetExpired = true;
      controller.abort(new Error('Task elapsed-time budget exhausted'));
    }, remainingMs);
    timeout.unref();
    const assertAuthority = async (): Promise<void> => {
      if (controller.signal.aborted || !(await this.repository.hasAuthority(claim)))
        throw new TaskAuthorityError();
    };
    const context: TaskExecutionContext = {
      task,
      signal: controller.signal,
      assertAuthority,
      getCheckpoint: <T>(key: string) =>
        task.checkpoints.find((entry) => entry.key === key)?.value as T | undefined,
      checkpoint: async (key, value) => {
        if (!(await this.repository.checkpoint(claim, key, value))) throw new TaskAuthorityError();
        task.checkpoints = [
          ...task.checkpoints.filter((entry) => entry.key !== key),
          { key, value, at: new Date() },
        ];
      },
      phase: async (status) => {
        await assertAuthority();
        if (!(await this.repository.phase(claim, status))) throw new TaskAuthorityError();
      },
      effect: async <T>(key: string, run: () => Promise<T>): Promise<T> => {
        await assertAuthority();
        const previous = task.effects.find((effect) => effect.key === key);
        if (previous?.status === 'confirmed') return previous.receipt as T;
        if (previous) throw new TaskEffectUnknownError(key);
        if (!(await this.repository.beginEffect(claim, key))) throw new TaskAuthorityError();
        const effect = { key, status: 'pending' as const, startedAt: new Date() };
        task.effects.push(effect);
        try {
          await assertAuthority();
          const receipt = await run();
          if (!(await this.repository.confirmEffect(claim, key, receipt)))
            throw new TaskEffectUnknownError(key);
          task.effects = task.effects.map((item) =>
            item.key === key
              ? { ...item, status: 'confirmed', receipt, completedAt: new Date() }
              : item,
          );
          return receipt;
        } catch (error) {
          throw error instanceof TaskEffectUnknownError
            ? error
            : new TaskEffectUnknownError(key, { cause: error });
        }
      },
    };
    try {
      // The orchestration lane must also stop if a provider SDK ignores AbortSignal. Its late result
      // cannot publish: every effect rechecks both the signal and the durable fence.
      let abortListener: (() => void) | undefined;
      let outcome: TaskOutcome;
      try {
        outcome = await Promise.race([
          this.options.execute(context),
          new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(controller.signal.reason ?? new TaskAuthorityError());
            if (controller.signal.aborted) abortListener();
            else controller.signal.addEventListener('abort', abortListener, { once: true });
          }),
        ]);
      } finally {
        if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      }
      await assertAuthority();
      if (outcome.status === 'completed') {
        const missing = task.contract.deliverables.filter(
          (required) =>
            !outcome.deliverables?.some(
              (actual) =>
                actual.id === required.id &&
                actual.verified &&
                (!required.requiresDelivery || actual.delivered),
            ),
        );
        if (missing.length) {
          outcome.status = 'partial';
          outcome.reason = `Unverified deliverables: ${missing.map((item) => item.id).join(', ')}`;
        }
      }
      if (outcome.status === 'retry_scheduled') {
        if (
          task.attempts >= budget.maxAttempts ||
          !outcome.resumeAt ||
          outcome.resumeAt.getTime() <= Date.now()
        ) {
          outcome.status = 'partial';
          outcome.reason = 'Retry budget exhausted or missing future resume time';
        }
      }
      if (task.effects.some((effect) => effect.status === 'pending')) {
        await this.repository.finish(claim, {
          status: 'delivery_unknown',
          summary: outcome.summary,
          reason: 'An operation returned without a confirmed effect receipt',
        });
        return;
      }
      if (!(await this.repository.finish(claim, outcome))) throw new TaskAuthorityError();
    } catch (error) {
      if (error instanceof TaskAuthorityError) return;
      const pending = task.effects.some((effect) => effect.status === 'pending');
      if (pending || error instanceof TaskEffectUnknownError) {
        await this.repository.finish(claim, {
          status: 'delivery_unknown',
          summary:
            'Una parte del lavoro potrebbe essere già stata eseguita. Ho fermato i tentativi automatici per evitare duplicati.',
          reason: 'external_outcome_unknown',
        });
      } else if (budgetExpired) {
        await this.repository.finish(claim, {
          status: 'partial',
          summary: 'Ho raggiunto il tempo disponibile. I risultati verificati sono conservati.',
          reason: 'budget_exhausted',
        });
      } else if (error instanceof TaskRetryableError) {
        const resumeAt = taskRetryResumeAt(task, error);
        await this.repository.finish(claim, {
          status: resumeAt ? 'retry_scheduled' : 'partial',
          summary: resumeAt
            ? error.message.slice(0, 1000)
            : 'Il prossimo tentativo supererebbe il budget o la scadenza. I risultati verificati sono conservati.',
          reason: resumeAt ? 'temporary_provider_failure' : 'retry_budget_or_deadline',
          ...(resumeAt ? { resumeAt } : {}),
        });
      } else {
        await this.repository.finish(claim, {
          status: 'failed',
          summary:
            'Non sono riuscito a completare questo lavoro. I risultati già verificati sono conservati.',
          reason: error instanceof Error ? error.name : 'execution_failed',
        });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }
}
