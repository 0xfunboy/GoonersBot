import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalDevelopmentPolicyError,
  LocalDevelopmentWorkspace,
  type LocalDevelopmentProcessRequest,
  type LocalDevelopmentProcessResult,
} from '../src/capabilities/localDevelopmentWorkspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  repo: string;
  workspaceRoot: string;
  head: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'gooner-local-workspace-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const workspaceRoot = join(root, 'workspace');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'tests'), { recursive: true });
  await writeFile(join(repo, 'src', 'value.ts'), 'export const value = 1;\n');
  await writeFile(join(repo, 'tests', 'value.test.ts'), 'export const fixture = true;\n');
  await writeFile(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  git(repo, ['init', '-q']);
  git(repo, ['add', '.']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-qm',
    'base',
  ]);
  return { root, repo, workspaceRoot, head: git(repo, ['rev-parse', 'HEAD']).trim() };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
  });
}

function executable(name: string): string {
  if (
    name === 'pnpm' &&
    process.env.npm_execpath &&
    existsSync(process.env.npm_execpath) &&
    statSync(process.env.npm_execpath).isFile() &&
    (statSync(process.env.npm_execpath).mode & 0o111) !== 0
  ) {
    return process.env.npm_execpath;
  }
  for (const directory of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(directory, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  const pnpmHomeCandidate = process.env.PNPM_HOME ? join(process.env.PNPM_HOME, name) : '';
  if (pnpmHomeCandidate && existsSync(pnpmHomeCandidate) && statSync(pnpmHomeCandidate).isFile()) {
    return pnpmHomeCandidate;
  }
  // Verification execution is dependency-injected in these tests. A node executable remains a
  // valid read-only bind target when the package-manager launcher is intentionally absent in CI.
  return process.execPath;
}

function options(f: Fixture, runner?: ReturnType<typeof hybridRunner>) {
  return {
    repoRoot: f.repo,
    workspaceRoot: f.workspaceRoot,
    processRunner: runner,
    pnpmBin: executable('pnpm'),
    nodeBin: process.execPath,
    bubblewrapBin: '/usr/bin/bwrap',
    nodeModulesPath: join(process.cwd(), 'node_modules'),
  };
}

function hybridRunner(
  sandbox: (
    request: LocalDevelopmentProcessRequest,
    invocation: number,
  ) => LocalDevelopmentProcessResult | void = () => undefined,
) {
  let invocations = 0;
  const requests: LocalDevelopmentProcessRequest[] = [];
  const runner = async (
    request: LocalDevelopmentProcessRequest,
  ): Promise<LocalDevelopmentProcessResult> => {
    if (request.command === '/usr/bin/prlimit') {
      requests.push(structuredClone(request));
      invocations += 1;
      return sandbox(request, invocations) ?? { code: 0, stdout: '', stderr: '' };
    }
    try {
      const stdout = execFileSync(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        encoding: 'utf8',
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes,
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const failed = error as {
        status?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      return {
        code: failed.status ?? 1,
        stdout: String(failed.stdout ?? ''),
        stderr: String(failed.stderr ?? ''),
      };
    }
  };
  return Object.assign(runner, { requests });
}

describe('LocalDevelopmentWorkspace', () => {
  it('treats an absent stale workspace as an empty pre-creation state', async () => {
    const f = await fixture();
    const manager = new LocalDevelopmentWorkspace(options(f));

    await expect(manager.resetStaleJob('job000', f.head)).resolves.toBeUndefined();
    await expect(manager.inspectRepository()).resolves.toMatchObject({ head: f.head, clean: true });
  });

  it('pins a clean HEAD in an external detached worktree and persists private metadata', async () => {
    const f = await fixture();
    const manager = new LocalDevelopmentWorkspace(options(f));

    await expect(manager.inspectRepository()).resolves.toMatchObject({
      head: f.head,
      clean: true,
    });
    const job = await manager.createJob({ jobId: 'job001', baseSha: f.head });

    expect(job.baseHead).toBe(f.head);
    expect(job.worktreePath.startsWith(f.workspaceRoot)).toBe(true);
    expect(job.worktreePath.startsWith(f.repo)).toBe(false);
    expect(git(job.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(f.head);
    expect((await lstat(join(f.workspaceRoot, 'jobs', 'job001.json'))).mode & 0o777).toBe(0o600);
  });

  it('rejects a dirty main checkout and a base that is not the current HEAD', async () => {
    const f = await fixture();
    const manager = new LocalDevelopmentWorkspace(options(f));
    await writeFile(join(f.repo, 'src', 'dirty.ts'), 'export {};\n');

    await expect(manager.createJob('job002', f.head)).rejects.toThrow(/must be clean/i);

    await rm(join(f.repo, 'src', 'dirty.ts'));
    await expect(manager.createJob('job002', '0'.repeat(40))).rejects.toThrow(
      /base does not match/i,
    );
  });

  it.each([
    ['../escape.ts', 'export {};\n'],
    ['src/../escape.ts', 'export {};\n'],
    ['/tmp/escape.ts', 'export {};\n'],
    ['README.md', 'text\n'],
    ['src/config/generated.ts', 'export {};\n'],
    ['src/capabilities/forge.ts', 'export {};\n'],
    ['src/capabilities/localDevelopmentWorkspace.ts', 'export {};\n'],
    ['src/deployer.ts', 'export {};\n'],
    ['src/generated.js', 'export {};\n'],
    ['src/binary.ts', 'bad\0data'],
  ])('rejects denied proposal target %s', async (path, content) => {
    const f = await fixture();
    const manager = new LocalDevelopmentWorkspace(options(f));
    await manager.createJob('job003', f.head);

    await expect(manager.writeProposal('job003', { [path]: content })).rejects.toBeInstanceOf(
      LocalDevelopmentPolicyError,
    );
  });

  it('rejects symlink targets and executable files', async () => {
    const f = await fixture();
    const manager = new LocalDevelopmentWorkspace(options(f));
    const job = await manager.createJob('job004', f.head);
    const outside = join(f.root, 'outside.ts');
    await writeFile(outside, 'export const outside = true;\n');
    await symlink(outside, join(job.worktreePath, 'src', 'link.ts'));

    await expect(
      manager.writeProposal('job004', { 'src/link.ts': 'export const escaped = true;\n' }),
    ).rejects.toThrow(/symlink/i);

    await chmod(join(job.worktreePath, 'src', 'value.ts'), 0o755);
    await expect(
      manager.writeProposal('job004', { 'src/value.ts': 'export const value = 2;\n' }),
    ).rejects.toThrow(/executables/i);
  });

  it('marks process/network/environment additions for manual review without executing them', async () => {
    const f = await fixture();
    const runner = hybridRunner();
    const manager = new LocalDevelopmentWorkspace(options(f, runner));
    await manager.createJob('job005', f.head);
    const proposed = await manager.writeProposal('job005', {
      'src/value.ts': "export const value = fetch('https://example.invalid/data');\n",
    });

    expect(proposed.status).toBe('manual_review');
    expect(proposed.manualReviewReasons).toContain('network_access');
    const verified = await manager.verify('job005');
    expect(verified).toMatchObject({ ready: false, status: 'manual_review' });
    expect(verified.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    expect(runner.requests).toHaveLength(0);
  });

  it.each([
    ["import { readFile } from 'node:fs/promises';\nexport { readFile };\n", 'filesystem_access'],
    ["export const value = process['env'];\n", 'secret_or_environment_access'],
    ["export const value = import('./other.js');\n", 'dynamic_module_loading'],
  ])(
    'requires manual review for privileged or obscured runtime access',
    async (content, reason) => {
      const f = await fixture();
      const runner = hybridRunner();
      const manager = new LocalDevelopmentWorkspace(options(f, runner));
      await manager.createJob('job015', f.head);

      const proposed = await manager.writeProposal('job015', { 'src/value.ts': content });
      expect(proposed.status).toBe('manual_review');
      expect(proposed.manualReviewReasons).toContain(reason);
      await expect(manager.verify('job015')).resolves.toMatchObject({
        ready: false,
        status: 'manual_review',
      });
      expect(runner.requests).toHaveLength(0);
    },
  );

  it('requires manual review when a proposal removes an authorization gate', async () => {
    const f = await fixture();
    await writeFile(
      join(f.repo, 'src', 'value.ts'),
      'export const authorization = true;\nexport const value = 1;\n',
    );
    git(f.repo, ['add', '.']);
    git(f.repo, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '-qm',
      'add guard',
    ]);
    const guardedHead = git(f.repo, ['rev-parse', 'HEAD']).trim();
    const runner = hybridRunner();
    const manager = new LocalDevelopmentWorkspace(options(f, runner));
    await manager.createJob('job016', guardedHead);

    const proposed = await manager.writeProposal('job016', {
      'src/value.ts': 'export const value = 2;\n',
    });
    expect(proposed.status).toBe('manual_review');
    expect(proposed.manualReviewReasons).toContain('authorization_or_permissions');
    expect(runner.requests).toHaveLength(0);
  });

  it('runs only fixed checks in a networkless bubblewrap and applies an approved patch', async () => {
    const f = await fixture();
    const runner = hybridRunner();
    const manager = new LocalDevelopmentWorkspace(options(f, runner));
    await manager.createJob('job006', f.head);
    await manager.writeProposal('job006', {
      'src/value.ts': 'export const value = 2;\n',
    });

    const verified = await manager.verify('job006');
    expect(verified.ready).toBe(true);
    expect(verified.checks.map((check) => check.name)).toEqual([
      'prettier',
      'typecheck',
      'lint',
      'test',
      'build',
    ]);
    expect(runner.requests).toHaveLength(5);
    for (const request of runner.requests) {
      expect(request.args).toContain('--unshare-all');
      expect(request.args).toContain('--clearenv');
      expect(request.args).toContain('--ro-bind');
      expect(request.args).toContain('--nproc=256');
      expect(request.args).toContain('--as=4294967296');
      expect(request.args).not.toContain(f.repo);
      expect(request.env).toEqual({
        PATH: '/usr/bin:/bin',
        HOME: '/tmp',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      });
    }
    const diff = await manager.diff('job006');
    expect(diff.files).toEqual(['src/value.ts']);
    expect(diff.hash).toBe(createHash('sha256').update(diff.text).digest('hex'));

    await expect(manager.apply('job006', 'bad')).resolves.toMatchObject({ status: 'failed' });
    const applied = await manager.apply('job006', diff.hash.slice(0, 12));
    expect(applied.status).toBe('applied');
    expect(applied.commitSha).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(join(f.repo, 'src', 'value.ts'), 'utf8')).resolves.toBe(
      'export const value = 2;\n',
    );
    await expect(manager.inspectRepository()).resolves.toMatchObject({ clean: true });
    expect(git(f.repo, ['rev-parse', 'HEAD^']).trim()).toBe(f.head);
    await expect(manager.resetStaleJob('job006', f.head)).rejects.toThrow(/apply attempt/i);
  });

  it('allows a same-file retry after failed verification and redacts bounded diagnostics', async () => {
    const f = await fixture();
    let shouldFail = true;
    const runner = hybridRunner((_request, invocation) => {
      if (shouldFail && invocation === 1) {
        return {
          code: 1,
          stdout: '',
          stderr: `API_KEY=abcdefghijklmnop ${'x'.repeat(50_000)}`,
        };
      }
    });
    const manager = new LocalDevelopmentWorkspace({
      ...options(f, runner),
      limits: { maxDiagnosticBytes: 1_024 },
    });
    await manager.createJob('job007', f.head);
    await manager.writeProposal('job007', { 'src/value.ts': 'export const value = 2;\n' });
    const failed = await manager.verifyJob('job007');
    expect(failed.status).toBe('verification_failed');
    expect(failed.diagnostic).not.toContain('abcdefghijklmnop');
    expect(Buffer.byteLength(failed.diagnostic ?? '')).toBeLessThanOrEqual(1_024);

    await expect(
      manager.writeProposal('job007', { 'tests/value.test.ts': 'export {};\n' }),
    ).rejects.toThrow(/exactly the same proposed files/i);
    shouldFail = false;
    await manager.writeProposal('job007', { 'src/value.ts': 'export const value = 3;\n' });
    await expect(manager.verify('job007')).resolves.toMatchObject({ ready: true, status: 'ready' });
  });

  it('fails closed if a check mutates proposed source behind the manager', async () => {
    const f = await fixture();
    let worktree = '';
    const runner = hybridRunner((_request, invocation) => {
      if (invocation === 1) {
        writeFileSync(join(worktree, 'src', 'value.ts'), 'export const value = 99;\n');
      }
    });
    const manager = new LocalDevelopmentWorkspace(options(f, runner));
    const job = await manager.createJob('job008', f.head);
    worktree = job.worktreePath;
    await manager.writeProposal('job008', { 'src/value.ts': 'export const value = 2;\n' });

    const verified = await manager.verifyJob('job008');
    expect(verified.status).toBe('verification_failed');
    expect(verified.diagnostic).toMatch(/changed outside/i);
  });

  it('reports a conflict instead of applying when clean main HEAD advanced', async () => {
    const f = await fixture();
    const runner = hybridRunner();
    const manager = new LocalDevelopmentWorkspace(options(f, runner));
    await manager.createJob('job009', f.head);
    await manager.writeProposal('job009', { 'src/value.ts': 'export const value = 2;\n' });
    const verified = await manager.verify('job009');
    expect(verified.ready).toBe(true);

    await writeFile(join(f.repo, 'tests', 'later.test.ts'), 'export const later = true;\n');
    git(f.repo, ['add', '.']);
    git(f.repo, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '-qm',
      'advance main',
    ]);
    const result = await manager.apply('job009', verified.artifactHash?.slice(0, 12) ?? '');

    expect(result.status).toBe('conflict');
    await expect(readFile(join(f.repo, 'src', 'value.ts'), 'utf8')).resolves.toBe(
      'export const value = 1;\n',
    );
  });

  it('uses an atomic ref compare-and-swap when HEAD advances during apply', async () => {
    const f = await fixture();
    const baseRunner = hybridRunner();
    let injected = false;
    const runner = Object.assign(
      async (request: LocalDevelopmentProcessRequest): Promise<LocalDevelopmentProcessResult> => {
        const result = await baseRunner(request);
        if (
          !injected &&
          request.cwd === f.repo &&
          request.command === '/usr/bin/git' &&
          request.args.includes('apply') &&
          request.args.includes('--check')
        ) {
          injected = true;
          await writeFile(
            join(f.repo, 'tests', 'concurrent.test.ts'),
            'export const later = true;\n',
          );
          git(f.repo, ['add', '.']);
          git(f.repo, [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@localhost',
            'commit',
            '-qm',
            'concurrent commit',
          ]);
        }
        return result;
      },
      { requests: baseRunner.requests },
    );
    const manager = new LocalDevelopmentWorkspace(options(f, runner));
    await manager.createJob('job017', f.head);
    await manager.writeProposal('job017', { 'src/value.ts': 'export const value = 2;\n' });
    const verified = await manager.verify('job017');

    const result = await manager.apply('job017', verified.artifactHash?.slice(0, 12) ?? '');

    expect(result.status).toBe('failed');
    expect(git(f.repo, ['log', '-1', '--pretty=%s']).trim()).toBe('concurrent commit');
    expect(git(f.repo, ['rev-parse', 'HEAD^']).trim()).toBe(f.head);
  });

  it('enforces proposal file and byte limits before writing', async () => {
    const f = await fixture();
    const manager = new LocalDevelopmentWorkspace({
      ...options(f),
      limits: { maxFiles: 1, maxFileBytes: 20, maxTotalBytes: 20 },
    });
    await manager.createJob('job010', f.head);

    await expect(
      manager.writeProposal('job010', {
        'src/a.ts': 'export {};\n',
        'tests/a.test.ts': 'export {};\n',
      }),
    ).rejects.toThrow(/1-1 files/i);
    await expect(
      manager.writeProposal('job010', { 'src/value.ts': 'x'.repeat(21) }),
    ).rejects.toThrow(/size limit/i);
    expect((await stat(join(f.workspaceRoot, 'worktrees', 'job010', 'src', 'value.ts'))).size).toBe(
      'export const value = 1;\n'.length,
    );
  });

  it('refuses a workspace root that overlaps the repository', async () => {
    const f = await fixture();
    const manager = new LocalDevelopmentWorkspace({
      ...options(f),
      workspaceRoot: join(f.repo, '.learn-workspaces'),
    });

    await expect(manager.inspectRepository()).rejects.toThrow(/outside and separate/i);
  });

  it('resets only an exact ready stale worktree and permits regeneration from the same base', async () => {
    const f = await fixture();
    const runner = hybridRunner();
    const manager = new LocalDevelopmentWorkspace(options(f, runner));
    const job = await manager.createJob('job011', f.head);
    await manager.writeProposal('job011', { 'src/value.ts': 'export const value = 2;\n' });
    const verified = await manager.verify('job011');
    expect(verified.ready).toBe(true);
    const artifactPath = join(f.workspaceRoot, 'artifacts', 'job011.patch');
    const metadataPath = join(f.workspaceRoot, 'jobs', 'job011.json');
    expect(existsSync(artifactPath)).toBe(true);

    const mainHead = git(f.repo, ['rev-parse', 'HEAD']).trim();
    const mainStatus = git(f.repo, ['status', '--porcelain']);
    await manager.resetStaleJob('job011', f.head);

    expect(existsSync(job.worktreePath)).toBe(false);
    expect(existsSync(artifactPath)).toBe(false);
    expect(existsSync(metadataPath)).toBe(false);
    expect(git(f.repo, ['rev-parse', 'HEAD']).trim()).toBe(mainHead);
    expect(git(f.repo, ['status', '--porcelain'])).toBe(mainStatus);
    await expect(manager.createJob('job011', f.head)).resolves.toMatchObject({
      id: 'job011',
      baseHead: f.head,
      status: 'workspace_ready',
    });
  });

  it('fails closed on a stale reset base mismatch without removing generated state', async () => {
    const f = await fixture();
    const manager = new LocalDevelopmentWorkspace(options(f));
    const job = await manager.createJob('job012', f.head);
    const metadataPath = join(f.workspaceRoot, 'jobs', 'job012.json');

    await expect(manager.resetStaleJob('job012', '0'.repeat(40))).rejects.toThrow(
      /base does not match/i,
    );
    expect(existsSync(job.worktreePath)).toBe(true);
    expect(existsSync(metadataPath)).toBe(true);
    expect(git(f.repo, ['rev-parse', 'HEAD']).trim()).toBe(f.head);
  });

  it('refuses to remove a worktree whose unrecorded commit is not the stale job base', async () => {
    const f = await fixture();
    const manager = new LocalDevelopmentWorkspace(options(f));
    const job = await manager.createJob('job013', f.head);
    git(job.worktreePath, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '--allow-empty',
      '-qm',
      'unexpected worktree commit',
    ]);

    await expect(manager.resetStaleJob('job013', f.head)).rejects.toThrow(/not based/i);
    expect(existsSync(job.worktreePath)).toBe(true);
    expect(git(f.repo, ['rev-parse', 'HEAD']).trim()).toBe(f.head);
  });

  it('refuses anomalous stale artifacts instead of unlinking through a symlink', async () => {
    const f = await fixture();
    const runner = hybridRunner();
    const manager = new LocalDevelopmentWorkspace(options(f, runner));
    const job = await manager.createJob('job014', f.head);
    await manager.writeProposal('job014', {
      'src/value.ts': "export const value = fetch('https://example.invalid/data');\n",
    });
    await manager.verify('job014');
    const artifactPath = join(f.workspaceRoot, 'artifacts', 'job014.patch');
    const outside = join(f.root, 'outside-artifact');
    await writeFile(outside, 'do not remove\n');
    await unlink(artifactPath);
    await symlink(outside, artifactPath);

    await expect(manager.resetStaleJob('job014', f.head)).rejects.toThrow(/private regular/i);
    expect(existsSync(job.worktreePath)).toBe(true);
    await expect(readFile(outside, 'utf8')).resolves.toBe('do not remove\n');
  });
});
