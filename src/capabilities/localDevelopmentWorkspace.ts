import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { containsSecret, redactSecrets } from '../utils/secrets.js';

const JOB_ID_RE = /^[a-z0-9][a-z0-9_-]{5,63}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const APPROVAL_PREFIX_LENGTH = 12;
const METADATA_VERSION = 1 as const;
// RLIMIT_NPROC is counted across every thread owned by the Unix user, not just this child tree.
// Keep bounded headroom above the bot/browser baseline so bubblewrap can still create its namespace.
const SANDBOX_UID_TASK_LIMIT = 1_024;
// RLIMIT_AS measures virtual address space. V8/Wasm reserves tens of GiB without committing
// equivalent RAM; resident JS heaps remain separately capped through NODE_OPTIONS below.
const SANDBOX_VIRTUAL_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024 * 1024;
const SANDBOX_NODE_HEAP_LIMIT_MIB = 1_024;
const SANDBOX_CGROUP_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const SANDBOX_CGROUP_TASK_LIMIT = 128;
const SANDBOX_CGROUP_CPU_QUOTA = '200%';
const SANDBOX_HOSTS = '127.0.0.1 localhost\n::1 localhost\n';
const SANDBOX_NSSWITCH = 'hosts: files\n';
const JOB_STATUSES = new Set<LocalDevelopmentJobStatus>([
  'workspace_ready',
  'proposal_written',
  'verifying',
  'manual_review',
  'verification_failed',
  'ready',
  'applying',
  'apply_failed',
  'applied',
]);

const DEFAULT_LIMITS: LocalDevelopmentLimits = {
  maxFiles: 10,
  maxFileBytes: 96 * 1024,
  maxTotalBytes: 320 * 1024,
  maxFileLines: 1_200,
  maxTotalLines: 3_000,
  maxChangedLines: 3_500,
  maxDiagnosticBytes: 24 * 1024,
  maxPatchBytes: 512 * 1024,
};

const DENIED_PATHS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^src\/config(?:\/|$)/i, reason: 'configuration files are protected' },
  { pattern: /^src\/capabilities\/forge\.ts$/i, reason: 'the capability forge is protected' },
  {
    pattern: /^src\/capabilities\/localDevelopment[^/]*\.ts$/i,
    reason: 'the local development control plane cannot modify itself',
  },
  { pattern: /^src\/main\.ts$/i, reason: 'the process entrypoint is protected' },
  {
    pattern:
      /^src\/(?:services\/(?:access|permissions)|telegram\/handlers\/commands\/(?:access|capabilities)|utils\/secrets|providers\/socialClients\/policy)\.ts$/i,
    reason: 'authorization, privacy and policy boundaries are protected',
  },
  {
    pattern: /(?:^|\/)(?:deploy|deployer|deployment)(?:[./_-]|$)/i,
    reason: 'deployers are protected',
  },
  {
    pattern: /(?:^|\/)(?:package|pnpm-lock|tsconfig|eslint|prettier|vitest)\b/i,
    reason: 'toolchain configuration is protected',
  },
];

