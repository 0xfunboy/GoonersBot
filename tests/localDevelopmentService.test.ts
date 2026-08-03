import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDevelopmentJobStore } from '../src/capabilities/localDevelopmentJobs.js';
import type { LocalDevelopmentModel } from '../src/capabilities/localDevelopmentModel.js';
import {
  LocalDevelopmentService,
  LocalDevelopmentServiceError,
  type LocalDevelopmentActor,
} from '../src/capabilities/localDevelopmentService.js';
import type { LocalDevelopmentSources } from '../src/capabilities/localDevelopmentSources.js';
import {
  LocalDevelopmentFormattingError,
  type LocalDevelopmentWorkspace,
} from '../src/capabilities/localDevelopmentWorkspace.js';

const roots: string[] = [];
const services: LocalDevelopmentService[] = [];
const actor: LocalDevelopmentActor = {
  actorTelegramId: 123,
  chatId: 123,
  isGroup: false,
};
const baseSha = 'a'.repeat(40);
const artifactHash = 'b'.repeat(64);

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.waitForIdle()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: {
    clean?: boolean;
    review?: 'approved' | 'rejected';
    verificationReady?: boolean;
    preloadStale?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'gooner-local-service-'));
  roots.push(root);
  const repositoryPath = join(root, 'repo');
  const storePath = join(root, 'learn');
  await mkdir(repositoryPath);
  const jobs = new LocalDevelopmentJobStore({
    root: join(storePath, 'state'),
    repositoryRoot: repositoryPath,
  });
  const workspace = {
    inspectRepository: vi.fn().mockResolvedValue({
      head: baseSha,
      clean: options.clean ?? true,
      changes: options.clean === false ? ['src/dirty.ts'] : [],
    }),
    createJob: vi.fn().mockResolvedValue({ worktreePath: repositoryPath }),
    resetStaleJob: vi.fn().mockResolvedValue(undefined),
    writeProposal: vi.fn().mockResolvedValue({}),
    diff: vi.fn().mockResolvedValue({
      text: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
      hash: artifactHash,
      files: ['src/example.ts'],
    }),
    verify: vi.fn().mockResolvedValue({
      ready: options.verificationReady ?? true,
      status: options.verificationReady === false ? 'verification_failed' : 'ready',
      ...(options.verificationReady === false
        ? { diagnostics: 'typecheck verification failed' }
        : { artifactHash, artifactFiles: ['src/example.ts'] }),
      checks: [
        {
          name: 'typecheck',
          status: options.verificationReady === false ? 'failed' : 'passed',
          exitCode: options.verificationReady === false ? 2 : 0,
        },
        { name: 'lint', status: 'passed', exitCode: 0 },
        { name: 'test', status: 'passed', exitCode: 0 },
        { name: 'build', status: 'passed', exitCode: 0 },
      ],
    }),
    getStatus: vi.fn().mockResolvedValue({ changedFiles: ['src/example.ts'] }),
    readWorkspaceFile: vi.fn().mockResolvedValue('export const value = "new";\n'),
    apply: vi.fn().mockResolvedValue({ status: 'applied', commitSha: 'c'.repeat(40) }),
  } as unknown as LocalDevelopmentWorkspace;
  const model = {
    selectFiles: vi.fn().mockResolvedValue({
      paths: ['src/example.ts'],
      newPaths: [],
      searchTerms: [],
      reason: 'target implementation',
    }),
    propose: vi.fn().mockResolvedValue({
      version: 1,
      summary: 'small verified change',
      files: [
        {
          path: 'src/example.ts',
          operation: 'replace',
          content: 'export const value = "new";\n',
        },
      ],
      verificationNotes: [],
    }),
    review: vi.fn().mockResolvedValue(
      options.review === 'rejected'
        ? {
            version: 1,
            verdict: 'rejected',
            summary: 'unsafe',
            issues: [{ severity: 'error', path: 'src/example.ts', message: 'bad change' }],
          }
        : { version: 1, verdict: 'approved', summary: 'safe', issues: [] },
    ),
  } as unknown as LocalDevelopmentModel;
  const sources = {
    scoped: vi.fn(),
    catalog: vi.fn().mockResolvedValue(['src/example.ts']),
    candidates: vi
      .fn()
      .mockResolvedValue([
        { path: 'src/example.ts', kind: 'regular', content: 'export const value = "old";\n' },
      ]),
  } as unknown as LocalDevelopmentSources;
  vi.mocked(sources.scoped).mockReturnValue(sources);
  const service = new LocalDevelopmentService(
    {
      enabled: true,
      repositoryPath,
      storePath,
      adminTelegramIds: [actor.actorTelegramId],
      plannerModel: 'planner',
      coderModel: 'coder',
      reviewModel: 'reviewer',
      maxAttempts: options.review === 'rejected' || options.verificationReady === false ? 1 : 2,
      jobTimeoutMs: 60_000,
    },
    { jobs, workspace, model, sources },
  );
  let staleJobId: string | undefined;
  if (options.preloadStale) {
    await jobs.initialize();
    const queued = await jobs.create({
      actorTelegramId: actor.actorTelegramId,
      privateChatId: actor.chatId,
      goal: 'riprendi una modifica interrotta in sicurezza',
      baseSha,
    });
    const lease = await jobs.tryAcquireLease(queued.id);
    if (!lease.acquired) throw new Error('fixture lease unavailable');
    await jobs.update(queued.id, { state: 'generating' }, lease.token);
    await jobs.release(queued.id, lease.token);
    staleJobId = queued.id;
  }
  await service.initialize();
  services.push(service);
  return { service, jobs, workspace, model, sources, staleJobId };
}

