import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalDevelopmentJobStore,
  LocalDevelopmentJobStoreError,
  localDevelopmentJobSchema,
  type LocalDevelopmentJobStoreOptions,
} from '../src/capabilities/localDevelopmentJobs.js';

const temporaryDirectories: string[] = [];
const BASE_SHA = 'a'.repeat(40);
const ARTIFACT_HASH = 'b'.repeat(64);
const START_MS = Date.parse('2026-08-03T12:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function fixture(options: Partial<LocalDevelopmentJobStoreOptions> = {}) {
  const base = await mkdtemp(join(tmpdir(), 'gooner-local-jobs-'));
  temporaryDirectories.push(base);
  const repositoryRoot = join(base, 'repository');
  const root = join(base, 'private-job-store');
  await mkdir(repositoryRoot, { mode: 0o700 });
  let nowMs = START_MS;
  const clock = () => new Date(nowMs);
  const config: LocalDevelopmentJobStoreOptions = {
    root,
    repositoryRoot,
    clock,
    lockTimeoutMs: 3_000,
    lockStaleMs: 2_000,
    leaseTtlMs: 5_000,
    ...options,
  };
  return {
    base,
    root,
    repositoryRoot,
    config,
    store: new LocalDevelopmentJobStore(config),
    setNow: (value: number) => {
      nowMs = value;
    },
  };
}

function createInput(actorTelegramId = 42, goal = 'Aggiungi una funzione locale ben delimitata.') {
  return {
    actorTelegramId,
    privateChatId: actorTelegramId,
    goal,
    baseSha: BASE_SHA,
  };
}

async function createApplyingJob(setup: Awaited<ReturnType<typeof fixture>>, ttlMs = 5_000) {
  const queued = await setup.store.create(createInput());
  const lease = await setup.store.tryAcquireLease(queued.id, ttlMs);
  if (!lease.acquired) throw new Error('expected lease');
  const generating = await setup.store.update(queued.id, { state: 'generating' }, lease.token);
  const verifying = await setup.store.update(
    queued.id,
    { expectedRevision: generating.revision, state: 'verifying' },
    lease.token,
  );
  const ready = await setup.store.update(
    queued.id,
    {
      expectedRevision: verifying.revision,
      state: 'ready',
      artifactHash: ARTIFACT_HASH,
      artifactFiles: ['src/features/boundedFeature.ts'],
      checks: [{ id: 'tests', status: 'passed', code: 'tests_passed' }],
    },
    lease.token,
  );
  const applying = await setup.store.update(
    queued.id,
    { expectedRevision: ready.revision, state: 'applying' },
    lease.token,
  );
  return { applying, lease };
}