const DANGEROUS_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  {
    code: 'process_execution',
    pattern:
      /(?:node:)?(?:child_process|cluster|worker_threads)|\b(?:execFile|execSync|spawnSync|fork)\s*\(|\bspawn\s*\(|\bshell\s*:|\b(?:execa|zx)\b/i,
  },
  {
    code: 'dynamic_evaluation',
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:run|compile)/i,
  },
  {
    code: 'network_access',
    pattern:
      /(?:node:)?(?:http|https|net|tls|dgram|dns)(?:['"]|\/)|\b(?:fetch|WebSocket|EventSource)\s*\(|\b(?:undici|axios|superagent)\b/i,
  },
  {
    code: 'filesystem_access',
    pattern:
      /(?:node:)?fs(?:\/promises)?(?:['"]|\/)|\b(?:readFile|writeFile|appendFile|createReadStream|createWriteStream|opendir|readdir|unlink|rename|rm)\s*\(|\b(?:Deno|Bun)\.(?:open|read|write|file)/i,
  },
  {
    code: 'secret_or_environment_access',
    pattern:
      /\bprocess\s*(?:\.\s*env|\[\s*['"]env['"]\s*\])|\bdotenv\b|(?:^|[/'"])(?:\.env|etc|proc)(?:[/'"]|$)|\b(?:password|passwd|credential|secret|auth[_-]?token|api[_-]?key|private[_-]?key)\b/i,
  },
  {
    code: 'dynamic_module_loading',
    pattern: /\b(?:require|import)\s*\(|\bmodule\s*\.\s*(?:constructor|require)\b/i,
  },
  {
    code: 'authorization_or_permissions',
    pattern:
      /\b(?:auth|authorize|authorization|permission|permissions|privilege|role|admin|access|approval|allowlist|denylist|blocklist|ban|banned|privacy|redact|redaction)\b/i,
  },
  {
    code: 'permission_change',
    pattern: /\b(?:chmod|chown|fchmod|fchown|setuid|setgid|umask)\s*\(/i,
  },
  {
    code: 'deployment_control',
    pattern:
      /\b(?:systemctl|service|docker|podman|kubectl|reboot|shutdown)\b|\bprocess\.(?:kill|exit)\s*\(/i,
  },
];

const CHECKS: ReadonlyArray<{
  name: LocalDevelopmentCheckName;
  args: (files: string[]) => string[];
  timeoutMs: number;
}> = [
  {
    name: 'prettier',
    args: (files) => ['exec', 'prettier', '--check', ...files],
    timeoutMs: 90_000,
  },
  { name: 'typecheck', args: () => ['typecheck'], timeoutMs: 240_000 },
  { name: 'lint', args: () => ['lint'], timeoutMs: 240_000 },
  {
    name: 'test',
    args: () => ['exec', 'vitest', 'run', '--maxWorkers=2', '--minWorkers=1', '--no-cache'],
    timeoutMs: 900_000,
  },
  { name: 'build', args: () => ['build'], timeoutMs: 300_000 },
];

export type LocalDevelopmentJobStatus =
  | 'workspace_ready'
  | 'proposal_written'
  | 'verifying'
  | 'manual_review'
  | 'verification_failed'
  | 'ready'
  | 'applying'
  | 'apply_failed'
  | 'applied';

export type LocalDevelopmentCheckName = 'prettier' | 'typecheck' | 'lint' | 'test' | 'build';

export interface LocalDevelopmentLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFileLines: number;
  maxTotalLines: number;
  maxChangedLines: number;
  maxDiagnosticBytes: number;
  maxPatchBytes: number;
}

export interface LocalDevelopmentProposedFile {
  path: string;
  content: string;
  /** Only ordinary, non-executable files are accepted. Omit this for the safe default. */
  mode?: number;
}

export type LocalDevelopmentProposal =
  | { files: LocalDevelopmentProposedFile[] }
  | LocalDevelopmentProposedFile[]
  | Record<string, string>;

export interface LocalDevelopmentCheck {
  name: LocalDevelopmentCheckName;
  status: 'passed' | 'failed';
  exitCode: number | null;
  diagnostic?: string;
}

export interface LocalDevelopmentJob {
  version: typeof METADATA_VERSION;
  id: string;
  baseHead: string;
  worktreePath: string;
  status: LocalDevelopmentJobStatus;
  createdAt: string;
  updatedAt: string;
  changedFiles: string[];
  proposedFileHashes: Record<string, string>;
  manualReviewReasons: string[];
  checks: LocalDevelopmentCheck[];
  patchPath?: string;
  patchSha256?: string;
  approvalHash?: string;
  verifiedCommit?: string;
  appliedCommit?: string;
  diagnostic?: string;
}

export interface LocalDevelopmentRepositoryInspection {
  head: string;
  clean: boolean;
  changes: string[];
}

export interface LocalDevelopmentVerificationResult {
  ready: boolean;
  status: LocalDevelopmentJobStatus;
  checks: LocalDevelopmentCheck[];
  diagnostics?: string;
  artifactHash?: string;
  artifactFiles?: string[];
}

export interface LocalDevelopmentDiffResult {
  text: string;
  hash: string;
  files: string[];
}

export interface LocalDevelopmentApplyResult {
  status: 'applied' | 'conflict' | 'failed';
  commitSha?: string;
  diagnostic?: string;
}

export interface LocalDevelopmentProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface LocalDevelopmentProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type LocalDevelopmentProcessRunner = (
  request: LocalDevelopmentProcessRequest,
) => Promise<LocalDevelopmentProcessResult>;

export interface LocalDevelopmentWorkspaceOptions {
  repoRoot: string;
  workspaceRoot: string;
  gitBin?: string;
  pnpmBin?: string;
  nodeBin?: string;
  bubblewrapBin?: string;
  resourceLimitBin?: string;
  resourceGroupBin?: string;
  nodeModulesPath?: string;
  limits?: Partial<LocalDevelopmentLimits>;
  processRunner?: LocalDevelopmentProcessRunner;
  now?: () => Date;
}

export class LocalDevelopmentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalDevelopmentPolicyError';
  }
}

export class LocalDevelopmentFormattingError extends LocalDevelopmentPolicyError {
  readonly feedback: string;

  constructor(feedback: string) {
    super(`trusted TypeScript formatting failed${feedback ? `: ${feedback}` : ''}`);
    this.name = 'LocalDevelopmentFormattingError';
    this.feedback = feedback || 'Prettier could not parse or format the generated TypeScript.';
  }
}

/**
 * A deliberately narrow workspace for model-authored local changes.
 *
 * It never gives a model access to the live checkout. Proposed text is policy-checked before it is
 * written to a detached, pinned worktree; verification runs without network/home access inside
 * bubblewrap; publication requires an explicit patch-hash approval and does not deploy or restart.
 */
export class LocalDevelopmentWorkspace {
  readonly repoRoot: string;
  readonly workspaceRoot: string;
  readonly limits: LocalDevelopmentLimits;

  private readonly gitBin: string;
  private readonly pnpmBin: string;
  private readonly nodeBin: string;
  private readonly bubblewrapBin: string;
  private readonly resourceLimitBin: string;
  private readonly resourceGroupBin: string;
  private readonly nodeModulesPath: string;
  private readonly runner: LocalDevelopmentProcessRunner;
  private readonly now: () => Date;

  constructor(options: LocalDevelopmentWorkspaceOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.gitBin = options.gitBin ?? '/usr/bin/git';
    this.pnpmBin = options.pnpmBin ?? 'pnpm';
    this.nodeBin = options.nodeBin ?? process.execPath;
    this.bubblewrapBin = options.bubblewrapBin ?? '/usr/bin/bwrap';
    this.resourceLimitBin = options.resourceLimitBin ?? '/usr/bin/prlimit';
    this.resourceGroupBin = options.resourceGroupBin ?? '/usr/bin/systemd-run';
    this.nodeModulesPath = resolve(options.nodeModulesPath ?? join(this.repoRoot, 'node_modules'));
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.runner = options.processRunner ?? runBoundedProcess;
    this.now = options.now ?? (() => new Date());
    this.validateLimits();
  }

  async inspectRepository(): Promise<LocalDevelopmentRepositoryInspection> {
    await this.ensureLayout();
    const head = (await this.git(this.repoRoot, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    if (!SHA_RE.test(head)) throw new LocalDevelopmentPolicyError('repository HEAD is invalid');
    const raw = (
      await this.git(this.repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    ).stdout;
    const changes = parseStatus(raw)
      .map((entry) => entry.path)
      .slice(0, 50);
    return { head, clean: changes.length === 0, changes };
  }

  async currentHead(): Promise<string> {
    const inspection = await this.inspectRepository();
    if (!inspection.clean) {
      throw new LocalDevelopmentPolicyError('the live repository must be clean');
    }
    return inspection.head;
  }

  async createJob(
    input: string | { jobId: string; baseSha: string },
    baseSha?: string,
    request?: string,
  ): Promise<LocalDevelopmentJob> {
    const jobId = typeof input === 'string' ? input : input.jobId;
    const pinnedBase = typeof input === 'string' ? baseSha : input.baseSha;
    void request; // Requests belong to the caller's job store and are intentionally not duplicated.
    this.assertJobId(jobId);
    return this.withLock(`job-${jobId}`, async () => {
      await this.ensureLayout();
      if (await exists(this.metadataPath(jobId))) {
        throw new LocalDevelopmentPolicyError(`job ${jobId} already exists`);
      }
      const head = await this.currentHead();
      if (pinnedBase !== undefined && pinnedBase !== head) {
        throw new LocalDevelopmentPolicyError('job base does not match the clean repository HEAD');
      }
      const worktreePath = this.worktreePath(jobId);
      if (await exists(worktreePath)) {
        throw new LocalDevelopmentPolicyError('job worktree path already exists');
      }
      await this.git(this.repoRoot, ['worktree', 'add', '--detach', worktreePath, head], 120_000);
      const timestamp = this.now().toISOString();
      const job: LocalDevelopmentJob = {
        version: METADATA_VERSION,
        id: jobId,
        baseHead: head,
        worktreePath,
        status: 'workspace_ready',
        createdAt: timestamp,
        updatedAt: timestamp,
        changedFiles: [],
        proposedFileHashes: {},
        manualReviewReasons: [],
        checks: [],
      };
      await this.persist(job);
      return cloneJob(job);
    });
  }

  async status(jobId: string): Promise<LocalDevelopmentJob> {
    return this.getStatus(jobId);
  }

  async getStatus(jobId: string): Promise<LocalDevelopmentJob> {
    this.assertJobId(jobId);
    await this.ensureLayout();
    return cloneJob(await this.load(jobId));
  }

  /**
   * Remove a stale generated workspace so the caller's durable job can be regenerated from the same
   * pinned base. This deliberately cannot recover/reset an apply attempt and never changes the live
   * checkout, index, HEAD or branch refs.
   */
  async resetStaleJob(jobId: string, expectedBaseSha: string): Promise<void> {
    this.assertJobId(jobId);
    if (!SHA_RE.test(expectedBaseSha)) {
      throw new LocalDevelopmentPolicyError('stale reset requires an exact base SHA');
    }
    await this.withLock(`job-${jobId}`, async () => {
      const metadata = this.metadataPath(jobId);
      const worktreePath = this.worktreePath(jobId);
      const artifactPath = this.patchPath(jobId);
      if (!(await exists(metadata))) {
        if ((await exists(worktreePath)) || (await exists(artifactPath))) {
          throw new LocalDevelopmentPolicyError(
            'stale job has workspace data without valid private metadata',
          );
        }
        // A process may lose its lease after fencing the durable job but before creating any
        // workspace state. There is nothing destructive to reset in that exact case.
        return;
      }
      const job = await this.load(jobId);
      if (job.baseHead !== expectedBaseSha) {
        throw new LocalDevelopmentPolicyError('stale reset base does not match job metadata');
      }
      if (['applying', 'apply_failed', 'applied'].includes(job.status)) {
        throw new LocalDevelopmentPolicyError('an apply attempt cannot be reset as a stale job');
      }

      const worktree = await this.validateResettableWorktree(job);
      const artifact = await this.validateResettableArtifact(job);
      const mainBefore = await this.inspectRepository();

      // `git worktree remove` removes this exact registered worktree and its corresponding
      // administrative entry. A repository-wide prune is intentionally avoided because it could
      // affect unrelated missing worktrees.
      await this.git(this.repoRoot, ['worktree', 'remove', '--force', worktree], 120_000);
      if (await exists(worktree)) {
        throw new LocalDevelopmentPolicyError('git did not remove the exact stale worktree');
      }
      if (artifact) await unlink(artifact);
      await unlink(this.metadataPath(jobId));

      const mainAfter = await this.inspectRepository();
      if (
        mainAfter.head !== mainBefore.head ||
        mainAfter.clean !== mainBefore.clean ||
        !sameStrings(mainAfter.changes, mainBefore.changes)
      ) {
        throw new LocalDevelopmentPolicyError('stale reset unexpectedly changed the live checkout');
      }
    });
  }

  async writeProposal(
    jobId: string,
    proposal: LocalDevelopmentProposal,
    signal?: AbortSignal,
  ): Promise<LocalDevelopmentJob> {
    this.assertJobId(jobId);
    return this.withLock(`job-${jobId}`, async () => {
      const job = await this.load(jobId);
      if (
        !['workspace_ready', 'proposal_written', 'verification_failed', 'manual_review'].includes(
          job.status,
        )
      ) {
        throw new LocalDevelopmentPolicyError(
          `job ${jobId} cannot accept a proposal in ${job.status}`,
        );
      }
      await this.assertPinnedWorktree(job);
      const proposedFiles = normalizeProposal(proposal);
      await this.validateProposalBeforeWrite(job, proposedFiles);

      const paths = proposedFiles.map((file) => file.path).sort();
      if (job.changedFiles.length > 0 && !sameStrings(paths, [...job.changedFiles].sort())) {
        throw new LocalDevelopmentPolicyError(
          'a retry must replace exactly the same proposed files; deletions and scope expansion are disabled',
        );
      }

      for (const file of proposedFiles) {
        await this.writeRegularFile(job, file);
      }
      await this.git(job.worktreePath, ['add', '--intent-to-add', '--', ...paths]);
      let inspection = await this.inspectProposal(job, paths);
      if (inspection.changedFiles.length === 0) {
        throw new LocalDevelopmentPolicyError('proposal does not change the pinned source tree');
      }
      if (!sameStrings(inspection.changedFiles, paths)) {
        throw new LocalDevelopmentPolicyError('proposal changed files outside its declared scope');
      }
      if (inspection.manualReviewReasons.length === 0) {
        await this.formatSafeProposal(job, paths, signal);
        inspection = await this.inspectProposal(job, paths, true);
        if (!sameStrings(inspection.changedFiles, paths)) {
          throw new LocalDevelopmentPolicyError(
            'trusted formatting changed files outside the proposal scope',
          );
        }
      }

      job.changedFiles = inspection.changedFiles;
      job.proposedFileHashes = inspection.hashes;
      job.manualReviewReasons = inspection.manualReviewReasons;
      job.checks = [];
      job.patchPath = undefined;
      job.patchSha256 = undefined;
      job.approvalHash = undefined;
      job.verifiedCommit = undefined;
      job.diagnostic = undefined;
      job.status = inspection.manualReviewReasons.length > 0 ? 'manual_review' : 'proposal_written';
      await this.persist(job);
      return cloneJob(job);
    });
  }

  async verify(jobId: string, signal?: AbortSignal): Promise<LocalDevelopmentVerificationResult> {
    const job = await this.verifyJob(jobId, signal);
    return {
      ready: job.status === 'ready',
      status: job.status,
      checks: structuredClone(job.checks),
      ...(job.diagnostic ? { diagnostics: job.diagnostic } : {}),
      ...(job.patchSha256 ? { artifactHash: job.patchSha256 } : {}),
      ...(job.changedFiles.length > 0 ? { artifactFiles: [...job.changedFiles] } : {}),
    };
  }

  async verifyJob(jobId: string, signal?: AbortSignal): Promise<LocalDevelopmentJob> {
    this.assertJobId(jobId);
    return this.withLock(`job-${jobId}`, async () => {
      const job = await this.load(jobId);
      if (
        !['proposal_written', 'verifying', 'verification_failed', 'manual_review'].includes(
          job.status,
        )
      ) {
        throw new LocalDevelopmentPolicyError(`job ${jobId} cannot be verified in ${job.status}`);
      }
      await this.assertPinnedWorktree(job);
      const before = await this.inspectProposal(job, job.changedFiles);
      this.assertProposalHashes(job, before.hashes);
      job.manualReviewReasons = before.manualReviewReasons;
      job.checks = [];
      job.diagnostic = undefined;

      const patch = await this.buildPatch(job);
      await this.persistPatch(job, patch);
      if (before.manualReviewReasons.length > 0) {
        job.status = 'manual_review';
        job.diagnostic = 'proposal requires manual security review and was not executed';
        await this.persist(job);
        return cloneJob(job);
      }

      job.status = 'verifying';
      await this.persist(job);
      try {
        const sandbox = await this.sandboxConfiguration(job);
        for (const check of CHECKS) {
          if (signal?.aborted) throw abortError(signal);
          const result = await this.runner({
            command: sandbox.launcher,
            args: [...sandbox.args, sandbox.pnpm, ...check.args(job.changedFiles)],
            cwd: job.worktreePath,
            env: sandbox.hostEnv,
            timeoutMs: check.timeoutMs,
            maxOutputBytes: this.limits.maxDiagnosticBytes,
            signal,
          });
          const diagnostic = this.redactDiagnostic(`${result.stdout}\n${result.stderr}`, job);
          const record: LocalDevelopmentCheck = {
            name: check.name,
            status: result.code === 0 && !result.timedOut ? 'passed' : 'failed',
            exitCode: result.code,
            ...(diagnostic ? { diagnostic } : {}),
          };
          job.checks.push(record);
          await this.persist(job);
          if (record.status === 'failed') {
            throw new Error(
              `${check.name} verification failed${result.timedOut ? ' (timeout)' : ''}`,
            );
          }
        }

        await this.removeGeneratedBuildOutput(job);
        const after = await this.inspectProposal(job, job.changedFiles, true);
        this.assertProposalHashes(job, after.hashes);
        if (after.manualReviewReasons.length > 0) {
          job.manualReviewReasons = after.manualReviewReasons;
          job.status = 'manual_review';
          job.diagnostic = 'post-verification policy requires manual security review';
          await this.persist(job);
          return cloneJob(job);
        }
        const finalPatch = await this.buildPatch(job);
        await this.persistPatch(job, finalPatch);
        await this.git(job.worktreePath, ['add', '--', ...job.changedFiles]);
        await this.git(job.worktreePath, [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgSign=false',
          '-c',
          'user.name=GooNeuro Learn Worker',
          '-c',
          'user.email=learn-worker@localhost',
          'commit',
          '--no-verify',
          '-m',
          `learn: verified proposal ${job.id}`,
        ]);
        const commit = (
          await this.git(job.worktreePath, ['rev-parse', '--verify', 'HEAD'])
        ).stdout.trim();
        const parent = (
          await this.git(job.worktreePath, ['rev-parse', '--verify', 'HEAD^'])
        ).stdout.trim();
        if (!SHA_RE.test(commit) || parent !== job.baseHead) {
          throw new LocalDevelopmentPolicyError('verified commit is not based on the pinned HEAD');
        }
        job.verifiedCommit = commit;
        job.status = 'ready';
        job.diagnostic = undefined;
        await this.persist(job);
        return cloneJob(job);
      } catch (error) {
        await this.removeGeneratedBuildOutput(job).catch(() => undefined);
        if (job.status !== 'manual_review') job.status = 'verification_failed';
        job.diagnostic = this.redactDiagnostic(errorMessage(error), job);
        await this.persist(job);
        return cloneJob(job);
      }
    });
  }

  async diff(jobId: string): Promise<LocalDevelopmentDiffResult> {
    this.assertJobId(jobId);
    const job = await this.load(jobId);
    if (job.patchPath && job.patchSha256) {
      const patch = await this.readArtifact(job);
      return { text: patch, hash: job.patchSha256, files: [...job.changedFiles] };
    }
    await this.assertPinnedWorktree(job);
    const patch = await this.buildPatch(job);
    return { text: patch, hash: sha256(patch), files: [...job.changedFiles] };
  }

  async diffText(jobId: string): Promise<string> {
    return (await this.diff(jobId)).text;
  }

  async readWorkspaceFile(jobId: string, relativePath: string): Promise<string> {
    this.assertJobId(jobId);
    const job = await this.load(jobId);
    const safePath = validateRelativePath(relativePath);
    if (!job.changedFiles.includes(safePath)) {
      throw new LocalDevelopmentPolicyError('only proposed files may be read through this API');
    }
    const target = join(job.worktreePath, safePath);
    await assertRegularNonExecutable(target);
    const data = await readFile(target);
    if (data.byteLength > this.limits.maxFileBytes) {
      throw new LocalDevelopmentPolicyError('workspace file exceeds the read limit');
    }
    return decodeUtf8(data, safePath);
  }

  async apply(jobId: string, approvalHash: string): Promise<LocalDevelopmentApplyResult> {
    try {
      const job = await this.applyJob(jobId, approvalHash);
      return job.status === 'applied'
        ? { status: 'applied', ...(job.appliedCommit ? { commitSha: job.appliedCommit } : {}) }
        : {
            status: 'failed',
            ...(job.diagnostic ? { diagnostic: job.diagnostic } : {}),
          };
    } catch (error) {
      const diagnostic = redactOperationalText(
        errorMessage(error),
        [this.repoRoot, this.workspaceRoot],
        1_000,
      );
      const conflict = /repository changed|does not match the clean repository HEAD/i.test(
        diagnostic,
      );
      return { status: conflict ? 'conflict' : 'failed', diagnostic };
    }
  }

  async applyJob(jobId: string, approvalHash: string): Promise<LocalDevelopmentJob> {
    this.assertJobId(jobId);
    return this.withLock('apply-main', async () =>
      this.withLock(`job-${jobId}`, async () => {
        const job = await this.load(jobId);
        if (job.status !== 'ready' || !job.verifiedCommit || !job.patchSha256 || !job.patchPath) {
          throw new LocalDevelopmentPolicyError('only a verified ready job can be applied');
        }
        if (approvalHash !== job.patchSha256.slice(0, APPROVAL_PREFIX_LENGTH)) {
          throw new LocalDevelopmentPolicyError(
            'approval hash does not exactly match the job prefix',
          );
        }
        const inspection = await this.inspectRepository();
        if (!inspection.clean || inspection.head !== job.baseHead) {
          throw new LocalDevelopmentPolicyError(
            'live repository changed after the job was pinned; apply was refused',
          );
        }
        const patch = await this.readArtifact(job);
        const worktreeCommit = (
          await this.git(job.worktreePath, ['rev-parse', '--verify', 'HEAD'])
        ).stdout.trim();
        if (worktreeCommit !== job.verifiedCommit) {
          throw new LocalDevelopmentPolicyError(
            'verified worktree commit no longer matches metadata',
          );
        }
        job.status = 'applying';
        job.diagnostic = undefined;
        await this.persist(job);
        try {
          await this.git(this.repoRoot, [
            'apply',
            '--check',
            '--index',
            '--whitespace=error-all',
            job.patchPath,
          ]);
          await this.git(this.repoRoot, [
            'apply',
            '--index',
            '--whitespace=error-all',
            job.patchPath,
          ]);
          const staged = (
            await this.git(this.repoRoot, ['diff', '--cached', '--name-only', '-z'])
          ).stdout
            .split('\0')
            .filter(Boolean)
            .sort();
          if (!sameStrings(staged, [...job.changedFiles].sort())) {
            throw new LocalDevelopmentPolicyError('applied patch escaped its verified file scope');
          }
          const stagedPatch = (
            await this.git(
              this.repoRoot,
              [
                'diff',
                '--cached',
                '--binary',
                '--full-index',
                '--no-ext-diff',
                '--no-textconv',
                '--',
                ...job.changedFiles,
              ],
              60_000,
              Math.max(this.limits.maxPatchBytes, this.limits.maxDiagnosticBytes),
            )
          ).stdout;
          if (sha256(stagedPatch) !== job.patchSha256) {
            throw new LocalDevelopmentPolicyError(
              'staged content does not match the exact verified patch artifact',
            );
          }
          for (const path of staged) {
            await assertRegularNonExecutable(join(this.repoRoot, path));
          }
          // Re-hashing the in-memory value keeps the artifact check adjacent to the mutation.
          if (sha256(patch) !== job.patchSha256) {
            throw new LocalDevelopmentPolicyError('patch artifact changed during apply');
          }
          const tree = (await this.git(this.repoRoot, ['write-tree'])).stdout.trim();
          if (!SHA_RE.test(tree)) {
            throw new LocalDevelopmentPolicyError('staged tree is invalid');
          }
          const candidateCommit = (
            await this.git(this.repoRoot, [
              '-c',
              'commit.gpgSign=false',
              '-c',
              'user.name=GooNeuro Learn Worker',
              '-c',
              'user.email=learn-worker@localhost',
              'commit-tree',
              tree,
              '-p',
              job.baseHead,
              '-m',
              `learn: apply verified proposal ${job.id}`,
            ])
          ).stdout.trim();
          if (!SHA_RE.test(candidateCommit)) {
            throw new LocalDevelopmentPolicyError('candidate commit is invalid');
          }
          // update-ref compares the expected old HEAD while holding Git's ref lock. An unrelated
          // concurrent commit therefore cannot silently become this generated commit's parent.
          await this.git(this.repoRoot, [
            'update-ref',
            '-m',
            `learn: apply verified proposal ${job.id}`,
            'HEAD',
            candidateCommit,
            job.baseHead,
          ]);
          const appliedCommit = (
            await this.git(this.repoRoot, ['rev-parse', '--verify', 'HEAD'])
          ).stdout.trim();
          const appliedParent = (
            await this.git(this.repoRoot, ['rev-parse', '--verify', 'HEAD^'])
          ).stdout.trim();
          if (appliedCommit !== candidateCommit || appliedParent !== job.baseHead) {
            throw new LocalDevelopmentPolicyError(
              'applied commit does not have the exact pinned parent',
            );
          }
          // No deploy/restart follows this ref update. The checkout and index already contain the
          // exact staged tree validated above, so the repository is clean on success.
          job.appliedCommit = appliedCommit;
          job.status = 'applied';
          job.diagnostic = undefined;
          await this.persist(job);
          return cloneJob(job);
        } catch (error) {
          // No reset/checkout is attempted: a rare post-apply commit failure remains visible for a
          // human to recover, instead of risking deletion of unrelated work.
          job.status = 'apply_failed';
          job.diagnostic = this.redactDiagnostic(errorMessage(error), job);
          await this.persist(job);
          return cloneJob(job);
        }
      }),
    );
  }

  private async validateProposalBeforeWrite(
    job: LocalDevelopmentJob,
    files: LocalDevelopmentProposedFile[],
  ): Promise<void> {
    if (files.length === 0 || files.length > this.limits.maxFiles) {
      throw new LocalDevelopmentPolicyError(
        `proposal must contain 1-${this.limits.maxFiles} files`,
      );
    }
    const unique = new Set<string>();
    let totalBytes = 0;
    let totalLines = 0;
    for (const file of files) {
      file.path = validateRelativePath(file.path);
      if (unique.has(file.path))
        throw new LocalDevelopmentPolicyError(`duplicate file ${file.path}`);
      unique.add(file.path);
      const denial = DENIED_PATHS.find(({ pattern }) => pattern.test(file.path));
      if (denial) throw new LocalDevelopmentPolicyError(`${file.path}: ${denial.reason}`);
      if (file.mode !== undefined && file.mode !== 0o644 && file.mode !== 0o600) {
        throw new LocalDevelopmentPolicyError(
          `${file.path}: executable or special modes are denied`,
        );
      }
      const encoded = encodeUtf8(file.content, file.path);
      if (looksBinary(file.content)) {
        throw new LocalDevelopmentPolicyError(`${file.path}: binary-like content is denied`);
      }
      const lines = countLines(file.content);
      if (encoded.byteLength > this.limits.maxFileBytes || lines > this.limits.maxFileLines) {
        throw new LocalDevelopmentPolicyError(`${file.path}: per-file size limit exceeded`);
      }
      totalBytes += encoded.byteLength;
      totalLines += lines;
      if (containsSecret(file.content)) {
        throw new LocalDevelopmentPolicyError(`${file.path}: secret-like material is denied`);
      }
      await this.assertSafeTarget(job.worktreePath, file.path);
    }
    if (totalBytes > this.limits.maxTotalBytes || totalLines > this.limits.maxTotalLines) {
      throw new LocalDevelopmentPolicyError('proposal total size limit exceeded');
    }
  }

  private async writeRegularFile(
    job: LocalDevelopmentJob,
    file: LocalDevelopmentProposedFile,
  ): Promise<void> {
    const target = join(job.worktreePath, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await this.assertSafeTarget(job.worktreePath, file.path);
    const handle = await open(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o644,
    );
    try {
      await handle.writeFile(encodeUtf8(file.content, file.path));
      await handle.sync();
      await handle.chmod(0o644);
    } finally {
      await handle.close();
    }
  }

  private async assertSafeTarget(worktree: string, relativePath: string): Promise<void> {
    const root = await realpath(worktree);
    const parts = relativePath.split('/');
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      cursor = join(cursor, part);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new LocalDevelopmentPolicyError(
            `${relativePath}: parent is not a regular directory`,
          );
        }
      } catch (error) {
        if (isMissing(error)) break;
        throw error;
      }
    }
    const target = join(root, relativePath);
    assertInside(root, target);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o111) !== 0) {
        throw new LocalDevelopmentPolicyError(
          `${relativePath}: symlinks, non-files and executables are denied`,
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async inspectProposal(
    job: LocalDevelopmentJob,
    expectedFiles: string[],
    includeIgnored = false,
  ): Promise<{
    changedFiles: string[];
    hashes: Record<string, string>;
    manualReviewReasons: string[];
  }> {
    const head = (
      await this.git(job.worktreePath, ['rev-parse', '--verify', 'HEAD'])
    ).stdout.trim();
    if (head !== job.baseHead) {
      throw new LocalDevelopmentPolicyError('worktree is no longer pinned to the job base');
    }
    const status = (
      await this.git(job.worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    ).stdout;
    const entries = parseStatus(status);
    for (const entry of entries) {
      if (entry.status.includes('D') || entry.status.includes('T') || entry.status.includes('R')) {
        throw new LocalDevelopmentPolicyError('deletions, type changes and renames are denied');
      }
      validateRelativePath(entry.path);
    }
    const changedFiles = [...new Set(entries.map((entry) => entry.path))].sort();
    if (expectedFiles.length > 0 && !sameStrings(changedFiles, [...expectedFiles].sort())) {
      throw new LocalDevelopmentPolicyError('worktree contains changes outside the proposal');
    }
    if (includeIgnored) await this.assertOnlyExpectedIgnoredFiles(job);

    const summary = (
      await this.git(job.worktreePath, [
        'diff',
        '--summary',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        ...changedFiles,
      ])
    ).stdout;
    if (/mode change|delete mode|rename/i.test(summary)) {
      throw new LocalDevelopmentPolicyError('file mode changes, deletions and renames are denied');
    }
    const stats = (
      await this.git(job.worktreePath, [
        'diff',
        '--numstat',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        ...changedFiles,
      ])
    ).stdout;
    let changedLines = 0;
    for (const line of stats.split('\n').filter(Boolean)) {
      const [added, deleted] = line.split('\t');
      if (added === '-' || deleted === '-') {
        throw new LocalDevelopmentPolicyError('binary diffs are denied');
      }
      changedLines += Number(added ?? 0) + Number(deleted ?? 0);
    }
    if (!Number.isFinite(changedLines) || changedLines > this.limits.maxChangedLines) {
      throw new LocalDevelopmentPolicyError('proposal changed-line limit exceeded');
    }

    const hashes: Record<string, string> = {};
    let totalBytes = 0;
    let totalLines = 0;
    for (const path of changedFiles) {
      const target = join(job.worktreePath, path);
      await assertRegularNonExecutable(target);
      const data = await readFile(target);
      const content = decodeUtf8(data, path);
      const lines = countLines(content);
      if (data.byteLength > this.limits.maxFileBytes || lines > this.limits.maxFileLines) {
        throw new LocalDevelopmentPolicyError(`${path}: per-file size limit exceeded`);
      }
      if (containsSecret(content)) {
        throw new LocalDevelopmentPolicyError(`${path}: secret-like material is denied`);
      }
      totalBytes += data.byteLength;
      totalLines += lines;
      hashes[path] = sha256(data);
    }
    if (totalBytes > this.limits.maxTotalBytes || totalLines > this.limits.maxTotalLines) {
      throw new LocalDevelopmentPolicyError('proposal total size limit exceeded');
    }
    const diff = (
      await this.git(job.worktreePath, [
        'diff',
        '--unified=0',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        ...changedFiles,
      ])
    ).stdout;
    const changedText = diff
      .split('\n')
      .filter(
        (line) =>
          (line.startsWith('+') && !line.startsWith('+++')) ||
          (line.startsWith('-') && !line.startsWith('---')),
      )
      .map((line) => line.slice(1))
      .join('\n');
    const reasons = DANGEROUS_PATTERNS.filter(({ pattern }) => pattern.test(changedText)).map(
      ({ code }) => code,
    );
    return {
      changedFiles,
      hashes,
      manualReviewReasons: [...new Set(reasons)].sort(),
    };
  }

  private async assertOnlyExpectedIgnoredFiles(job: LocalDevelopmentJob): Promise<void> {
    const raw = (
      await this.git(job.worktreePath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--ignored=matching',
        '--untracked-files=all',
      ])
    ).stdout;
    const unexpected = parseStatus(raw)
      .filter((entry) => entry.status === '!!')
      .map((entry) => entry.path)
      .filter((path) => path !== 'node_modules/' && !path.startsWith('node_modules/'))
      .filter((path) => path !== 'dist/' && !path.startsWith('dist/'));
    if (unexpected.length > 0) {
      throw new LocalDevelopmentPolicyError('verification created unexpected ignored files');
    }
  }

  private assertProposalHashes(job: LocalDevelopmentJob, current: Record<string, string>): void {
    const expectedEntries = Object.entries(job.proposedFileHashes).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const currentEntries = Object.entries(current).sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(expectedEntries) !== JSON.stringify(currentEntries)) {
      throw new LocalDevelopmentPolicyError(
        'proposed files changed outside the controlled write step',
      );
    }
  }

  private async buildPatch(job: LocalDevelopmentJob): Promise<string> {
    if (job.changedFiles.length === 0) {
      throw new LocalDevelopmentPolicyError('job has no proposed files');
    }
    await this.git(job.worktreePath, [
      'diff',
      '--check',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      ...job.changedFiles,
    ]);
    const patch = (
      await this.git(
        job.worktreePath,
        [
          'diff',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-textconv',
          '--',
          ...job.changedFiles,
        ],
        60_000,
        Math.max(this.limits.maxPatchBytes, this.limits.maxDiagnosticBytes),
      )
    ).stdout;
    if (!patch || Buffer.byteLength(patch) > this.limits.maxPatchBytes) {
      throw new LocalDevelopmentPolicyError('patch is empty or exceeds the artifact limit');
    }
    return patch;
  }

  private async persistPatch(job: LocalDevelopmentJob, patch: string): Promise<void> {
    const path = this.patchPath(job.id);
    await atomicPrivateWrite(path, patch);
    job.patchPath = path;
    job.patchSha256 = sha256(patch);
    job.approvalHash = job.patchSha256.slice(0, APPROVAL_PREFIX_LENGTH);
  }

  private async readArtifact(job: LocalDevelopmentJob): Promise<string> {
    if (!job.patchPath || !job.patchSha256 || job.patchPath !== this.patchPath(job.id)) {
      throw new LocalDevelopmentPolicyError('job patch metadata is invalid');
    }
    const info = await lstat(job.patchPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new LocalDevelopmentPolicyError('patch artifact must be a private regular file');
    }
    const data = await readFile(job.patchPath);
    if (data.byteLength > this.limits.maxPatchBytes) {
      throw new LocalDevelopmentPolicyError('patch artifact exceeds the size limit');
    }
    const patch = decodeUtf8(data, 'patch artifact');
    if (sha256(data) !== job.patchSha256) {
      throw new LocalDevelopmentPolicyError('patch artifact hash mismatch');
    }
    return patch;
  }

  private async sandboxConfiguration(job: LocalDevelopmentJob): Promise<{
    launcher: string;
    pnpm: string;
    args: string[];
    hostEnv: NodeJS.ProcessEnv;
  }> {
    const bubblewrap = await resolveExecutable(this.bubblewrapBin);
    const limiter = await resolveExecutable(this.resourceLimitBin);
    const resourceGroup = await resolveExecutable(this.resourceGroupBin);
    const pnpm = await resolveExecutable(this.pnpmBin);
    const node = await resolveExecutable(this.nodeBin);
    const uid = process.getuid?.();
    if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
      throw new LocalDevelopmentPolicyError('sandbox requires a local Unix user manager');
    }
    const userRuntimeDirectory = `/run/user/${uid}`;
    const modules = await realpath(this.nodeModulesPath);
    const nameService = await this.ensureSandboxNameServiceFiles();
    const moduleInfo = await stat(modules);
    if (!moduleInfo.isDirectory()) {
      throw new LocalDevelopmentPolicyError('verified dependencies are unavailable');
    }
    await mkdir(join(job.worktreePath, 'node_modules'), { recursive: true, mode: 0o755 });
    const gitFile = join(job.worktreePath, '.git');
    const bubblewrapArgs = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/bin',
      '/bin',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind',
      '/lib64',
      '/lib64',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/etc',
      '--ro-bind',
      nameService.hosts,
      '/etc/hosts',
      '--ro-bind',
      nameService.nsswitch,
      '/etc/nsswitch.conf',
      '--dir',
      '/tool',
      '--ro-bind',
      node,
      '/tool/node',
      '--ro-bind',
      pnpm,
      '/tool/pnpm',
      '--dir',
      '/workspace',
      '--bind',
      job.worktreePath,
      '/workspace',
      '--ro-bind',
      gitFile,
      '/workspace/.git',
      '--ro-bind',
      modules,
      '/workspace/node_modules',
      '--dir',
      '/tmp/home',
      '--clearenv',
      '--setenv',
      'HOME',
      '/tmp/home',
      '--setenv',
      'PATH',
      '/tool:/usr/bin:/bin',
      '--setenv',
      'CI',
      '1',
      '--setenv',
      'NODE_OPTIONS',
      `--max-old-space-size=${SANDBOX_NODE_HEAP_LIMIT_MIB}`,
      '--setenv',
      'LOG_LEVEL',
      'silent',
      '--setenv',
      'NO_COLOR',
      '1',
      '--setenv',
      'npm_config_ignore_scripts',
      'true',
      '--setenv',
      'npm_config_offline',
      'true',
      '--chdir',
      '/workspace',
    ];
    return {
      launcher: resourceGroup,
      pnpm: '/tool/pnpm',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '-p',
        `MemoryMax=${SANDBOX_CGROUP_MEMORY_LIMIT_BYTES}`,
        '-p',
        'MemorySwapMax=0',
        '-p',
        `TasksMax=${SANDBOX_CGROUP_TASK_LIMIT}`,
        '-p',
        `CPUQuota=${SANDBOX_CGROUP_CPU_QUOTA}`,
        '-p',
        'OOMPolicy=kill',
        '--',
        limiter,
        `--as=${SANDBOX_VIRTUAL_MEMORY_LIMIT_BYTES}`,
        `--nproc=${SANDBOX_UID_TASK_LIMIT}`,
        '--fsize=268435456',
        '--nofile=2048',
        '--core=0',
        '--cpu=900',
        '--',
        bubblewrap,
        ...bubblewrapArgs,
      ],
      hostEnv: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        XDG_RUNTIME_DIR: userRuntimeDirectory,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${userRuntimeDirectory}/bus`,
      },
    };
  }

  private async ensureSandboxNameServiceFiles(): Promise<{
    hosts: string;
    nsswitch: string;
  }> {
    const root = join(this.workspaceRoot, 'sandbox');
    const hosts = join(root, 'hosts');
    const nsswitch = join(root, 'nsswitch.conf');
    await atomicPrivateWrite(hosts, SANDBOX_HOSTS);
    await atomicPrivateWrite(nsswitch, SANDBOX_NSSWITCH);
    return { hosts, nsswitch };
  }

  private async formatSafeProposal(
    job: LocalDevelopmentJob,
    paths: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const sandbox = await this.sandboxConfiguration(job);
    const result = await this.runner({
      command: sandbox.launcher,
      args: [...sandbox.args, sandbox.pnpm, 'exec', 'prettier', '--write', '--', ...paths],
      cwd: job.worktreePath,
      env: sandbox.hostEnv,
      timeoutMs: 90_000,
      maxOutputBytes: this.limits.maxDiagnosticBytes,
      signal,
    });
    if (result.code !== 0 || result.timedOut) {
      const diagnostic = this.redactDiagnostic(`${result.stdout}\n${result.stderr}`, job);
      throw new LocalDevelopmentFormattingError(diagnostic);
    }
  }

  private async removeGeneratedBuildOutput(job: LocalDevelopmentJob): Promise<void> {
    const target = join(job.worktreePath, 'dist');
    assertInside(job.worktreePath, target);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) await unlink(target);
      else await rm(target, { recursive: true, force: false });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async validateResettableWorktree(job: LocalDevelopmentJob): Promise<string> {
    if (job.worktreePath !== this.worktreePath(job.id)) {
      throw new LocalDevelopmentPolicyError('stale job worktree metadata escaped its job path');
    }
    const worktree = await realpath(job.worktreePath);
    const worktreesRoot = await realpath(join(this.workspaceRoot, 'worktrees'));
    assertInside(worktreesRoot, worktree);
    const topLevelRaw = (
      await this.git(job.worktreePath, ['rev-parse', '--show-toplevel'])
    ).stdout.trim();
    const topLevel = await realpath(topLevelRaw);
    if (topLevel !== worktree) {
      throw new LocalDevelopmentPolicyError('stale job path is not its registered worktree root');
    }
    const [jobCommon, repositoryCommon] = await Promise.all([
      this.gitCommonDirectory(job.worktreePath),
      this.gitCommonDirectory(this.repoRoot),
    ]);
    if (jobCommon !== repositoryCommon) {
      throw new LocalDevelopmentPolicyError('stale worktree belongs to a different repository');
    }

    const head = (
      await this.git(job.worktreePath, ['rev-parse', '--verify', 'HEAD'])
    ).stdout.trim();
    if (head === job.baseHead) return worktree;
    if (job.status !== 'ready' || !job.verifiedCommit || head !== job.verifiedCommit) {
      throw new LocalDevelopmentPolicyError('stale worktree is not based on the expected job base');
    }
    const parent = (
      await this.git(job.worktreePath, ['rev-parse', '--verify', `${head}^`])
    ).stdout.trim();
    if (parent !== job.baseHead) {
      throw new LocalDevelopmentPolicyError('verified stale worktree has an unexpected parent');
    }
    return worktree;
  }

  private async validateResettableArtifact(job: LocalDevelopmentJob): Promise<string | undefined> {
    const expected = this.patchPath(job.id);
    if (job.patchPath !== undefined && job.patchPath !== expected) {
      throw new LocalDevelopmentPolicyError('stale job artifact metadata escaped its job path');
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(expected);
    } catch (error) {
      if (isMissing(error) && job.patchPath === undefined) return undefined;
      if (isMissing(error)) {
        throw new LocalDevelopmentPolicyError('stale job artifact declared in metadata is missing');
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new LocalDevelopmentPolicyError('stale job artifact is not a private regular file');
    }
    const data = await readFile(expected);
    if (data.byteLength > this.limits.maxPatchBytes) {
      throw new LocalDevelopmentPolicyError('stale job artifact exceeds the size limit');
    }
    decodeUtf8(data, 'stale job artifact');
    if (job.patchSha256 !== undefined && sha256(data) !== job.patchSha256) {
      throw new LocalDevelopmentPolicyError('stale job artifact hash mismatch');
    }
    return expected;
  }

  private async gitCommonDirectory(cwd: string): Promise<string> {
    const raw = (await this.git(cwd, ['rev-parse', '--git-common-dir'])).stdout.trim();
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    return realpath(path);
  }

  private async assertPinnedWorktree(job: LocalDevelopmentJob): Promise<void> {
    if (job.worktreePath !== this.worktreePath(job.id)) {
      throw new LocalDevelopmentPolicyError('job worktree metadata escaped the workspace root');
    }
    const worktreeReal = await realpath(job.worktreePath);
    const worktreesReal = await realpath(join(this.workspaceRoot, 'worktrees'));
    assertInside(worktreesReal, worktreeReal);
    const head = (
      await this.git(job.worktreePath, ['rev-parse', '--verify', 'HEAD'])
    ).stdout.trim();
    if (head !== job.baseHead) {
      throw new LocalDevelopmentPolicyError('job worktree HEAD is not pinned to its base');
    }
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    await chmod(this.workspaceRoot, 0o700);
    const repo = await realpath(this.repoRoot);
    const root = await realpath(this.workspaceRoot);
    if (pathsOverlap(repo, root)) {
      throw new LocalDevelopmentPolicyError(
        'workspace root must be outside and separate from the repository',
      );
    }
    for (const directory of ['worktrees', 'jobs', 'artifacts', 'locks', 'sandbox']) {
      const path = join(root, directory);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
  }

  private async load(jobId: string): Promise<LocalDevelopmentJob> {
    const path = this.metadataPath(jobId);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new LocalDevelopmentPolicyError('job metadata must be a private regular file');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new LocalDevelopmentPolicyError('job metadata is unreadable');
    }
    if (!isJob(parsed) || parsed.id !== jobId || parsed.worktreePath !== this.worktreePath(jobId)) {
      throw new LocalDevelopmentPolicyError('job metadata is invalid');
    }
    return parsed;
  }

  private async persist(job: LocalDevelopmentJob): Promise<void> {
    job.updatedAt = this.now().toISOString();
    await atomicPrivateWrite(this.metadataPath(job.id), `${JSON.stringify(job, null, 2)}\n`);
  }

  private async git(
    cwd: string,
    args: string[],
    timeoutMs = 60_000,
    maxOutputBytes = this.limits.maxDiagnosticBytes,
  ): Promise<LocalDevelopmentProcessResult> {
    const result = await this.runner({
      command: this.gitBin,
      args: [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        ...args,
      ],
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
      },
      timeoutMs,
      maxOutputBytes,
    });
    if (result.code !== 0 || result.timedOut) {
      const detail = redactOperationalText(
        `${result.stderr}\n${result.stdout}`,
        [this.repoRoot, this.workspaceRoot],
        1_000,
      );
      throw new LocalDevelopmentPolicyError(`git operation failed${detail ? `: ${detail}` : ''}`);
    }
    return result;
  }

  private redactDiagnostic(value: string, job: LocalDevelopmentJob): string {
    return redactOperationalText(
      value,
      [this.repoRoot, this.workspaceRoot, job.worktreePath],
      this.limits.maxDiagnosticBytes,
    );
  }

  private metadataPath(jobId: string): string {
    return join(this.workspaceRoot, 'jobs', `${jobId}.json`);
  }

  private patchPath(jobId: string): string {
    return join(this.workspaceRoot, 'artifacts', `${jobId}.patch`);
  }

  private worktreePath(jobId: string): string {
    return join(this.workspaceRoot, 'worktrees', jobId);
  }

  private async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureLayout();
    if (!/^[a-z0-9_-]{3,80}$/.test(name)) {
      throw new LocalDevelopmentPolicyError('invalid workspace lock name');
    }
    const lockPath = join(this.workspaceRoot, 'locks', `${name}.lock`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 2 && handle === undefined; attempt += 1) {
      try {
        handle = await open(
          lockPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          0o600,
        );
        await handle.writeFile(`${process.pid}\n`);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        handle = undefined;
        if (!isAlreadyExists(error)) throw error;
        if (attempt > 0 || (await lockOwnerIsAlive(lockPath))) {
          throw new LocalDevelopmentPolicyError('job is already being processed');
        }
        // A process crash can leave the lock file behind. The private lock is reclaimed only after
        // its numeric owner PID is proven absent; malformed locks fail closed.
        await unlink(lockPath);
      }
    }
    if (!handle) throw new LocalDevelopmentPolicyError('could not acquire the workspace lock');
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private assertJobId(jobId: string): void {
    if (!JOB_ID_RE.test(jobId)) throw new LocalDevelopmentPolicyError('invalid job id');
  }

  private validateLimits(): void {
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new LocalDevelopmentPolicyError(`invalid ${key} limit`);
      }
    }
  }
}

async function runBoundedProcess(
  request: LocalDevelopmentProcessRequest,
): Promise<LocalDevelopmentProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (request.signal?.aborted) {
      rejectPromise(abortError(request.signal));
      return;
    }
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      if (current.byteLength >= request.maxOutputBytes) return current;
      return Buffer.concat([
        current,
        chunk.subarray(0, request.maxOutputBytes - current.byteLength),
      ]);
    };
    const kill = (): void => {
      if (child.pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // It may have exited between the event and the signal.
        }
      }
      child.kill('SIGKILL');
    };
    const finish = (result: LocalDevelopmentProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      resolvePromise(result);
    };
    const onAbort = (): void => {
      kill();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectPromise(abortError(request.signal));
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.timeoutMs);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      rejectPromise(error);
    });
    child.once('close', (code) => {
      finish({
        code,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
      });
    });
  });
}

function normalizeProposal(proposal: LocalDevelopmentProposal): LocalDevelopmentProposedFile[] {
  if (Array.isArray(proposal)) return proposal.map((file) => ({ ...file }));
  if ('files' in proposal && Array.isArray(proposal.files)) {
    return proposal.files.map((file) => ({ ...file }));
  }
  return Object.entries(proposal).map(([path, content]) => ({ path, content }));
}

function validateRelativePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 240) {
    throw new LocalDevelopmentPolicyError('invalid proposal path');
  }
  if (isAbsolute(input) || input.includes('\\') || input.includes('\0')) {
    throw new LocalDevelopmentPolicyError(`${input}: absolute, NUL and backslash paths are denied`);
  }
  const parts = input.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new LocalDevelopmentPolicyError(`${input}: traversal and empty path segments are denied`);
  }
  if (parts.some((part) => part.startsWith('.'))) {
    throw new LocalDevelopmentPolicyError(`${input}: hidden control files are denied`);
  }
  if (parts[0] !== 'src' && parts[0] !== 'tests') {
    throw new LocalDevelopmentPolicyError(`${input}: only src/** and tests/** are writable`);
  }
  if (!input.endsWith('.ts')) {
    throw new LocalDevelopmentPolicyError(
      `${input}: only TypeScript source/test files are writable`,
    );
  }
  return parts.join('/');
}

function encodeUtf8(content: unknown, label: string): Buffer {
  if (typeof content !== 'string') {
    throw new LocalDevelopmentPolicyError(`${label}: deletions and non-text content are denied`);
  }
  const encoded = Buffer.from(content, 'utf8');
  if (encoded.toString('utf8') !== content) {
    throw new LocalDevelopmentPolicyError(`${label}: malformed UTF-8 text is denied`);
  }
  return encoded;
}

function decodeUtf8(content: Buffer, label: string): string {
  const decoded = content.toString('utf8');
  if (Buffer.from(decoded, 'utf8').compare(content) !== 0 || looksBinary(decoded)) {
    throw new LocalDevelopmentPolicyError(`${label}: file is not ordinary UTF-8 text`);
  }
  return decoded;
}

function looksBinary(content: string): boolean {
  if (content.includes('\0')) return true;
  let controls = 0;
  for (const char of content) {
    const code = char.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      controls += 1;
    }
  }
  return controls > Math.max(2, Math.floor(content.length / 100));
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

function parseStatus(raw: string): Array<{ status: string; path: string }> {
  const records = raw.split('\0').filter(Boolean);
  const result: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    result.push({ status, path });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return result;
}

async function assertRegularNonExecutable(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o111) !== 0) {
    throw new LocalDevelopmentPolicyError('proposed path is not a non-executable regular file');
  }
}

async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function resolveExecutable(command: string): Promise<string> {
  let candidate: string | undefined;
  if (command.includes('/')) {
    candidate = resolve(command);
  } else {
    for (const directory of (process.env.PATH ?? '').split(':').filter(Boolean)) {
      const path = join(directory, command);
      try {
        const info = await stat(path);
        if (info.isFile() && (info.mode & 0o111) !== 0) {
          candidate = path;
          break;
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
  if (!candidate) throw new LocalDevelopmentPolicyError(`required executable ${command} not found`);
  const resolved = await realpath(candidate);
  const info = await stat(resolved);
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new LocalDevelopmentPolicyError(`required executable ${command} is invalid`);
  }
  return resolved;
}

function pathsOverlap(first: string, second: string): boolean {
  return first === second || isWithin(first, second) || isWithin(second, first);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertInside(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (!isWithin(normalizedRoot, normalizedCandidate)) {
    throw new LocalDevelopmentPolicyError('path escaped its controlled root');
  }
}

function sameStrings(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneJob(job: LocalDevelopmentJob): LocalDevelopmentJob {
  return structuredClone(job);
}

function isJob(value: unknown): value is LocalDevelopmentJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<LocalDevelopmentJob>;
  const structurallyValid =
    job.version === METADATA_VERSION &&
    typeof job.id === 'string' &&
    JOB_ID_RE.test(job.id) &&
    typeof job.baseHead === 'string' &&
    SHA_RE.test(job.baseHead) &&
    typeof job.worktreePath === 'string' &&
    isAbsolute(job.worktreePath) &&
    typeof job.status === 'string' &&
    JOB_STATUSES.has(job.status as LocalDevelopmentJobStatus) &&
    typeof job.createdAt === 'string' &&
    typeof job.updatedAt === 'string' &&
    Array.isArray(job.changedFiles) &&
    job.proposedFileHashes !== null &&
    typeof job.proposedFileHashes === 'object' &&
    Array.isArray(job.manualReviewReasons) &&
    job.manualReviewReasons.every((reason) => typeof reason === 'string') &&
    Array.isArray(job.checks) &&
    (job.patchSha256 === undefined || SHA256_RE.test(job.patchSha256)) &&
    (job.approvalHash === undefined || /^[0-9a-f]{12}$/.test(job.approvalHash)) &&
    (job.verifiedCommit === undefined || SHA_RE.test(job.verifiedCommit)) &&
    (job.appliedCommit === undefined || SHA_RE.test(job.appliedCommit));
  if (!structurallyValid || !job.changedFiles || !job.proposedFileHashes) return false;
  try {
    for (const path of job.changedFiles) {
      if (typeof path !== 'string') return false;
      validateRelativePath(path);
      if (!SHA256_RE.test(job.proposedFileHashes[path] ?? '')) return false;
    }
  } catch {
    return false;
  }
  return Object.keys(job.proposedFileHashes).every((path) => job.changedFiles?.includes(path));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactOperationalText(value: string, paths: string[], maxBytes: number): string {
  let safe = redactSecrets(value);
  for (const path of paths) safe = safe.split(path).join('[workspace]');
  safe = safe
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, '[redacted-host]')
    .trim();
  const encoded = Buffer.from(safe, 'utf8');
  if (encoded.byteLength <= maxBytes) return safe;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('verification aborted');
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

async function lockOwnerIsAlive(path: string): Promise<boolean> {
  let owner: string;
  try {
    owner = (await readFile(path, 'utf8')).trim();
  } catch {
    return true;
  }
  if (!/^\d{1,10}$/.test(owner)) return true;
  const pid = Number(owner);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
