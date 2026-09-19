import { z } from 'zod';

export const requestContractSchema = z
  .object({
    version: z.literal(1),
    acceptedVersion: z.number().int().positive(),
    goal: z.string().min(1).max(12000),
    scope: z
      .object({
        actorTelegramId: z.number().int().positive(),
        chatId: z.number().int(),
        threadId: z.number().int().optional(),
        messageId: z.number().int().positive().optional(),
      })
      .strict(),
    deliverables: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            description: z.string().min(1).max(1000),
            requiresDelivery: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    constraints: z.array(z.string().max(1000)).max(32),
    successCriteria: z.array(z.string().max(1000)).max(32),
    budget: z
      .object({
        maxElapsedMs: z.number().int().min(1000).max(86_400_000),
        maxAttempts: z.number().int().min(1).max(10),
        maxRevisions: z.number().int().min(0).max(5),
      })
      .strict(),
    deadline: z.string().datetime().optional(),
  })
  .strict();

export type RequestContract = z.infer<typeof requestContractSchema>;
export type TaskScope = Pick<RequestContract['scope'], 'actorTelegramId' | 'chatId' | 'threadId'>;

export function createRequestContract(input: {
  goal: string;
  actorTelegramId: number;
  chatId: number;
  threadId?: number;
  messageId?: number;
  deliverables?: RequestContract['deliverables'];
  budget?: Partial<RequestContract['budget']>;
  constraints?: string[];
  successCriteria?: string[];
  deadline?: string;
}): RequestContract {
  return requestContractSchema.parse({
    version: 1,
    acceptedVersion: 1,
    goal: input.goal,
    scope: {
      actorTelegramId: input.actorTelegramId,
      chatId: input.chatId,
      threadId: input.threadId,
      messageId: input.messageId,
    },
    deliverables: input.deliverables ?? [
      { id: 'answer', description: input.goal.slice(0, 1000), requiresDelivery: true },
    ],
    constraints: input.constraints ?? [],
    successCriteria: input.successCriteria ?? [],
    budget: { maxElapsedMs: 15 * 60_000, maxAttempts: 3, maxRevisions: 2, ...input.budget },
    deadline: input.deadline,
  });
}

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'delivering'
  | 'completed'
  | 'waiting_for_user'
  | 'waiting_for_access'
  | 'waiting_for_schedule'
  | 'retry_scheduled'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'delivery_unknown';

export interface TaskEvent {
  at: Date;
  type: string;
  version: number;
  detail?: string;
}

export interface TaskEffect {
  key: string;
  status: 'pending' | 'confirmed';
  startedAt: Date;
  completedAt?: Date;
  receipt?: unknown;
}

export interface CompanionTask {
  id: string;
  key: string;
  contract: RequestContract;
  payload: Record<string, unknown>;
  status: TaskStatus;
  version: number;
  fence: number;
  ownerId: string | null;
  leaseUntil: Date | null;
  startedAt: Date | null;
  resumeAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  terminalAt?: Date;
  attempts: number;
  revisions: number;
  consumedMs: number;
  replaySafe: boolean;
  summary: string;
  reason?: string;
  result?: unknown;
  messageIds: number[];
  checkpoints: Array<{ key: string; value: unknown; at: Date }>;
  effects: TaskEffect[];
  events: TaskEvent[];
}

export interface TaskClaim {
  id: string;
  ownerId: string;
  fence: number;
  version: number;
}

export interface TaskOutcome {
  status:
    | 'completed'
    | 'partial'
    | 'failed'
    | 'waiting_for_user'
    | 'waiting_for_access'
    | 'retry_scheduled';
  summary: string;
  reason?: string;
  result?: unknown;
  resumeAt?: Date;
  deliverables?: Array<{ id: string; verified: boolean; delivered: boolean }>;
}

export interface TaskControlEvent {
  taskId: string;
  scope: TaskScope;
  expectedVersion: number;
  action: 'pause' | 'resume' | 'cancel' | 'amend';
  contract?: RequestContract;
  payload?: Record<string, unknown>;
}

export class TaskAuthorityError extends Error {
  constructor() {
    super('Task authority expired or task was changed');
    this.name = 'TaskAuthorityError';
  }
}

export class TaskEffectUnknownError extends Error {
  constructor(
    readonly effectKey: string,
    options?: ErrorOptions,
  ) {
    super(`External effect ${effectKey} has an unconfirmed outcome`, options);
    this.name = 'TaskEffectUnknownError';
  }
}

/** Only explicitly classified failures are retryable; an exception alone proves no such thing. */
export class TaskRetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 5_000,
  ) {
    super(message);
    this.name = 'TaskRetryableError';
  }
}

/** Shared scheduling policy: the conversation must not promise a retry the worker cannot admit. */
export function taskRetryResumeAt(
  task: CompanionTask,
  error: TaskRetryableError,
  now = Date.now(),
): Date | null {
  if (task.attempts >= task.contract.budget.maxAttempts) return null;
  const requested = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 5000;
  const delay = Math.min(300_000, Math.max(1000, requested) * 2 ** Math.max(0, task.attempts - 1));
  const resumeAt = new Date(now + delay);
  if (task.contract.deadline && resumeAt.getTime() >= Date.parse(task.contract.deadline))
    return null;
  return resumeAt;
}
