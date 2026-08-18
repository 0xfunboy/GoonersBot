import { resolve } from 'node:path';
import { createAbortScope } from '../utils/abort.js';
import { childLogger } from '../utils/logger.js';
import { containsSensitive, redactSecrets } from '../utils/secrets.js';
import {
  LocalDevelopmentModel,
  LocalDevelopmentModelError,
  type LocalDevelopmentCandidateFile,
  type LocalDevelopmentDraft,
  type LocalDevelopmentModelErrorCode,
} from './localDevelopmentModel.js';
import {
  LocalDevelopmentJobStore,
  LocalDevelopmentJobStoreError,
  type LocalDevelopmentCheck as StoredCheck,
  type LocalDevelopmentJob as StoredJob,
} from './localDevelopmentJobs.js';
import { LocalDevelopmentSources } from './localDevelopmentSources.js';
import {
  LocalDevelopmentFormattingError,
  LocalDevelopmentPolicyError,
  LocalDevelopmentWorkspace,
  type LocalDevelopmentApplyResult,
  type LocalDevelopmentDiffResult,
  type LocalDevelopmentVerificationResult,
} from './localDevelopmentWorkspace.js';

const log = childLogger('local-development');
const JOB_REFERENCE_RE = /^[a-f0-9-]{8,36}$/i;
const HASH_PREFIX_RE = /^[a-f0-9]{12}$/i;

export interface LocalDevelopmentServiceConfig {
  enabled: boolean;
  repositoryPath: string;
  storePath: string;
  adminTelegramIds: readonly number[];
  plannerModel: string;
  coderModel: string;
  reviewModel: string;
  maxAttempts: number;
  jobTimeoutMs: number;
  pnpmBin?: string;
  nodeBin?: string;
  bubblewrapBin?: string;
}

export interface LocalDevelopmentActor {
  actorTelegramId: number;
  chatId: number;
  isGroup: boolean;
}

export type LocalDevelopmentServiceErrorCode =
  | 'disabled'
  | 'private_chat_required'
  | 'unauthorized_actor'
  | 'invalid_goal'
  | 'sensitive_goal'
  | 'repository_dirty'
  | 'job_not_found'
  | 'job_not_ready'
  | 'invalid_hash'
  | 'worker_busy'
  | 'operation_failed';

const PUBLIC_ERRORS: Record<LocalDevelopmentServiceErrorCode, string> = {
  disabled: 'Lo sviluppo locale tramite /learn è disattivato.',
  private_chat_required:
    'Lo sviluppo di codice con /learn è consentito soltanto nella chat privata.',
  unauthorized_actor: 'Questo account Telegram non è autorizzato allo sviluppo locale.',
  invalid_goal:
    'Descrivi la modifica in almeno 8 caratteri, senza allegare testo o comandi estranei.',
  sensitive_goal: 'La richiesta contiene dati sensibili: rimuovili prima di avviare lo sviluppo.',
  repository_dirty:
    'Il repository live contiene modifiche non ancora archiviate; nessun job è stato creato.',
  job_not_found: 'Job /learn non trovato.',
  job_not_ready: 'Il job non è pronto per essere applicato.',
  invalid_hash: 'Serve il prefisso SHA-256 di 12 caratteri mostrato da /learn status.',
  worker_busy: 'Il worker /learn è già occupato; il job resta in coda.',
  operation_failed: 'Operazione /learn non riuscita in sicurezza.',
};

export class LocalDevelopmentServiceError extends Error {
  constructor(readonly code: LocalDevelopmentServiceErrorCode) {
    super(PUBLIC_ERRORS[code]);
    this.name = 'LocalDevelopmentServiceError';
  }
}

export interface LocalDevelopmentServiceDependencies {
  model: LocalDevelopmentModel;
  jobs: LocalDevelopmentJobStore;
  sources: LocalDevelopmentSources;
  workspace: LocalDevelopmentWorkspace;
}

/**
 * Durable orchestration for reviewed /learn code jobs. GemRouter only receives an allowlisted source
 * capsule; generated code is policy-checked and executed in the workspace's no-network bwrap. This
 * service never deploys or restarts the bot.
 */
