import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeCredentialReference,
  cookieJarReferenceForPlatform,
  DENY_ALL_SOCIAL_POLICY,
  InMemorySocialAuditSink,
  InMemorySocialIdempotencyStore,
  InlineSocialCredentialError,
  InvalidSocialCredentialReferenceError,
  importNetscapeCookieJar,
  isAllowedCookieDomain,
  PLANNED_SOCIAL_CAPABILITY_MANIFESTS,
  prepareSocialInput,
  SOCIAL_PLATFORMS,
  SocialClientGateway,
  SocialClientRegistry,
  SocialIdempotencyConflictError,
  SocialIdempotencyLeaseLostError,
  SocialPolicyDeniedError,
  SocialPolicyEngine,
  SocialRateLimitError,
  type SocialCapabilityManifest,
  type SocialPolicyConfig,
  type SocialReadAdapter,
  type SocialWriteAdapter,
} from '../src/providers/socialClients/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const readManifest: SocialCapabilityManifest = {
  platform: 'x',
  adapterId: 'fake-x-read',
  version: '1.0.0',
  capabilities: [
    {
      action: 'content.metadata.read',
      access: 'read',
      status: 'available',
      auth: ['anonymous', 'session'],
    },
  ],
};

const writeManifest: SocialCapabilityManifest = {
  platform: 'x',
  adapterId: 'fake-x-write',
  version: '1.0.0',
  capabilities: [
    { action: 'post.create', access: 'write', status: 'available', auth: ['session'] },
  ],
};

function allowedPolicy(overrides: Partial<SocialPolicyConfig> = {}): SocialPolicyConfig {
  return {
    allowedPrincipals: ['telegram-user:123'],
    allowedPlatforms: ['x'],
    allowedReadActions: ['content.metadata.read'],
    write: {
      enabled: false,
      allowedActions: [],
      allowedAccountRefs: [],
    },
    ...overrides,
  };
}

function gateway(options: {
  policy: SocialPolicyConfig;
  readAdapter?: SocialReadAdapter;
  writeAdapter?: SocialWriteAdapter;
  now?: () => number;
  idempotencyTtlMs?: number;
}) {
  const registry = new SocialClientRegistry();
  if (options.readAdapter !== undefined) registry.registerRead(options.readAdapter);
  if (options.writeAdapter !== undefined) registry.registerWrite(options.writeAdapter);
  const auditSink = new InMemorySocialAuditSink();
  const instance = new SocialClientGateway({
    registry,
    policy: new SocialPolicyEngine(options.policy),
    auditSink,
    idempotencyStore: new InMemorySocialIdempotencyStore(),
    now: options.now,
    idempotencyTtlMs: options.idempotencyTtlMs,
  });
  return { instance, auditSink };
}