describe('LocalDevelopmentJobStore durability', () => {
  it('creates private atomic JSON and reloads it after a restart', async () => {
    const setup = await fixture();
    const created = await setup.store.create(createInput());
    const jobPath = join(setup.root, 'jobs', `${created.id}.json`);

    expect((await stat(setup.root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(setup.root, 'jobs'))).mode & 0o777).toBe(0o700);
    expect((await stat(jobPath)).mode & 0o777).toBe(0o600);
    expect(localDevelopmentJobSchema.parse(JSON.parse(await readFile(jobPath, 'utf8')))).toEqual(
      created,
    );

    const restarted = new LocalDevelopmentJobStore(setup.config);
    await expect(restarted.get(created.id)).resolves.toEqual(created);
    await expect(restarted.latestForActor(42)).resolves.toEqual(created);
    await expect(restarted.list({ actorTelegramId: 999 })).resolves.toEqual([]);
    await expect(restarted.list({ states: ['queued'] })).resolves.toEqual([created]);
  });

  it('rejects repository overlap, symlink overlap, raw secrets and unsafe artifact paths', async () => {
    const setup = await fixture();
    let overlapError: unknown;
    try {
      new LocalDevelopmentJobStore({
        root: join(setup.repositoryRoot, '.jobs'),
        repositoryRoot: setup.repositoryRoot,
      });
    } catch (error) {
      overlapError = error;
    }
    expect(overlapError).toMatchObject({ code: 'invalid_configuration' });

    const linkedRoot = join(setup.base, 'store-link');
    await symlink(setup.repositoryRoot, linkedRoot);
    const linked = new LocalDevelopmentJobStore({
      root: linkedRoot,
      repositoryRoot: setup.repositoryRoot,
    });
    await expect(linked.initialize()).rejects.toMatchObject({ code: 'invalid_configuration' });

    const rawSecret = 'Implementa login con password=726FVun27! senza fare domande.';
    await expect(setup.store.create(createInput(42, rawSecret))).rejects.toEqual(
      expect.objectContaining<Partial<LocalDevelopmentJobStoreError>>({ code: 'invalid_input' }),
    );
    await expect(
      setup.store.create({ ...createInput(), privateChatId: -100 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    const job = await setup.store.create(createInput());
    await expect(
      setup.store.update(job.id, { artifactFiles: ['../outside.ts'] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      setup.store.update(job.id, { artifactFiles: ['.env.production'] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('recovers an expired cross-process mutation lock without exposing its payload', async () => {
    const setup = await fixture();
    await mkdir(setup.root, { recursive: true, mode: 0o700 });
    const lockPath = join(setup.root, '.mutation.lock');
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        token: randomUUID(),
        acquiredAt: '2026-08-03T11:00:00.000Z',
        expiresAt: '2026-08-03T11:00:01.000Z',
      })}\n`,
      { mode: 0o600 },
    );

    const created = await setup.store.create(createInput());

    expect(created.state).toBe('queued');
    expect((await readdir(setup.root)).some((name) => name.startsWith('.stale-lock-'))).toBe(false);
  });
});

describe('LocalDevelopmentJobStore leases and lifecycle', () => {
  it('fences state transitions through one global lease and reaches applied safely', async () => {
    const setup = await fixture();
    const competingStore = new LocalDevelopmentJobStore(setup.config);
    const queued = await setup.store.create(createInput());
    const lease = await setup.store.tryAcquireLease(queued.id);
    if (!lease.acquired) throw new Error('expected lease');

    await expect(competingStore.tryAcquireLease(queued.id)).resolves.toEqual({
      acquired: false,
      reason: 'busy',
    });
    expect((await stat(join(setup.root, '.execution-lease.json'))).mode & 0o777).toBe(0o600);
    await expect(
      setup.store.update(queued.id, { state: 'generating' }, randomUUID()),
    ).rejects.toMatchObject({ code: 'lease_lost' });

    const generating = await setup.store.update(
      queued.id,
      { expectedRevision: 1, state: 'generating' },
      lease.token,
    );
    const policy = await setup.store.update(
      queued.id,
      { expectedRevision: generating.revision, state: 'policy_check' },
      lease.token,
    );
    const verifying = await setup.store.update(
      queued.id,
      {
        expectedRevision: policy.revision,
        state: 'verifying',
        checks: [
          { id: 'policy', status: 'passed', code: 'safe_patch' },
          { id: 'tests', status: 'failed', code: 'tests_failed' },
        ],
      },
      lease.token,
    );
    const repaired = await setup.store.update(
      queued.id,
      {
        expectedRevision: verifying.revision,
        state: 'verifying',
        checks: [
          { id: 'policy', status: 'passed', code: 'safe_patch' },
          { id: 'tests', status: 'passed', code: 'tests_passed', durationMs: 120 },
        ],
      },
      lease.token,
    );
    const ready = await setup.store.update(
      queued.id,
      {
        expectedRevision: repaired.revision,
        state: 'ready',
        artifactHash: ARTIFACT_HASH,
        artifactFiles: ['src/features/boundedFeature.ts', 'tests/boundedFeature.test.ts'],
        checks: [
          { id: 'policy', status: 'passed', code: 'safe_patch' },
          { id: 'tests', status: 'passed', code: 'tests_passed', durationMs: 120 },
        ],
      },
      lease.token,
    );

    expect(ready).toMatchObject({ state: 'ready', artifactHash: ARTIFACT_HASH });
    await expect(
      setup.store.update(queued.id, { state: 'applied' }, lease.token),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(setup.store.cancel(queued.id, 42)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    await expect(
      setup.store.update(
        queued.id,
        { state: 'applying', artifactHash: 'c'.repeat(64) },
        lease.token,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(
      setup.store.update(
        queued.id,
        { state: 'applying', artifactFiles: ['src/features/replacedArtifact.ts'] },
        lease.token,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(
      setup.store.update(
        queued.id,
        { state: 'applying', checks: [{ id: 'tests', status: 'skipped' }] },
        lease.token,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const applying = await setup.store.update(
      queued.id,
      { expectedRevision: ready.revision, state: 'applying' },
      lease.token,
    );
    expect(applying).toMatchObject({
      state: 'applying',
      artifactHash: ARTIFACT_HASH,
      artifactFiles: ready.artifactFiles,
      checks: ready.checks,
    });
    await expect(setup.store.cancel(queued.id, 42)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    await expect(
      setup.store.update(
        queued.id,
        { state: 'applied', checks: [{ id: 'tests', status: 'skipped' }] },
        lease.token,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const applied = await setup.store.update(
      queued.id,
      { expectedRevision: applying.revision, state: 'applied' },
      lease.token,
    );
    expect(applied.state).toBe('applied');
    await expect(setup.store.release(queued.id, lease.token)).resolves.toBe(true);

    await expect(setup.store.tryAcquireLease(queued.id)).resolves.toEqual({
      acquired: false,
      reason: 'not_runnable',
    });
  });

  it('recovers an expired worker as stale after restart and rejects its old fence', async () => {
    const setup = await fixture();
    const queued = await setup.store.create(createInput());
    const lease = await setup.store.tryAcquireLease(queued.id, 1_000);
    if (!lease.acquired) throw new Error('expected lease');
    const generating = await setup.store.update(queued.id, { state: 'generating' }, lease.token);

    setup.setNow(START_MS + 1_001);
    const restarted = new LocalDevelopmentJobStore(setup.config);
    const recovered = await restarted.get(queued.id);

    expect(recovered).toMatchObject({
      state: 'stale',
      revision: generating.revision + 1,
      resultCode: 'lease_expired',
    });
    await expect(
      setup.store.update(queued.id, { state: 'generating' }, lease.token),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(setup.store.release(queued.id, lease.token)).resolves.toBe(false);

    const replacement = await restarted.tryAcquireLease(queued.id);
    if (!replacement.acquired) throw new Error('expected replacement lease');
    await expect(
      restarted.update(queued.id, { state: 'generating' }, replacement.token),
    ).resolves.toMatchObject({ state: 'generating' });
  });

  it('turns an explicitly released applying lease into an immutable interrupted conflict', async () => {
    const setup = await fixture();
    const { applying, lease } = await createApplyingJob(setup);

    await expect(setup.store.release(applying.id, lease.token)).resolves.toBe(true);
    const interrupted = await setup.store.get(applying.id);

    expect(interrupted).toMatchObject({
      state: 'conflict',
      revision: applying.revision + 1,
      resultCode: 'apply_interrupted',
      artifactHash: applying.artifactHash,
      artifactFiles: applying.artifactFiles,
      checks: applying.checks,
    });
    await expect(setup.store.tryAcquireLease(applying.id)).resolves.toEqual({
      acquired: false,
      reason: 'not_runnable',
    });
  });

  it('recovers an expired applying lease as apply_interrupted rather than stale', async () => {
    const setup = await fixture();
    const { applying, lease } = await createApplyingJob(setup, 1_000);
    setup.setNow(START_MS + 1_001);

    const restarted = new LocalDevelopmentJobStore(setup.config);
    const interrupted = await restarted.get(applying.id);

    expect(interrupted).toMatchObject({
      state: 'conflict',
      revision: applying.revision + 1,
      resultCode: 'apply_interrupted',
      artifactHash: applying.artifactHash,
    });
    await expect(setup.store.release(applying.id, lease.token)).resolves.toBe(false);
    await expect(restarted.tryAcquireLease(applying.id)).resolves.toEqual({
      acquired: false,
      reason: 'not_runnable',
    });
  });

  it('allows only the owning actor to cancel and retains the fence until worker release', async () => {
    const setup = await fixture();
    const queued = await setup.store.create(createInput(42));
    const lease = await setup.store.tryAcquireLease(queued.id);
    if (!lease.acquired) throw new Error('expected lease');

    await expect(setup.store.cancel(queued.id, 99)).resolves.toBeNull();
    const cancelled = await setup.store.cancel(queued.id, 42);

    expect(cancelled).toMatchObject({ state: 'cancelled', resultCode: 'cancelled_by_actor' });
    await expect(setup.store.release(queued.id, lease.token)).resolves.toBe(true);
    await expect(setup.store.tryAcquireLease(queued.id)).resolves.toEqual({
      acquired: false,
      reason: 'not_runnable',
    });
  });
});

describe('LocalDevelopmentJobStore concurrency', () => {
  it('serializes creates from independent instances without corrupting JSON', async () => {
    const setup = await fixture();
    const first = setup.store;
    const second = new LocalDevelopmentJobStore(setup.config);

    const jobs = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 === 0 ? first : second).create(
          createInput(100 + index, `Implementa il task locale delimitato numero ${index}.`),
        ),
      ),
    );

    expect(new Set(jobs.map((job) => job.id))).toHaveLength(24);
    const listed = await first.list({ limit: 100 });
    expect(listed).toHaveLength(24);
    const files = (await readdir(join(setup.root, 'jobs'))).filter((file) =>
      file.endsWith('.json'),
    );
    expect(files).toHaveLength(24);
    for (const file of files) {
      expect(
        localDevelopmentJobSchema.safeParse(
          JSON.parse(await readFile(join(setup.root, 'jobs', file), 'utf8')),
        ).success,
      ).toBe(true);
    }
  });

  it('uses optimistic revision checks to prevent a lost concurrent update', async () => {
    const setup = await fixture();
    const competingStore = new LocalDevelopmentJobStore(setup.config);
    const queued = await setup.store.create(createInput());
    const lease = await setup.store.tryAcquireLease(queued.id);
    if (!lease.acquired) throw new Error('expected lease');
    const generating = await setup.store.update(queued.id, { state: 'generating' }, lease.token);

    const results = await Promise.allSettled([
      setup.store.update(
        queued.id,
        { expectedRevision: generating.revision, state: 'policy_check' },
        lease.token,
      ),
      competingStore.update(
        queued.id,
        { expectedRevision: generating.revision, state: 'verifying' },
        lease.token,
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'revision_conflict' }),
    });
    const durable = await setup.store.get(queued.id);
    expect(durable?.revision).toBe(generating.revision + 1);
  });
});