export class LocalDevelopmentService {
  readonly enabled: boolean;
  private readonly admins: ReadonlySet<number>;
  private drain: Promise<void> | undefined;
  private drainRequested = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly config: LocalDevelopmentServiceConfig,
    private readonly dependencies: LocalDevelopmentServiceDependencies,
  ) {
    this.enabled = config.enabled;
    this.admins = new Set(config.adminTelegramIds);
  }

  static create(
    config: LocalDevelopmentServiceConfig,
    llm: ConstructorParameters<typeof LocalDevelopmentModel>[0],
  ): LocalDevelopmentService {
    const repositoryPath = resolve(config.repositoryPath);
    const storePath = resolve(config.storePath);
    const workspace = new LocalDevelopmentWorkspace({
      repoRoot: repositoryPath,
      workspaceRoot: resolve(storePath, 'workspace'),
      ...(config.pnpmBin ? { pnpmBin: config.pnpmBin } : {}),
      ...(config.nodeBin ? { nodeBin: config.nodeBin } : {}),
      ...(config.bubblewrapBin ? { bubblewrapBin: config.bubblewrapBin } : {}),
    });
    return new LocalDevelopmentService(config, {
      model: new LocalDevelopmentModel(llm),
      jobs: new LocalDevelopmentJobStore({
        root: resolve(storePath, 'state'),
        repositoryRoot: repositoryPath,
        leaseTtlMs: Math.min(60 * 60_000, config.jobTimeoutMs + 60_000),
      }),
      sources: new LocalDevelopmentSources(repositoryPath),
      workspace,
    });
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return;
    await this.dependencies.jobs.initialize();
    this.triggerDrain();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.drainRequested = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    for (const controller of this.activeControllers.values()) {
      controller.abort(new Error('local development worker is shutting down'));
    }
    await this.waitForIdle();
  }

  /** Primarily for graceful shutdown/tests; ordinary Telegram requests never wait for the worker. */
  async waitForIdle(): Promise<void> {
    while (this.drain) await this.drain;
  }

  isAuthorized(actor: LocalDevelopmentActor): boolean {
    return (
      this.enabled &&
      !actor.isGroup &&
      actor.chatId === actor.actorTelegramId &&
      this.admins.has(actor.actorTelegramId)
    );
  }

  async enqueue(actor: LocalDevelopmentActor, goalInput: string): Promise<StoredJob> {
    this.assertActor(actor);
    const goal = goalInput.trim();
    if (goal.length < 8 || goal.length > 2_000 || hasControlCharacters(goal)) {
      throw new LocalDevelopmentServiceError('invalid_goal');
    }
    if (containsSensitive(goal)) throw new LocalDevelopmentServiceError('sensitive_goal');
    const repository = await this.dependencies.workspace.inspectRepository();
    if (!repository.clean) throw new LocalDevelopmentServiceError('repository_dirty');
    const job = await this.dependencies.jobs.create({
      actorTelegramId: actor.actorTelegramId,
      privateChatId: actor.chatId,
      goal,
      baseSha: repository.head,
    });
    this.triggerDrain();
    return job;
  }

  async status(actor: LocalDevelopmentActor, reference?: string): Promise<StoredJob | null> {
    this.assertActor(actor);
    const job = reference
      ? this.resolveJob(actor.actorTelegramId, reference)
      : this.dependencies.jobs.latestForActor(actor.actorTelegramId);
    const resolved = await job;
    if (resolved?.state === 'stale') this.triggerDrain();
    return resolved;
  }

  /**
   * Jobs that have reached a terminal state.
   *
   * Exposed for the completion notifier: a build that takes minutes and then finishes silently
   * forces the admin to poll `/learn status`, which is the one part of this command that made it
   * feel broken rather than slow.
   */
  async listTerminal(limit = 50): Promise<StoredJob[]> {
    if (!this.config.enabled) return [];
    return this.dependencies.jobs.list({
      states: ['ready', 'failed', 'conflict', 'applied', 'stale'],
      limit,
    });
  }

  async diff(
    actor: LocalDevelopmentActor,
    reference: string,
  ): Promise<{ job: StoredJob; artifact: LocalDevelopmentDiffResult }> {
    this.assertActor(actor);
    const job = await this.requireJob(actor.actorTelegramId, reference);
    if (!['policy_check', 'verifying', 'ready', 'applying'].includes(job.state)) {
      throw new LocalDevelopmentServiceError('job_not_ready');
    }
    const artifact = await this.dependencies.workspace.diff(job.id);
    return { job, artifact };
  }

  async cancel(actor: LocalDevelopmentActor, reference: string): Promise<StoredJob> {
    this.assertActor(actor);
    const job = await this.requireJob(actor.actorTelegramId, reference);
    const cancelled = await this.dependencies.jobs.cancel(job.id, actor.actorTelegramId);
    if (!cancelled) throw new LocalDevelopmentServiceError('job_not_found');
    this.activeControllers
      .get(job.id)
      ?.abort(new Error('local development job cancelled by its actor'));
    return cancelled;
  }

  async apply(
    actor: LocalDevelopmentActor,
    reference: string,
    hashPrefix: string,
  ): Promise<{ job: StoredJob; result: LocalDevelopmentApplyResult }> {
    this.assertActor(actor);
    if (!HASH_PREFIX_RE.test(hashPrefix)) {
      throw new LocalDevelopmentServiceError('invalid_hash');
    }
    const job = await this.requireJob(actor.actorTelegramId, reference);
    if (job.state !== 'ready' || !job.artifactHash) {
      throw new LocalDevelopmentServiceError('job_not_ready');
    }
    if (job.artifactHash.slice(0, 12) !== hashPrefix.toLowerCase()) {
      throw new LocalDevelopmentServiceError('invalid_hash');
    }
    const lease = await this.dependencies.jobs.tryAcquireLease(
      job.id,
      Math.min(60 * 60_000, this.config.jobTimeoutMs + 60_000),
    );
    if (!lease.acquired) {
      throw new LocalDevelopmentServiceError(
        lease.reason === 'busy' ? 'worker_busy' : 'job_not_ready',
      );
    }
    try {
      const applying = await this.dependencies.jobs.update(
        job.id,
        { expectedRevision: job.revision, state: 'applying' },
        lease.token,
      );
      const result = await this.dependencies.workspace.apply(job.id, hashPrefix.toLowerCase());
      if (result.status === 'applied') {
        const applied = await this.dependencies.jobs.update(
          job.id,
          { expectedRevision: applying.revision, state: 'applied', resultCode: null },
          lease.token,
        );
        return { job: applied, result };
      }
      const conflicted = await this.dependencies.jobs.update(
        job.id,
        {
          expectedRevision: applying.revision,
          state: 'conflict',
          resultCode: result.status === 'conflict' ? 'repository_changed' : 'apply_failed',
        },
        lease.token,
      );
      return { job: conflicted, result };
    } finally {
      await this.dependencies.jobs.release(job.id, lease.token).catch(() => false);
      this.triggerDrain();
    }
  }

  private assertActor(actor: LocalDevelopmentActor): void {
    if (!this.enabled) throw new LocalDevelopmentServiceError('disabled');
    if (actor.isGroup || actor.chatId !== actor.actorTelegramId) {
      throw new LocalDevelopmentServiceError('private_chat_required');
    }
    if (!this.admins.has(actor.actorTelegramId)) {
      throw new LocalDevelopmentServiceError('unauthorized_actor');
    }
  }

  private triggerDrain(): void {
    if (!this.enabled || this.stopping) return;
    this.drainRequested = true;
    if (this.drain) return;
    this.drain = this.drainRequestedQueue()
      .catch((error: unknown) => {
        log.warn({ error: safeErrorCode(error) }, 'local development queue drain failed');
        this.scheduleRetry();
      })
      .finally(() => {
        this.drain = undefined;
        if (this.drainRequested && !this.stopping) this.triggerDrain();
      });
  }

  private async drainRequestedQueue(): Promise<void> {
    while (this.drainRequested) {
      this.drainRequested = false;
      await this.drainQueue();
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.enabled && !this.stopping) {
      const queued = await this.dependencies.jobs.list({
        states: ['queued', 'stale'],
        limit: 1,
      });
      const job = queued[0];
      if (!job) {
        const active = await this.dependencies.jobs.list({
          states: ['generating', 'policy_check', 'verifying', 'applying'],
          limit: 1,
        });
        if (active.length > 0) this.scheduleRetry();
        return;
      }
      const lease = await this.dependencies.jobs.tryAcquireLease(
        job.id,
        Math.min(60 * 60_000, this.config.jobTimeoutMs + 60_000),
      );
      if (!lease.acquired) {
        if (lease.reason === 'busy') this.scheduleRetry();
        return;
      }
      await this.runJob(job, lease.token).catch((error: unknown) => {
        log.warn({ jobId: job.id, error: safeErrorCode(error) }, 'local development job failed');
      });
      await this.dependencies.jobs.release(job.id, lease.token).catch(() => false);
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopping) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.triggerDrain();
    }, 5_000);
    this.retryTimer.unref?.();
  }

  private async runJob(jobInput: StoredJob, leaseToken: string): Promise<void> {
    const controller = new AbortController();
    const scope = createAbortScope(
      this.config.jobTimeoutMs,
      controller.signal,
      'local development job',
    );
    this.activeControllers.set(jobInput.id, controller);
    let job = jobInput;
    try {
      job = await this.dependencies.jobs.update(
        job.id,
        { state: 'generating', resultCode: null },
        leaseToken,
      );
      if (jobInput.state === 'stale') {
        await this.dependencies.workspace.resetStaleJob(job.id, job.baseSha);
      }
      const workspaceJob = await this.dependencies.workspace.createJob({
        jobId: job.id,
        baseSha: job.baseSha,
      });
      const pinnedSources = this.dependencies.sources.scoped(workspaceJob.worktreePath);
      const catalog = await pinnedSources.catalog();
      const selection = await this.retryModelPhase('selection_failed', () =>
        this.dependencies.model.selectFiles({
          goal: job.goal,
          catalog,
          model: this.config.plannerModel,
          signal: scope.signal,
        }),
      );
      let candidates = await pinnedSources.candidates(selection);
      let feedback: string[] = [];

      for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
        const proposal = await this.retryModelPhase('generation_failed', () =>
          this.dependencies.model.propose({
            goal: job.goal,
            files: candidates,
            feedback,
            model: this.config.coderModel,
            signal: scope.signal,
          }),
        );
        try {
          await this.writeExactProposal(job.id, proposal, candidates, attempt > 1, scope.signal);
        } catch (error) {
          if (!(error instanceof LocalDevelopmentFormattingError)) throw error;
          feedback = [redactSecrets(error.feedback).slice(-300)];
          if (attempt < this.config.maxAttempts) {
            candidates = proposal.files.map((file) => ({
              path: file.path,
              kind: 'regular' as const,
              content: file.content,
            }));
            continue;
          }
          await this.failJob(job.id, leaseToken, 'formatting_failed');
          return;
        }
        job = await this.dependencies.jobs.update(
          job.id,
          { state: job.state === 'generating' ? 'policy_check' : job.state },
          leaseToken,
        );

        const artifact = await this.dependencies.workspace.diff(job.id);
        const review = await this.retryModelPhase('review_failed', () =>
          this.dependencies.model.review({
            goal: job.goal,
            diff: artifact.text,
            model: this.config.reviewModel,
            signal: scope.signal,
          }),
        );
        if (review.verdict !== 'approved') {
          feedback = review.issues.map((issue) => `${issue.path ?? 'diff'}: ${issue.message}`);
          if (attempt < this.config.maxAttempts) {
            candidates = await this.retryCandidates(job.id, artifact.files);
            continue;
          }
          await this.failJob(job.id, leaseToken, 'review_rejected');
          return;
        }

        if (job.state !== 'verifying') {
          job = await this.dependencies.jobs.update(job.id, { state: 'verifying' }, leaseToken);
        }
        const verified = await this.dependencies.workspace.verify(job.id, scope.signal);
        if (verified.ready && verified.artifactHash && verified.artifactFiles?.length) {
          const checks = storedChecks(verified, true);
          await this.dependencies.jobs.update(
            job.id,
            {
              state: 'ready',
              artifactHash: verified.artifactHash,
              artifactFiles: verified.artifactFiles,
              checks,
              resultCode: null,
            },
            leaseToken,
          );
          return;
        }
        feedback = verificationFeedback(verified);
        if (attempt < this.config.maxAttempts) {
          const workspaceJob = await this.dependencies.workspace.getStatus(job.id);
          candidates = await this.retryCandidates(job.id, workspaceJob.changedFiles);
          continue;
        }
        await this.dependencies.jobs.update(
          job.id,
          {
            state: 'failed',
            checks: storedChecks(verified, true),
            resultCode:
              verified.status === 'manual_review'
                ? 'manual_review_required'
                : 'verification_failed',
          },
          leaseToken,
        );
        return;
      }
    } catch (error) {
      const current = await this.dependencies.jobs.get(job.id).catch(() => null);
      if (
        !this.stopping &&
        current &&
        !['failed', 'conflict', 'applied', 'cancelled'].includes(current.state)
      ) {
        await this.failJob(
          job.id,
          leaseToken,
          scope.timedOut() ? 'job_timed_out' : safeResultCode(error),
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      if (this.activeControllers.get(job.id) === controller) {
        this.activeControllers.delete(job.id);
      }
      scope.dispose();
    }
  }

  private async writeExactProposal(
    jobId: string,
    draft: LocalDevelopmentDraft,
    candidates: readonly LocalDevelopmentCandidateFile[],
    retry: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (retry) {
      const expected = [...new Set(candidates.map((candidate) => candidate.path))].sort();
      const produced = [...new Set(draft.files.map((file) => file.path))].sort();
      if (JSON.stringify(expected) !== JSON.stringify(produced)) {
        throw new LocalDevelopmentPolicyError('repair proposal changed its verified file scope');
      }
    }
    await this.dependencies.workspace.writeProposal(
      jobId,
      draft.files.map((file) => ({ path: file.path, content: file.content })),
      signal,
    );
  }

  private async retryModelPhase<T>(
    code: LocalDevelopmentModelErrorCode,
    operation: () => Promise<T>,
  ): Promise<T> {
    let lastError: LocalDevelopmentModelError | undefined;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof LocalDevelopmentModelError) || error.code !== code) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new LocalDevelopmentModelError(code, 'Model phase failed safely.');
  }

  private async retryCandidates(
    jobId: string,
    paths: readonly string[],
  ): Promise<LocalDevelopmentCandidateFile[]> {
    return Promise.all(
      paths.map(async (path) => ({
        path,
        kind: 'regular' as const,
        content: await this.dependencies.workspace.readWorkspaceFile(jobId, path),
      })),
    );
  }

  private async failJob(jobId: string, leaseToken: string, resultCode: string): Promise<void> {
    await this.dependencies.jobs.update(
      jobId,
      { state: 'failed', resultCode: normalizeResultCode(resultCode) },
      leaseToken,
    );
  }

  private async requireJob(actorTelegramId: number, reference: string): Promise<StoredJob> {
    const job = await this.resolveJob(actorTelegramId, reference);
    if (!job) throw new LocalDevelopmentServiceError('job_not_found');
    return job;
  }

  private async resolveJob(actorTelegramId: number, reference: string): Promise<StoredJob | null> {
    const normalized = reference.trim().toLowerCase();
    if (!JOB_REFERENCE_RE.test(normalized)) {
      throw new LocalDevelopmentServiceError('job_not_found');
    }
    const jobs = await this.dependencies.jobs.list({ actorTelegramId, limit: 100 });
    const matches = jobs.filter((job) => job.id.startsWith(normalized));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }
}