describe('social client capability boundary', () => {
  it('ships only non-executable roadmap manifests', () => {
    expect(Object.keys(PLANNED_SOCIAL_CAPABILITY_MANIFESTS).sort()).toEqual(
      [...SOCIAL_PLATFORMS].sort(),
    );
    for (const manifest of Object.values(PLANNED_SOCIAL_CAPABILITY_MANIFESTS)) {
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.capabilities)).toBe(true);
      expect(manifest.capabilities.every((item) => Object.isFrozen(item))).toBe(true);
      expect(manifest.capabilities.every((item) => Object.isFrozen(item.auth))).toBe(true);
      expect(manifest.capabilities.some((item) => item.status === 'available')).toBe(false);
      expect(
        manifest.capabilities
          .filter((item) => item.access === 'write')
          .every((item) => item.status === 'disabled'),
      ).toBe(true);
    }

    const registry = new SocialClientRegistry();
    expect(() =>
      registry.registerRead({
        platform: 'x',
        manifest: PLANNED_SOCIAL_CAPABILITY_MANIFESTS.x,
        executeRead: vi.fn(),
      }),
    ).toThrow('has no available read capability');

    const planned = PLANNED_SOCIAL_CAPABILITY_MANIFESTS.x.capabilities[0]!;
    expect(() => {
      (planned as { status: string }).status = 'available';
    }).toThrow(TypeError);
    expect(planned.status).toBe('planned');
  });

  it('snapshots and deep-freezes adapter manifests inside the registry', () => {
    const mutableManifest = structuredClone(writeManifest) as SocialCapabilityManifest;
    const adapter: SocialWriteAdapter = {
      platform: 'x',
      manifest: mutableManifest,
      executeWrite: vi.fn(),
    };
    const registry = new SocialClientRegistry();
    registry.registerWrite(adapter);

    (mutableManifest.capabilities[0] as { status: string }).status = 'planned';
    (mutableManifest.capabilities[0]!.auth as string[]).push('anonymous');
    const registered = registry.requireWrite('x', 'post.create');

    expect(registered).not.toBe(adapter);
    expect(registered.manifest).not.toBe(mutableManifest);
    expect(registered.manifest.capabilities[0]).toMatchObject({
      action: 'post.create',
      status: 'available',
      auth: ['session'],
    });
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.manifest.capabilities[0]?.auth)).toBe(true);
    expect(() => {
      (registered.manifest.capabilities[0] as { status: string }).status = 'disabled';
    }).toThrow(TypeError);
    expect(() => registry.requireWrite('x', 'post.create')).not.toThrow();
  });

  it('accepts references but rejects an inline credential field', () => {
    expect(() =>
      assertSafeCredentialReference({ kind: 'cookie_jar', pathEnv: 'SOCIAL_X_COOKIE_JAR_FILE' }),
    ).not.toThrow();
    expect(() =>
      assertSafeCredentialReference({
        kind: 'cookie_jar',
        pathEnv: 'SOCIAL_X_COOKIE_JAR_FILE',
        cookie: 'inline-secret',
      } as never),
    ).toThrow(InvalidSocialCredentialReferenceError);
  });

  it('imports only platform-scoped Netscape cookies with mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goonerbot-social-clients-'));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'export.cookies.txt');
    const destinationPath = join(directory, 'sessions', 'x.cookies.txt');
    await writeFile(
      sourcePath,
      [
        '# Netscape HTTP Cookie File',
        '.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tfixture-x-value',
        '#HttpOnly_.mobile.twitter.com\tTRUE\t/\tTRUE\t0\ttwid\tfixture-twitter-value',
        '.notx.com\tTRUE\t/\tTRUE\t0\tbad\tfixture-rejected-value',
        'malformed-row',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );

    await expect(
      importNetscapeCookieJar({ platform: 'x', sourcePath, destinationPath }),
    ).resolves.toEqual({ platform: 'x', importedCookies: 2, rejectedCookies: 2 });
    const installed = await readFile(destinationPath, 'utf8');
    expect(installed).toContain('fixture-x-value');
    expect(installed).toContain('fixture-twitter-value');
    expect(installed).not.toContain('fixture-rejected-value');
    expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
  });

  it('uses exact domain boundaries and platform-specific path references', () => {
    expect(isAllowedCookieDomain('x', '.x.com')).toBe(true);
    expect(isAllowedCookieDomain('x', 'mobile.twitter.com')).toBe(true);
    expect(isAllowedCookieDomain('x', 'evilx.com')).toBe(false);
    expect(isAllowedCookieDomain('instagram', 'x.com')).toBe(false);
    expect(cookieJarReferenceForPlatform('youtube')).toEqual({
      kind: 'cookie_jar',
      pathEnv: 'SOCIAL_YOUTUBE_COOKIE_JAR_FILE',
    });
  });

  it('enforces read allowlists and rate limits without auditing payloads or credentials', async () => {
    let now = 1_000;
    const executeRead = vi.fn(async () => ({ author: 'safe-result' }));
    const { instance, auditSink } = gateway({
      policy: allowedPolicy({
        rateLimits: { 'content.metadata.read': { maxAttempts: 1, windowMs: 10_000 } },
      }),
      readAdapter: { platform: 'x', manifest: readManifest, executeRead },
      now: () => now,
    });
    const request = {
      requestId: 'request:1',
      principalId: 'telegram-user:123',
      platform: 'x' as const,
      action: 'content.metadata.read' as const,
      credentialRef: { kind: 'cookie_jar' as const, pathEnv: 'SOCIAL_X_COOKIE_JAR_FILE' },
      input: { url: 'https://social.invalid/secret-path', privateMarker: 'do-not-audit' },
    };

    await expect(instance.executeRead(request)).resolves.toEqual({ author: 'safe-result' });
    now += 1;
    await expect(instance.executeRead(request)).rejects.toBeInstanceOf(SocialRateLimitError);
    expect(executeRead).toHaveBeenCalledTimes(1);
    expect(auditSink.events.map((event) => event.outcome)).toEqual([
      'started',
      'succeeded',
      'rate_limited',
    ]);
    const serializedAudit = JSON.stringify(auditSink.events);
    expect(serializedAudit).not.toContain('secret-path');
    expect(serializedAudit).not.toContain('do-not-audit');
    expect(serializedAudit).not.toContain('SOCIAL_X_COOKIE_JAR_FILE');
  });

  it('rejects recursively nested inline credentials before a read adapter sees them', async () => {
    const executeRead = vi.fn();
    const { instance, auditSink } = gateway({
      policy: allowedPolicy(),
      readAdapter: { platform: 'x', manifest: readManifest, executeRead },
    });
    const request = {
      requestId: 'request:nested-read-secret',
      principalId: 'telegram-user:123',
      platform: 'x' as const,
      action: 'content.metadata.read' as const,
      input: {
        options: [{ transport: { headers: { Authorization: 'Bearer fixture-secret' } } }],
      },
    };

    await expect(instance.executeRead(request)).rejects.toBeInstanceOf(InlineSocialCredentialError);
    expect(executeRead).not.toHaveBeenCalled();
    expect(auditSink.events.at(-1)).toMatchObject({
      outcome: 'denied',
      reason: 'inline_credential_forbidden',
    });
    expect(JSON.stringify(auditSink.events)).not.toContain('fixture-secret');
  });

  it.each([
    'userPassword',
    'clientApiToken',
    'proxyAuthorizationHeader',
    'cookieJarValue',
    'backupClientSecret',
  ])('rejects disguised credential key %s at any input depth', (field) => {
    expect(() =>
      prepareSocialInput({ envelope: [{ profile: { [field]: 'fixture-secret' } }] }),
    ).toThrow(InlineSocialCredentialError);
  });

  it('rejects inline secrets in write arrays and freezes a detached safe input snapshot', async () => {
    const executeWrite = vi.fn(async () => ({ postId: 'post:safe' }));
    const { instance } = gateway({
      policy: allowedPolicy({
        write: {
          enabled: true,
          allowedActions: ['post.create'],
          allowedAccountRefs: ['account:main'],
        },
      }),
      writeAdapter: { platform: 'x', manifest: writeManifest, executeWrite },
    });

    await expect(
      instance.executeWrite({
        requestId: 'request:nested-write-secret',
        principalId: 'telegram-user:123',
        platform: 'x',
        action: 'post.create',
        accountRef: 'account:main',
        idempotencyKey: 'post-key-secret-1',
        input: { operations: [{ config: { refresh_token: 'fixture-secret' } }] },
      }),
    ).rejects.toBeInstanceOf(InlineSocialCredentialError);
    expect(executeWrite).not.toHaveBeenCalled();

    const mutableInput = { post: { text: 'before mutation', tags: ['one'] } };
    const execution = instance.executeWrite({
      requestId: 'request:detached-input',
      principalId: 'telegram-user:123',
      platform: 'x',
      action: 'post.create',
      accountRef: 'account:main',
      idempotencyKey: 'post-key-detached-1',
      input: mutableInput,
    });
    mutableInput.post.text = 'after mutation';
    mutableInput.post.tags.push('two');
    await execution;

    const delivered = executeWrite.mock.calls[0]?.[0];
    expect(delivered?.input).toEqual({ post: { text: 'before mutation', tags: ['one'] } });
    expect(Object.isFrozen(delivered?.input)).toBe(true);
    expect(Object.isFrozen((delivered?.input as { post: object }).post)).toBe(true);
  });

  it('denies writes by default before invoking an adapter', async () => {
    const executeWrite = vi.fn(async () => ({ postId: 'never' }));
    const { instance, auditSink } = gateway({
      policy: DENY_ALL_SOCIAL_POLICY,
      writeAdapter: { platform: 'x', manifest: writeManifest, executeWrite },
    });

    await expect(
      instance.executeWrite({
        requestId: 'request:2',
        principalId: 'telegram-user:123',
        platform: 'x',
        action: 'post.create',
        accountRef: 'account:main',
        idempotencyKey: 'post-key-0001',
        input: { text: 'must-not-be-sent' },
      }),
    ).rejects.toBeInstanceOf(SocialPolicyDeniedError);
    expect(executeWrite).not.toHaveBeenCalled();
    expect(auditSink.events.at(-1)?.outcome).toBe('denied');
  });

  it('replays a completed write and invokes the adapter only once', async () => {
    const executeWrite = vi.fn(async () => ({ postId: 'post:1' }));
    const { instance, auditSink } = gateway({
      policy: allowedPolicy({
        write: {
          enabled: true,
          allowedActions: ['post.create'],
          allowedAccountRefs: ['account:main'],
        },
      }),
      writeAdapter: { platform: 'x', manifest: writeManifest, executeWrite },
    });
    const request = {
      requestId: 'request:3',
      principalId: 'telegram-user:123',
      platform: 'x' as const,
      action: 'post.create' as const,
      accountRef: 'account:main',
      idempotencyKey: 'post-key-0002',
      input: { text: 'hello', options: { first: 1, second: 2 } },
    };

    await expect(instance.executeWrite(request)).resolves.toEqual({ postId: 'post:1' });
    await expect(
      instance.executeWrite({
        ...request,
        requestId: 'request:3-reordered',
        input: { options: { second: 2, first: 1 }, text: 'hello' },
      }),
    ).resolves.toEqual({ postId: 'post:1' });
    expect(executeWrite).toHaveBeenCalledTimes(1);
    expect(auditSink.events.at(-1)?.outcome).toBe('idempotent_replay');
  });

  it('rejects reuse of one idempotency key with different canonical input', async () => {
    const executeWrite = vi.fn(async () => ({ postId: 'post:collision' }));
    const { instance, auditSink } = gateway({
      policy: allowedPolicy({
        write: {
          enabled: true,
          allowedActions: ['post.create'],
          allowedAccountRefs: ['account:main'],
        },
      }),
      writeAdapter: { platform: 'x', manifest: writeManifest, executeWrite },
    });
    const base = {
      requestId: 'request:collision-one',
      principalId: 'telegram-user:123',
      platform: 'x' as const,
      action: 'post.create' as const,
      accountRef: 'account:main',
      idempotencyKey: 'post-key-collision-1',
    };

    await instance.executeWrite({
      ...base,
      input: { text: 'first intent', options: { a: 1, b: 2 } },
    });
    await expect(
      instance.executeWrite({
        ...base,
        requestId: 'request:collision-two',
        input: { text: 'different intent', options: { a: 1, b: 2 } },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SocialIdempotencyConflictError>>({
        state: 'input_mismatch',
      }),
    );
    expect(executeWrite).toHaveBeenCalledTimes(1);
    expect(auditSink.events.at(-1)).toMatchObject({
      outcome: 'idempotency_conflict',
      reason: 'input_mismatch',
    });
  });

  it('uses fencing tokens so an expired claimant cannot overwrite a newer claim', async () => {
    const store = new InMemorySocialIdempotencyStore();
    const first = await store.claim('claim-key', 'a'.repeat(64), 10, 0);
    if (first.status !== 'acquired') throw new Error('expected first claim');
    const second = await store.claim('claim-key', 'b'.repeat(64), 30, 10);
    if (second.status !== 'acquired') throw new Error('expected replacement claim');

    await expect(
      store.complete('claim-key', 'a'.repeat(64), first.fenceToken, { stale: true }, 30, 11),
    ).resolves.toBe(false);
    await expect(store.release('claim-key', first.fenceToken)).resolves.toBe(false);
    await expect(
      store.complete('claim-key', 'b'.repeat(64), second.fenceToken, { fresh: true }, 30, 11),
    ).resolves.toBe(true);
    await expect(store.claim('claim-key', 'b'.repeat(64), 40, 12)).resolves.toEqual({
      status: 'replay',
      value: { fresh: true },
    });
  });

  it('detects when a write finishes after its idempotency lease expires', async () => {
    let now = 100;
    const executeWrite = vi.fn(async () => {
      now = 111;
      return { postId: 'possibly-committed' };
    });
    const { instance, auditSink } = gateway({
      policy: allowedPolicy({
        write: {
          enabled: true,
          allowedActions: ['post.create'],
          allowedAccountRefs: ['account:main'],
        },
      }),
      writeAdapter: { platform: 'x', manifest: writeManifest, executeWrite },
      now: () => now,
      idempotencyTtlMs: 10,
    });

    await expect(
      instance.executeWrite({
        requestId: 'request:expired-lease',
        principalId: 'telegram-user:123',
        platform: 'x',
        action: 'post.create',
        accountRef: 'account:main',
        idempotencyKey: 'post-key-expired-1',
        input: { text: 'lease test' },
      }),
    ).rejects.toBeInstanceOf(SocialIdempotencyLeaseLostError);
    expect(auditSink.events.at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'write_outcome_uncertain',
    });
    await expect(
      instance.executeWrite({
        requestId: 'request:expired-lease-retry',
        principalId: 'telegram-user:123',
        platform: 'x',
        action: 'post.create',
        accountRef: 'account:main',
        idempotencyKey: 'post-key-expired-1',
        input: { text: 'lease test' },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SocialIdempotencyConflictError>>({ state: 'uncertain' }),
    );
    expect(executeWrite).toHaveBeenCalledTimes(1);
  });

  it('blocks blind retries after an uncertain write failure', async () => {
    const executeWrite = vi.fn(async () => {
      throw new Error('connection lost after submit');
    });
    const { instance } = gateway({
      policy: allowedPolicy({
        write: {
          enabled: true,
          allowedActions: ['post.create'],
          allowedAccountRefs: ['account:main'],
        },
      }),
      writeAdapter: { platform: 'x', manifest: writeManifest, executeWrite },
    });
    const request = {
      requestId: 'request:4',
      principalId: 'telegram-user:123',
      platform: 'x' as const,
      action: 'post.create' as const,
      accountRef: 'account:main',
      idempotencyKey: 'post-key-0003',
      input: { text: 'hello' },
    };

    await expect(instance.executeWrite(request)).rejects.toThrow('connection lost after submit');
    await expect(instance.executeWrite(request)).rejects.toEqual(
      expect.objectContaining<Partial<SocialIdempotencyConflictError>>({ state: 'uncertain' }),
    );
    expect(executeWrite).toHaveBeenCalledTimes(1);
  });
});