async function waitForState(
  service: LocalDevelopmentService,
  expected: string,
): Promise<Awaited<ReturnType<LocalDevelopmentService['status']>>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = await service.status(actor);
    if (job?.state === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job did not reach ${expected}`);
}

describe('LocalDevelopmentService', () => {
  it('queues, independently reviews and verifies a private immutable-admin job', async () => {
    const { service, model, workspace, sources } = await fixture();

    const queued = await service.enqueue(actor, 'aggiungi una piccola funzionalità verificata');
    const ready = await waitForState(service, 'ready');

    expect(ready).toMatchObject({
      id: queued.id,
      state: 'ready',
      artifactHash,
      artifactFiles: ['src/example.ts'],
    });
    expect(ready?.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(model.selectFiles).toHaveBeenCalledWith(expect.objectContaining({ model: 'planner' }));
    expect(model.propose).toHaveBeenCalledWith(expect.objectContaining({ model: 'coder' }));
    expect(model.review).toHaveBeenCalledWith(expect.objectContaining({ model: 'reviewer' }));
    expect(workspace.verify).toHaveBeenCalled();
    expect(sources.scoped).toHaveBeenCalledWith(expect.any(String));
  });

  it('requires private chat, immutable actor id and a clean repository', async () => {
    const { service } = await fixture({ clean: false });

    await expect(
      service.enqueue({ ...actor, isGroup: true, chatId: -100 }, 'aggiungi una funzione sicura'),
    ).rejects.toMatchObject({ code: 'private_chat_required' });
    await expect(
      service.enqueue(
        { ...actor, actorTelegramId: 999, chatId: 999 },
        'aggiungi una funzione sicura',
      ),
    ).rejects.toMatchObject({ code: 'unauthorized_actor' });
    await expect(service.enqueue(actor, 'aggiungi una funzione sicura')).rejects.toMatchObject({
      code: 'repository_dirty',
    });
    await expect(service.enqueue(actor, 'usa password=supersecret123')).rejects.toMatchObject({
      code: 'sensitive_goal',
    });
  });

  it('requires the exact artifact hash prefix before applying a ready job', async () => {
    const { service, workspace } = await fixture();
    const queued = await service.enqueue(actor, 'modifica una funzione con test completi');
    await waitForState(service, 'ready');

    await expect(
      service.apply(actor, queued.id.slice(0, 8), 'deadbeefdead'),
    ).rejects.toBeInstanceOf(LocalDevelopmentServiceError);
    const applied = await service.apply(actor, queued.id.slice(0, 8), artifactHash.slice(0, 12));

    expect(applied.job.state).toBe('applied');
    expect(applied.result.status).toBe('applied');
    expect(workspace.apply).toHaveBeenCalledWith(queued.id, artifactHash.slice(0, 12));
  });

  it('fails closed when the independent reviewer rejects the final attempt', async () => {
    const { service, workspace } = await fixture({ review: 'rejected' });
    await service.enqueue(actor, 'introduci una modifica da revisionare');

    const failed = await waitForState(service, 'failed');
    expect(failed?.resultCode).toBe('review_rejected');
    expect(workspace.verify).not.toHaveBeenCalled();
  });

  it('preserves an approved independent review when deterministic verification fails', async () => {
    const { service } = await fixture({ verificationReady: false });
    await service.enqueue(actor, 'introduci una modifica che deve superare i controlli');

    const failed = await waitForState(service, 'failed');
    expect(failed?.resultCode).toBe('verification_failed');
    expect(failed?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'typecheck', status: 'failed' }),
        expect.objectContaining({
          id: 'independent_review',
          status: 'passed',
          code: 'approved',
        }),
      ]),
    );
  });

  it('returns a formatter parse failure to the coder and uses the remaining attempt', async () => {
    const { service, workspace, model } = await fixture();
    vi.mocked(workspace.writeProposal)
      .mockRejectedValueOnce(
        new LocalDevelopmentFormattingError('SyntaxError: expected expression'),
      )
      .mockResolvedValue({} as never);

    await service.enqueue(actor, 'aggiungi TypeScript valido e formattato con i relativi test');

    const ready = await waitForState(service, 'ready');
    expect(ready?.state).toBe('ready');
    expect(model.propose).toHaveBeenCalledTimes(2);
    expect(model.propose).toHaveBeenLastCalledWith(
      expect.objectContaining({
        feedback: ['SyntaxError: expected expression'],
        files: [
          {
            path: 'src/example.ts',
            kind: 'regular',
            content: 'export const value = "new";\n',
          },
        ],
      }),
    );
    expect(workspace.writeProposal).toHaveBeenCalledTimes(2);
    expect(workspace.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('resets and regenerates an interrupted stale workspace from its pinned base', async () => {
    const { service, workspace, staleJobId } = await fixture({ preloadStale: true });

    const ready = await waitForState(service, 'ready');
    expect(ready?.id).toBe(staleJobId);
    expect(workspace.resetStaleJob).toHaveBeenCalledWith(staleJobId, baseSha);
    expect(workspace.createJob).toHaveBeenCalledWith({ jobId: staleJobId, baseSha });
  });

  it('fences cancellation while an approved artifact is being applied', async () => {
    const { service, workspace } = await fixture();
    const queued = await service.enqueue(actor, 'applica una modifica verificata senza race');
    await waitForState(service, 'ready');

    let finishApply: ((value: { status: 'applied'; commitSha: string }) => void) | undefined;
    vi.mocked(workspace.apply).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishApply = resolve;
        }),
    );
    const applying = service.apply(actor, queued.id.slice(0, 8), artifactHash.slice(0, 12));
    await waitForState(service, 'applying');

    await expect(service.cancel(actor, queued.id.slice(0, 8))).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    finishApply?.({ status: 'applied', commitSha: 'c'.repeat(40) });
    await expect(applying).resolves.toMatchObject({ job: { state: 'applied' } });
  });
});