function storedChecks(
  result: LocalDevelopmentVerificationResult,
  reviewPassed: boolean,
): StoredCheck[] {
  const timestamp = new Date().toISOString();
  const checks: StoredCheck[] = result.checks.map((check) => ({
    id: check.name,
    status: check.status,
    code: check.status === 'passed' ? 'ok' : 'check_failed',
    checkedAt: timestamp,
  }));
  checks.push({
    id: 'independent_review',
    status: reviewPassed ? 'passed' : 'failed',
    code: reviewPassed ? 'approved' : 'review_failed',
    checkedAt: timestamp,
  });
  return checks;
}

function verificationFeedback(result: LocalDevelopmentVerificationResult): string[] {
  const values = [
    result.diagnostics ?? '',
    ...result.checks
      .filter((check) => check.status === 'failed')
      .map((check) => `${check.name}: ${check.diagnostic ?? 'failed'}`),
  ];
  return values
    .map((value) => redactSecrets(value).slice(-300))
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeResultCode(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return /^[a-z][a-z0-9_.-]{1,63}$/.test(normalized) ? normalized : 'operation_failed';
}

function safeResultCode(error: unknown): string {
  if (error instanceof LocalDevelopmentServiceError) return error.code;
  if (error instanceof LocalDevelopmentJobStoreError) return `store_${error.code}`;
  if (error instanceof LocalDevelopmentPolicyError) return 'policy_rejected';
  if (error instanceof LocalDevelopmentModelError) return `model_${error.code}`;
  return 'operation_failed';
}

function safeErrorCode(error: unknown): string {
  return normalizeResultCode(safeResultCode(error));
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
