import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

export const LOCAL_DEVELOPMENT_JOB_STATES = [
  'queued',
  'generating',
  'policy_check',
  'verifying',
  'ready',
  'applying',
  'failed',
  'conflict',
  'applied',
  'cancelled',
  'stale',
] as const;

export const localDevelopmentJobStateSchema = z.enum(LOCAL_DEVELOPMENT_JOB_STATES);
export type LocalDevelopmentJobState = z.infer<typeof localDevelopmentJobStateSchema>;

const telegramIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const jobIdSchema = z.string().uuid();
const gitShaSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
  .transform((value) => value.toLowerCase());
const artifactHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());
const safeCodeSchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/);
const timestampSchema = z.string().datetime();

export const localDevelopmentCheckSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
    status: z.enum(['pending', 'passed', 'failed', 'skipped']),
    code: safeCodeSchema.optional(),
    checkedAt: timestampSchema.optional(),
    durationMs: z.number().int().nonnegative().max(3_600_000).optional(),
  })
  .strict();

export type LocalDevelopmentCheck = z.infer<typeof localDevelopmentCheckSchema>;

const artifactFilesSchema = z
  .array(z.string().min(1).max(240).refine(isSafeArtifactPath, 'unsafe artifact path'))
  .max(128)
  .superRefine((files, context) => {
    if (new Set(files).size !== files.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate artifact path' });
    }
  });

export const localDevelopmentJobSchema = z
  .object({
    version: z.literal(1),
    id: jobIdSchema,
    revision: z.number().int().positive(),
    state: localDevelopmentJobStateSchema,
    actorTelegramId: telegramIdSchema,
    privateChatId: telegramIdSchema,
    goal: z
      .string()
      .trim()
      .min(8)
      .max(2_000)
      .refine(hasOnlySafeGoalCharacters, 'unsafe goal characters')
      .refine((value) => !looksLikeRawSecret(value), 'raw secret rejected'),
    baseSha: gitShaSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    stateChangedAt: timestampSchema,
    artifactHash: artifactHashSchema.optional(),
    artifactFiles: artifactFilesSchema,
    checks: z.array(localDevelopmentCheckSchema).max(32),
    resultCode: safeCodeSchema.optional(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.actorTelegramId !== job.privateChatId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['privateChatId'],
        message: 'private chat must belong to actor',
      });
    }
    if (new Set(job.checks.map((check) => check.id)).size !== job.checks.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks'],
        message: 'duplicate check',
      });
    }
    if (
      job.state === 'ready' ||
      job.state === 'applying' ||
      job.state === 'applied' ||
      (job.state === 'conflict' && job.resultCode === 'apply_interrupted')
    ) {
      if (!job.artifactHash || job.artifactFiles.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifactHash'],
          message: 'verified artifact required',
        });
      }
      if (
        job.checks.length === 0 ||
        job.checks.some((check) => check.status !== 'passed' && check.status !== 'skipped')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checks'],
          message: 'completed safe checks required',
        });
      }
    }
    if (
      (job.state === 'failed' || job.state === 'conflict' || job.state === 'stale') &&
      !job.resultCode
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resultCode'],
        message: 'safe result code required',
      });
    }
  });

export type LocalDevelopmentJob = z.infer<typeof localDevelopmentJobSchema>;

export const localDevelopmentJobCreateSchema = z
  .object({
    actorTelegramId: telegramIdSchema,
    privateChatId: telegramIdSchema,
    goal: z
      .string()
      .trim()
      .min(8)
      .max(2_000)
      .refine(hasOnlySafeGoalCharacters, 'unsafe goal characters')
      .refine((value) => !looksLikeRawSecret(value), 'raw secret rejected'),
    baseSha: gitShaSchema,
  })
  .strict()
  .refine((input) => input.actorTelegramId === input.privateChatId, {
    path: ['privateChatId'],
    message: 'private chat must belong to actor',
  });

export type LocalDevelopmentJobCreate = z.infer<typeof localDevelopmentJobCreateSchema>;

export const localDevelopmentJobUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive().optional(),
    state: localDevelopmentJobStateSchema.optional(),
    artifactHash: artifactHashSchema.nullable().optional(),
    artifactFiles: artifactFilesSchema.optional(),
    checks: z.array(localDevelopmentCheckSchema).max(32).optional(),
    resultCode: safeCodeSchema.nullable().optional(),
  })
  .strict()
  .superRefine((patch, context) => {
    if (
      patch.state === undefined &&
      patch.artifactHash === undefined &&
      patch.artifactFiles === undefined &&
      patch.checks === undefined &&
      patch.resultCode === undefined
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'empty update' });
    }
    if (
      patch.checks &&
      new Set(patch.checks.map((check) => check.id)).size !== patch.checks.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks'],
        message: 'duplicate check',
      });
    }
  });

export type LocalDevelopmentJobUpdate = z.infer<typeof localDevelopmentJobUpdateSchema>;

const localDevelopmentJobListSchema = z
  .object({
    actorTelegramId: telegramIdSchema.optional(),
    states: z
      .array(localDevelopmentJobStateSchema)
      .max(LOCAL_DEVELOPMENT_JOB_STATES.length)
      .optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export type LocalDevelopmentJobListOptions = z.input<typeof localDevelopmentJobListSchema>;

export const localDevelopmentLeaseSchema = z
  .object({
    version: z.literal(1),
    jobId: jobIdSchema,
    token: z.string().uuid(),
    acquiredAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export type LocalDevelopmentLease = z.infer<typeof localDevelopmentLeaseSchema>;

export type LocalDevelopmentLeaseResult =
  | { acquired: true; token: string; expiresAt: string }
  | { acquired: false; reason: 'busy' | 'not_found' | 'not_runnable' };

export interface LocalDevelopmentJobStoreOptions {
  /** Dedicated private directory disjoint from the repository tree. Must be absolute. */
  root: string;
  repositoryRoot?: string;
  clock?: () => Date;
  leaseTtlMs?: number;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

export type LocalDevelopmentJobStoreErrorCode =
  | 'invalid_configuration'
  | 'invalid_input'
  | 'not_found'
  | 'revision_conflict'
  | 'invalid_transition'
  | 'lease_required'
  | 'lease_lost'
  | 'lock_timeout'
  | 'storage_failure';

const ERROR_MESSAGES: Record<LocalDevelopmentJobStoreErrorCode, string> = {
  invalid_configuration: 'invalid local development job store configuration',
  invalid_input: 'invalid local development job input',
  not_found: 'local development job not found',
  revision_conflict: 'local development job revision conflict',
  invalid_transition: 'invalid local development job state transition',
  lease_required: 'an active local development lease is required',
  lease_lost: 'local development lease expired or was superseded',
  lock_timeout: 'local development job store is busy',
  storage_failure: 'local development job storage operation failed',
};

export class LocalDevelopmentJobStoreError extends Error {
  constructor(public readonly code: LocalDevelopmentJobStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'LocalDevelopmentJobStoreError';
  }
}

const TRANSITIONS: Record<LocalDevelopmentJobState, ReadonlySet<LocalDevelopmentJobState>> = {
  queued: new Set(['generating', 'failed', 'conflict', 'cancelled', 'stale']),
  generating: new Set(['policy_check', 'verifying', 'failed', 'conflict', 'cancelled', 'stale']),
  policy_check: new Set(['verifying', 'failed', 'conflict', 'cancelled', 'stale']),
  verifying: new Set(['ready', 'failed', 'conflict', 'cancelled', 'stale']),
  ready: new Set(['applying', 'cancelled']),
  applying: new Set(['applied', 'conflict']),
  failed: new Set(),
  conflict: new Set(),
  applied: new Set(),
  cancelled: new Set(),
  stale: new Set(['generating', 'failed', 'cancelled']),
};

const RUNNABLE_STATES = new Set<LocalDevelopmentJobState>(['queued', 'stale', 'ready']);
const ACTIVE_LEASE_STATES = new Set<LocalDevelopmentJobState>([
  'queued',
  'generating',
  'policy_check',
  'verifying',
  'applying',
]);
const WORKER_STATES = new Set<LocalDevelopmentJobState>([
  'generating',
  'policy_check',
  'verifying',
  'ready',
  'applying',
  'failed',
  'conflict',
  'applied',
]);
const TERMINAL_STATES = new Set<LocalDevelopmentJobState>([
  'failed',
  'conflict',
  'applied',
  'cancelled',
]);

const JOBS_DIRECTORY = 'jobs';
const MUTATION_LOCK = '.mutation.lock';
const EXECUTION_LEASE = '.execution-lease.json';
const DEFAULT_LEASE_TTL_MS = 10 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 60 * 60_000;
const MAX_JOB_FILE_BYTES = 256 * 1024;

const mutationLockSchema = z
  .object({
    version: z.literal(1),
    token: z.string().uuid(),
    acquiredAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

/** Durable, process-independent metadata store for bounded local /learn development jobs. */
export class LocalDevelopmentJobStore {
  private readonly root: string;
  private readonly repositoryRoot: string;
  private readonly jobsDirectory: string;
  private readonly mutationLockPath: string;
  private readonly executionLeasePath: string;
  private readonly clock: () => Date;
  private readonly leaseTtlMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  private initialization: Promise<void> | undefined;

  constructor(options: LocalDevelopmentJobStoreOptions) {
    if (
      !isAbsolute(options.root) ||
      (options.repositoryRoot !== undefined && !isAbsolute(options.repositoryRoot))
    ) {
      throw new LocalDevelopmentJobStoreError('invalid_configuration');
    }
    this.root = resolve(options.root);
    this.repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
    if (pathsOverlap(this.root, this.repositoryRoot)) {
      throw new LocalDevelopmentJobStoreError('invalid_configuration');
    }
    this.clock = options.clock ?? (() => new Date());
    this.leaseTtlMs = boundedInteger(
      options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      MIN_LEASE_TTL_MS,
      MAX_LEASE_TTL_MS,
      'invalid_configuration',
    );
    this.lockTimeoutMs = boundedInteger(
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      100,
      30_000,
      'invalid_configuration',
    );
    this.lockStaleMs = boundedInteger(
      options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
      1_000,
      5 * 60_000,
      'invalid_configuration',
    );
    this.jobsDirectory = join(this.root, JOBS_DIRECTORY);
    this.mutationLockPath = join(this.root, MUTATION_LOCK);
    this.executionLeasePath = join(this.root, EXECUTION_LEASE);
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeUnsafe().catch((error: unknown) => {
        this.initialization = undefined;
        throw safeStoreError(error);
      });
    }
    return this.initialization;
  }

  async create(input: LocalDevelopmentJobCreate): Promise<LocalDevelopmentJob> {
    const parsed = localDevelopmentJobCreateSchema.safeParse(input);
    if (!parsed.success) throw new LocalDevelopmentJobStoreError('invalid_input');
    return this.safeOperation(() =>
      this.withGlobalLock(async () => {
        const now = this.currentTimestamp();
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const job: LocalDevelopmentJob = {
            version: 1,
            id: randomUUID(),
            revision: 1,
            state: 'queued',
            actorTelegramId: parsed.data.actorTelegramId,
            privateChatId: parsed.data.privateChatId,
            goal: parsed.data.goal,
            baseSha: parsed.data.baseSha,
            createdAt: now,
            updatedAt: now,
            stateChangedAt: now,
            artifactFiles: [],
            checks: [],
          };
          const validated = parseJob(job);
          try {
            await atomicJsonWrite(this.jobPath(validated.id), validated, true);
            await syncDirectory(this.jobsDirectory);
            return validated;
          } catch (error) {
            if (isErrorCode(error, 'EEXIST')) continue;
            throw error;
          }
        }
        throw new LocalDevelopmentJobStoreError('storage_failure');
      }),
    );
  }

  async get(jobId: string): Promise<LocalDevelopmentJob | null> {
    const id = parseJobId(jobId);
    return this.safeOperation(() =>
      this.withGlobalLock(async () => (await this.readJobUnsafe(id)) ?? null),
    );
  }

  async latestForActor(actorTelegramId: number): Promise<LocalDevelopmentJob | null> {
    const actor = parseTelegramId(actorTelegramId);
    return this.safeOperation(() =>
      this.withGlobalLock(async () => {
        const jobs = await this.listJobsUnsafe();
        return jobs.find((job) => job.actorTelegramId === actor) ?? null;
      }),
    );
  }

  async list(options: LocalDevelopmentJobListOptions = {}): Promise<LocalDevelopmentJob[]> {
    const parsed = localDevelopmentJobListSchema.safeParse(options);
    if (!parsed.success) throw new LocalDevelopmentJobStoreError('invalid_input');
    return this.safeOperation(() =>
      this.withGlobalLock(async () => {
        const stateFilter = parsed.data.states ? new Set(parsed.data.states) : undefined;
        return (await this.listJobsUnsafe())
          .filter(
            (job) =>
              parsed.data.actorTelegramId === undefined ||
              job.actorTelegramId === parsed.data.actorTelegramId,
          )
          .filter((job) => !stateFilter || stateFilter.has(job.state))
          .slice(0, parsed.data.limit);
      }),
    );
  }

  async update(
    jobId: string,
    patch: LocalDevelopmentJobUpdate,
    leaseToken?: string,
  ): Promise<LocalDevelopmentJob> {
    const id = parseJobId(jobId);
    const parsed = localDevelopmentJobUpdateSchema.safeParse(patch);
    if (
      !parsed.success ||
      (leaseToken !== undefined && !jobIdSchema.safeParse(leaseToken).success)
    ) {
      throw new LocalDevelopmentJobStoreError('invalid_input');
    }
    return this.safeOperation(() =>
      this.withGlobalLock(async () => {
        const current = await this.readJobUnsafe(id);
        if (!current) throw new LocalDevelopmentJobStoreError('not_found');
        if (
          parsed.data.expectedRevision !== undefined &&
          parsed.data.expectedRevision !== current.revision
        ) {
          throw new LocalDevelopmentJobStoreError('revision_conflict');
        }
        if (TERMINAL_STATES.has(current.state)) {
          throw new LocalDevelopmentJobStoreError('invalid_transition');
        }
        if (parsed.data.state === 'cancelled') {
          throw new LocalDevelopmentJobStoreError('invalid_transition');
        }
        const nextState = parsed.data.state ?? current.state;
        if (nextState !== current.state && !TRANSITIONS[current.state].has(nextState)) {
          throw new LocalDevelopmentJobStoreError('invalid_transition');
        }
        if (
          (current.state === 'ready' || current.state === 'applying') &&
          verifiedArtifactPatchChanges(current, parsed.data)
        ) {
          throw new LocalDevelopmentJobStoreError('invalid_transition');
        }

        const activeLease = await this.readLeaseUnsafe();
        const ownedLease =
          activeLease?.jobId === id && leaseToken !== undefined && activeLease.token === leaseToken;
        if (leaseToken !== undefined && !ownedLease) {
          throw new LocalDevelopmentJobStoreError('lease_lost');
        }
        if (activeLease?.jobId === id && !ownedLease) {
          throw new LocalDevelopmentJobStoreError('lease_lost');
        }
        if (WORKER_STATES.has(nextState) && !ownedLease) {
          throw new LocalDevelopmentJobStoreError('lease_required');
        }

        const timestamp = this.currentTimestamp();
        const candidate: Record<string, unknown> = {
          ...current,
          revision: current.revision + 1,
          state: nextState,
          updatedAt: timestamp,
          stateChangedAt: nextState === current.state ? current.stateChangedAt : timestamp,
        };
        if (parsed.data.artifactHash !== undefined) {
          if (parsed.data.artifactHash === null) delete candidate.artifactHash;
          else candidate.artifactHash = parsed.data.artifactHash;
        }
        if (parsed.data.artifactFiles !== undefined) {
          candidate.artifactFiles = [...parsed.data.artifactFiles];
        }
        if (parsed.data.checks !== undefined) candidate.checks = [...parsed.data.checks];
        if (parsed.data.resultCode !== undefined) {
          if (parsed.data.resultCode === null) delete candidate.resultCode;
          else candidate.resultCode = parsed.data.resultCode;
        } else if (
          nextState !== current.state &&
          nextState !== 'failed' &&
          nextState !== 'conflict' &&
          nextState !== 'stale'
        ) {
          delete candidate.resultCode;
        }
        const validated = parseJob(candidate);
        await atomicJsonWrite(this.jobPath(id), validated, false);
        await syncDirectory(this.jobsDirectory);
        return validated;
      }),
    );
  }

  async tryAcquireLease(
    jobId: string,
    ttlMs = this.leaseTtlMs,
  ): Promise<LocalDevelopmentLeaseResult> {
    const id = parseJobId(jobId);
    const ttl = boundedInteger(ttlMs, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS, 'invalid_input');
    return this.safeOperation(() =>
      this.withGlobalLock(async () => {
        const job = await this.readJobUnsafe(id);
        if (!job) return { acquired: false, reason: 'not_found' } as const;
        if (!RUNNABLE_STATES.has(job.state)) {
          return { acquired: false, reason: 'not_runnable' } as const;
        }
        if (await this.readLeaseUnsafe()) return { acquired: false, reason: 'busy' } as const;

        const acquiredAt = this.currentDate();
        const lease: LocalDevelopmentLease = {
          version: 1,
          jobId: id,
          token: randomUUID(),
          acquiredAt: acquiredAt.toISOString(),
          expiresAt: new Date(acquiredAt.getTime() + ttl).toISOString(),
        };
        const validated = localDevelopmentLeaseSchema.parse(lease);
        await atomicJsonWrite(this.executionLeasePath, validated, true);
        await syncDirectory(this.root);
        return { acquired: true, token: validated.token, expiresAt: validated.expiresAt } as const;
      }),
    );
  }

  async release(jobId: string, token: string): Promise<boolean> {
    const id = parseJobId(jobId);
    if (!jobIdSchema.safeParse(token).success) {
      throw new LocalDevelopmentJobStoreError('invalid_input');
    }
    return this.safeOperation(() =>
      this.withGlobalLock(async () => {
        const lease = await this.readLeaseUnsafe();
        if (!lease || lease.jobId !== id || lease.token !== token) return false;
        const job = await this.readJobUnsafe(id);
        if (job?.state === 'applying') {
          await this.persistApplyInterruptedJobUnsafe(job);
        } else if (job && ACTIVE_LEASE_STATES.has(job.state)) {
          await this.persistStaleJobUnsafe(job, 'lease_released');
        }
        await unlinkIfExists(this.executionLeasePath);
        await syncDirectory(this.root);
        return true;
      }),
    );
  }

  async cancel(jobId: string, actorTelegramId: number): Promise<LocalDevelopmentJob | null> {
    const id = parseJobId(jobId);
    const actor = parseTelegramId(actorTelegramId);
    return this.safeOperation(() =>
      this.withGlobalLock(async () => {
        const current = await this.readJobUnsafe(id);
        if (!current || current.actorTelegramId !== actor) return null;
        if (current.state === 'cancelled') return current;
        const lease = await this.readLeaseUnsafe();
        if (current.state === 'ready' && lease?.jobId === id) {
          throw new LocalDevelopmentJobStoreError('invalid_transition');
        }
        if (!TRANSITIONS[current.state].has('cancelled')) {
          throw new LocalDevelopmentJobStoreError('invalid_transition');
        }
        const timestamp = this.currentTimestamp();
        const cancelled = parseJob({
          ...current,
          revision: current.revision + 1,
          state: 'cancelled',
          updatedAt: timestamp,
          stateChangedAt: timestamp,
          resultCode: 'cancelled_by_actor',
        });
        await atomicJsonWrite(this.jobPath(id), cancelled, false);
        // Keep an active worker's fence until that worker acknowledges cancellation via release().
        // This prevents a second generated job from running concurrently with a cross-process
        // model/check invocation that has not observed cancellation yet.
        await Promise.all([syncDirectory(this.jobsDirectory), syncDirectory(this.root)]);
        return cancelled;
      }),
    );
  }

  private async initializeUnsafe(): Promise<void> {
    const [prospectiveRoot, canonicalRepository] = await Promise.all([
      canonicalProspectivePath(this.root),
      realpath(this.repositoryRoot),
    ]);
    if (pathsOverlap(prospectiveRoot, canonicalRepository)) {
      throw new LocalDevelopmentJobStoreError('invalid_configuration');
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(this.root);
    if (pathsOverlap(canonicalRoot, canonicalRepository)) {
      throw new LocalDevelopmentJobStoreError('invalid_configuration');
    }
    await chmod(this.root, 0o700);
    await mkdir(this.jobsDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.jobsDirectory, 0o700);
  }

  private async safeOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.initialize();
      return await operation();
    } catch (error) {
      throw safeStoreError(error);
    }
  }

  private async withGlobalLock<T>(operation: () => Promise<T>): Promise<T> {
    const token = await this.acquireGlobalLockUnsafe();
    try {
      await this.recoverExpiredLeaseUnsafe();
      return await operation();
    } finally {
      await this.releaseGlobalLockUnsafe(token);
    }
  }

  private async acquireGlobalLockUnsafe(): Promise<string> {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      const token = randomUUID();
      const acquiredAt = this.currentDate();
      let created = false;
      const lock = {
        version: 1 as const,
        token,
        acquiredAt: acquiredAt.toISOString(),
        expiresAt: new Date(acquiredAt.getTime() + this.lockStaleMs).toISOString(),
      };
      try {
        const handle = await open(this.mutationLockPath, 'wx', 0o600);
        created = true;
        try {
          await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        return token;
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) {
          if (created) await unlinkIfExists(this.mutationLockPath);
          throw error;
        }
        await this.reclaimStaleLockUnsafe();
        if (Date.now() >= deadline) throw new LocalDevelopmentJobStoreError('lock_timeout');
        await delay(10 + Math.floor(Math.random() * 16));
      }
    }
  }

  private async reclaimStaleLockUnsafe(): Promise<void> {
    let metadata: Awaited<ReturnType<typeof stat>>;
    let raw: string;
    try {
      [metadata, raw] = await Promise.all([
        stat(this.mutationLockPath),
        readFile(this.mutationLockPath, 'utf8'),
      ]);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    const parsed = mutationLockSchema.safeParse(parseJson(raw));
    const nowMs = this.currentDate().getTime();
    const stale = parsed.success
      ? Date.parse(parsed.data.expiresAt) <= nowMs
      : nowMs - metadata.mtimeMs >= this.lockStaleMs;
    if (!stale) return;
    const quarantine = join(this.root, `.stale-lock-${randomUUID()}`);
    try {
      await rename(this.mutationLockPath, quarantine);
      await unlinkIfExists(quarantine);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
    }
  }

  private async releaseGlobalLockUnsafe(token: string): Promise<void> {
    try {
      const parsed = mutationLockSchema.safeParse(
        parseJson(await readFile(this.mutationLockPath, 'utf8')),
      );
      if (parsed.success && parsed.data.token === token) {
        await unlinkIfExists(this.mutationLockPath);
      }
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
    }
  }

  private async recoverExpiredLeaseUnsafe(): Promise<void> {
    const lease = await this.readLeaseUnsafe();
    if (!lease || Date.parse(lease.expiresAt) > this.currentDate().getTime()) return;
    const job = await this.readJobUnsafe(lease.jobId);
    if (job?.state === 'applying') {
      await this.persistApplyInterruptedJobUnsafe(job);
    } else if (job && ACTIVE_LEASE_STATES.has(job.state)) {
      await this.persistStaleJobUnsafe(job, 'lease_expired');
    }
    await unlinkIfExists(this.executionLeasePath);
    await syncDirectory(this.root);
  }

  private async persistStaleJobUnsafe(
    current: LocalDevelopmentJob,
    resultCode: 'lease_expired' | 'lease_released',
  ): Promise<LocalDevelopmentJob> {
    if (current.state === 'stale') return current;
    const timestamp = this.currentTimestamp();
    const stale = parseJob({
      ...current,
      revision: current.revision + 1,
      state: 'stale',
      updatedAt: timestamp,
      stateChangedAt: timestamp,
      resultCode,
    });
    await atomicJsonWrite(this.jobPath(current.id), stale, false);
    await syncDirectory(this.jobsDirectory);
    return stale;
  }

  private async persistApplyInterruptedJobUnsafe(
    current: LocalDevelopmentJob,
  ): Promise<LocalDevelopmentJob> {
    const timestamp = this.currentTimestamp();
    const conflict = parseJob({
      ...current,
      revision: current.revision + 1,
      state: 'conflict',
      updatedAt: timestamp,
      stateChangedAt: timestamp,
      resultCode: 'apply_interrupted',
    });
    await atomicJsonWrite(this.jobPath(current.id), conflict, false);
    await syncDirectory(this.jobsDirectory);
    return conflict;
  }

  private async readLeaseUnsafe(): Promise<LocalDevelopmentLease | undefined> {
    try {
      const parsed = localDevelopmentLeaseSchema.safeParse(
        parseJson(await readSmallFile(this.executionLeasePath)),
      );
      if (parsed.success) return parsed.data;
      await unlinkIfExists(this.executionLeasePath);
      return undefined;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async readJobUnsafe(id: string): Promise<LocalDevelopmentJob | undefined> {
    try {
      const metadata = await lstat(this.jobPath(id));
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new LocalDevelopmentJobStoreError('storage_failure');
      }
      return parseJob(parseJson(await readSmallFile(this.jobPath(id))));
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async listJobsUnsafe(): Promise<LocalDevelopmentJob[]> {
    const files = (await readdir(this.jobsDirectory))
      .filter((file) => file.endsWith('.json'))
      .filter((file) => jobIdSchema.safeParse(file.slice(0, -5)).success)
      .sort();
    const jobs: LocalDevelopmentJob[] = [];
    for (const file of files) {
      try {
        const id = file.slice(0, -5);
        const job = await this.readJobUnsafe(id);
        if (job) jobs.push(job);
      } catch {
        // A corrupt/tampered job cannot become executable and does not disclose its contents.
      }
    }
    return jobs.sort((a, b) => {
      const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return created !== 0 ? created : b.id.localeCompare(a.id);
    });
  }

  private currentDate(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new LocalDevelopmentJobStoreError('invalid_configuration');
    }
    return new Date(value.getTime());
  }

  private currentTimestamp(): string {
    return this.currentDate().toISOString();
  }

  private jobPath(id: string): string {
    return join(this.jobsDirectory, `${id}.json`);
  }
}

function parseJob(value: unknown): LocalDevelopmentJob {
  const parsed = localDevelopmentJobSchema.safeParse(value);
  if (!parsed.success) throw new LocalDevelopmentJobStoreError('invalid_input');
  return parsed.data;
}

function parseJobId(value: string): string {
  const parsed = jobIdSchema.safeParse(value);
  if (!parsed.success) throw new LocalDevelopmentJobStoreError('invalid_input');
  return parsed.data;
}

function parseTelegramId(value: number): number {
  const parsed = telegramIdSchema.safeParse(value);
  if (!parsed.success) throw new LocalDevelopmentJobStoreError('invalid_input');
  return parsed.data;
}

function verifiedArtifactPatchChanges(
  current: LocalDevelopmentJob,
  patch: LocalDevelopmentJobUpdate,
): boolean {
  if (patch.artifactHash !== undefined) {
    const nextHash = patch.artifactHash === null ? undefined : patch.artifactHash;
    if (nextHash !== current.artifactHash) return true;
  }
  if (
    patch.artifactFiles !== undefined &&
    JSON.stringify(patch.artifactFiles) !== JSON.stringify(current.artifactFiles)
  ) {
    return true;
  }
  return (
    patch.checks !== undefined && JSON.stringify(patch.checks) !== JSON.stringify(current.checks)
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function hasOnlySafeGoalCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 32 && character !== '\n' && character !== '\t') || code === 127) return false;
  }
  return true;
}

function looksLikeRawSecret(value: string): boolean {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:ghp|github_pat|sk_live|sk_test)_[a-z0-9_-]{16,}\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
    /\b\d{6,}:[a-zA-Z0-9_-]{20,}\b/,
    /\b(?:password|passwd|api[_ -]?key|secret|auth[_ -]?token|sessionid|cookie)\s*[:=]\s*\S{8,}/i,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

function isSafeArtifactPath(value: string): boolean {
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const segments = value.split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || !/^[a-zA-Z0-9._@+-]+$/.test(segment),
    )
  ) {
    return false;
  }
  const normalized = value.toLowerCase();
  const basenameLower = segments.at(-1)?.toLowerCase() ?? '';
  if (normalized === '.git' || normalized.startsWith('.git/')) return false;
  return !(
    /^\.env(?:\.|$)/.test(basenameLower) ||
    /^(?:id_rsa|id_ed25519|credentials|cookies?|secrets?)(?:\.|$)/.test(basenameLower) ||
    /\.(?:pem|key|p12|pfx)$/.test(basenameLower) ||
    basenameLower === '.npmrc' ||
    basenameLower === '.netrc'
  );
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: LocalDevelopmentJobStoreErrorCode,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LocalDevelopmentJobStoreError(code);
  }
  return value;
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathInside(first, second) || isPathInside(second, first);
}

function isPathInside(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function canonicalProspectivePath(target: string): Promise<string> {
  let cursor = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...suffix);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function atomicJsonWrite(target: string, value: unknown, createOnly: boolean): Promise<void> {
  const directory = dirname(target);
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (createOnly) {
      await link(temporary, target);
      await unlink(temporary);
    } else {
      await rename(temporary, target);
    }
    await chmod(target, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function readSmallFile(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_JOB_FILE_BYTES) {
    throw new LocalDevelopmentJobStoreError('storage_failure');
  }
  return readFile(path, 'utf8');
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function safeStoreError(error: unknown): LocalDevelopmentJobStoreError {
  return error instanceof LocalDevelopmentJobStoreError
    ? error
    : new LocalDevelopmentJobStoreError('storage_failure');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
