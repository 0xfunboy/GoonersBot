import type { SocialAuditEvent, SocialAuditOutcome, SocialAuditSink } from './audit.js';
import {
  assertSafeCredentialReference,
  InvalidSocialCredentialReferenceError,
} from './credentials.js';
import {
  SocialIdempotencyConflictError,
  SocialIdempotencyLeaseLostError,
  type SocialIdempotencyStore,
} from './idempotency.js';
import {
  cloneAndFreezeSocialInput,
  InlineSocialCredentialError,
  prepareSocialInput,
} from './inputSafety.js';
import {
  SocialPolicyDeniedError,
  SocialPolicyEngine,
  SocialRateLimitError,
  type SocialPolicySubject,
} from './policy.js';
import { SocialAdapterUnavailableError, SocialClientRegistry } from './registry.js';
import type {
  SocialReadAdapter,
  SocialReadRequest,
  SocialCredentialReference,
  SocialWriteAdapter,
  SocialWriteRequest,
} from './types.js';

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/u;

export interface SocialClientGatewayOptions {
  registry: SocialClientRegistry;
  policy: SocialPolicyEngine;
  auditSink: SocialAuditSink;
  idempotencyStore: SocialIdempotencyStore;
  idempotencyTtlMs?: number;
  now?: () => number;
}

/**
 * The sole execution boundary for social adapters. In particular, no write adapter should be
 * called directly by Telegram handlers or learned capabilities.
 */
export class SocialClientGateway {
  private readonly idempotencyTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: SocialClientGatewayOptions) {
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(this.idempotencyTtlMs) || this.idempotencyTtlMs <= 0) {
      throw new Error('idempotencyTtlMs must be a positive integer');
    }
    this.now = options.now ?? Date.now;
  }

  async executeRead<TOutput = unknown>(
    request: SocialReadRequest,
    signal?: AbortSignal,
  ): Promise<TOutput> {
    const startedAt = this.now();
    let safeRequest: SocialReadRequest;
    let subject: SocialPolicySubject;

    try {
      safeRequest = prepareReadRequest(request);
      subject = { ...safeRequest, access: 'read' };
      this.options.policy.assertAllowed(subject);
    } catch (error) {
      await this.auditRejection(request, 'read', error, startedAt);
      throw error;
    }

    let adapter: SocialReadAdapter;
    try {
      adapter = this.options.registry.requireRead(safeRequest.platform, safeRequest.action);
      this.options.policy.consumeRateLimit(subject, startedAt);
    } catch (error) {
      await this.auditRejection(request, 'read', error, startedAt);
      throw error;
    }

    await this.appendAudit(safeRequest, 'read', 'started', startedAt, adapter.manifest.adapterId);
    try {
      const result = await adapter.executeRead(safeRequest, { signal });
      await this.appendAudit(
        safeRequest,
        'read',
        'succeeded',
        startedAt,
        adapter.manifest.adapterId,
      );
      return result as TOutput;
    } catch (error) {
      await this.appendAudit(
        safeRequest,
        'read',
        'failed',
        startedAt,
        adapter.manifest.adapterId,
        'adapter_error',
      );
      throw error;
    }
  }

  async executeWrite<TOutput = unknown>(
    request: SocialWriteRequest,
    signal?: AbortSignal,
  ): Promise<TOutput> {
    const startedAt = this.now();
    let safeRequest: SocialWriteRequest;
    let inputDigest: string;
    let subject: SocialPolicySubject;

    try {
      ({ request: safeRequest, inputDigest } = prepareWriteRequest(request));
      subject = { ...safeRequest, access: 'write' };
      if (!IDEMPOTENCY_KEY.test(safeRequest.idempotencyKey)) {
        throw new Error('invalid idempotency key');
      }
      this.options.policy.assertAllowed(subject);
    } catch (error) {
      await this.auditRejection(request, 'write', error, startedAt);
      throw error;
    }

    let adapter: SocialWriteAdapter;
    try {
      adapter = this.options.registry.requireWrite(safeRequest.platform, safeRequest.action);
    } catch (error) {
      await this.auditRejection(request, 'write', error, startedAt);
      throw error;
    }

    const claimKey = JSON.stringify([
      safeRequest.platform,
      safeRequest.accountRef,
      safeRequest.action,
      safeRequest.idempotencyKey,
    ]);
    const expiresAtMs = checkedExpiry(startedAt, this.idempotencyTtlMs);
    const claim = await this.options.idempotencyStore.claim(
      claimKey,
      inputDigest,
      expiresAtMs,
      startedAt,
    );

    if (claim.status === 'replay') {
      await this.appendAudit(
        safeRequest,
        'write',
        'idempotent_replay',
        startedAt,
        adapter.manifest.adapterId,
      );
      return claim.value as TOutput;
    }
    if (claim.status === 'conflict') {
      const error = new SocialIdempotencyConflictError(claim.state);
      await this.appendAudit(
        safeRequest,
        'write',
        'idempotency_conflict',
        startedAt,
        adapter.manifest.adapterId,
        claim.state,
      );
      throw error;
    }

    try {
      this.options.policy.consumeRateLimit(subject, startedAt);
      await this.appendAudit(
        safeRequest,
        'write',
        'started',
        startedAt,
        adapter.manifest.adapterId,
      );
    } catch (error) {
      await this.options.idempotencyStore.release(claimKey, claim.fenceToken);
      await this.auditRejection(safeRequest, 'write', error, startedAt, adapter.manifest.adapterId);
      throw error;
    }

    let result: unknown;
    try {
      result = await adapter.executeWrite(safeRequest, { signal });
      const completed = await this.options.idempotencyStore.complete(
        claimKey,
        inputDigest,
        claim.fenceToken,
        result,
        expiresAtMs,
        this.now(),
      );
      if (!completed) throw new SocialIdempotencyLeaseLostError();
    } catch (error) {
      // The remote mutation may have committed before an adapter/storage failure. Block automatic
      // retries until an operator reconciles it, rather than risking a duplicate post/action.
      const uncertainNow = this.now();
      const uncertainExpiresAtMs = checkedExpiry(uncertainNow, this.idempotencyTtlMs);
      await this.options.idempotencyStore
        .markUncertain(claimKey, inputDigest, claim.fenceToken, uncertainExpiresAtMs, uncertainNow)
        .catch(() => false);
      await this.appendAudit(
        safeRequest,
        'write',
        'failed',
        startedAt,
        adapter.manifest.adapterId,
        'write_outcome_uncertain',
      );
      throw error;
    }

    await this.appendAudit(
      safeRequest,
      'write',
      'succeeded',
      startedAt,
      adapter.manifest.adapterId,
    );
    return result as TOutput;
  }

  private async auditRejection(
    request: SocialReadRequest | SocialWriteRequest,
    access: 'read' | 'write',
    error: unknown,
    startedAt: number,
    adapterId?: string,
  ): Promise<void> {
    const outcome: SocialAuditOutcome =
      error instanceof SocialRateLimitError ? 'rate_limited' : 'denied';
    await this.appendAudit(request, access, outcome, startedAt, adapterId, classifyError(error));
  }

  private async appendAudit(
    request: SocialReadRequest | SocialWriteRequest,
    access: 'read' | 'write',
    outcome: SocialAuditOutcome,
    startedAt: number,
    adapterId?: string,
    reason?: string,
  ): Promise<void> {
    const now = this.now();
    const event: SocialAuditEvent = {
      timestamp: new Date(now).toISOString(),
      requestId: request.requestId,
      principalId: request.principalId,
      platform: request.platform,
      action: request.action,
      access,
      accountRef: request.accountRef,
      adapterId,
      outcome,
      reason,
      durationMs: Math.max(0, now - startedAt),
    };
    await this.options.auditSink.append(event);
  }
}

function checkedExpiry(nowMs: number, ttlMs: number): number {
  const expiresAtMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(expiresAtMs)) {
    throw new Error('invalid social idempotency clock value');
  }
  return expiresAtMs;
}

function validateBaseRequest(request: SocialReadRequest | SocialWriteRequest): void {
  if (!SAFE_IDENTIFIER.test(request.requestId) || !SAFE_IDENTIFIER.test(request.principalId)) {
    throw new Error('requestId and principalId must be safe internal identifiers');
  }
  if (request.accountRef !== undefined && !SAFE_IDENTIFIER.test(request.accountRef)) {
    throw new Error('accountRef must be a safe internal identifier');
  }
  if (request.credentialRef !== undefined) {
    assertSafeCredentialReference(request.credentialRef);
  }
}

function prepareReadRequest(request: SocialReadRequest): SocialReadRequest {
  assertExactRequestShape(request, 'read');
  validateBaseRequest(request);
  const input = cloneAndFreezeSocialInput(request.input);
  const credentialRef = snapshotCredentialReference(request.credentialRef);
  return Object.freeze({
    requestId: request.requestId,
    principalId: request.principalId,
    platform: request.platform,
    action: request.action,
    input,
    ...(request.accountRef !== undefined ? { accountRef: request.accountRef } : {}),
    ...(credentialRef ? { credentialRef } : {}),
  });
}

function prepareWriteRequest(request: SocialWriteRequest): {
  request: SocialWriteRequest;
  inputDigest: string;
} {
  assertExactRequestShape(request, 'write');
  validateBaseRequest(request);
  const prepared = prepareSocialInput(request.input);
  const credentialRef = snapshotCredentialReference(request.credentialRef);
  return {
    request: Object.freeze({
      requestId: request.requestId,
      principalId: request.principalId,
      platform: request.platform,
      action: request.action,
      accountRef: request.accountRef,
      idempotencyKey: request.idempotencyKey,
      input: prepared.input,
      ...(credentialRef ? { credentialRef } : {}),
    }),
    inputDigest: prepared.digest,
  };
}

function snapshotCredentialReference(
  credentialRef: SocialCredentialReference | undefined,
): SocialCredentialReference | undefined {
  if (credentialRef === undefined) return undefined;
  assertSafeCredentialReference(credentialRef);
  if (credentialRef.kind === 'cookie_jar') {
    return Object.freeze({ kind: credentialRef.kind, pathEnv: credentialRef.pathEnv });
  }
  return Object.freeze({
    kind: credentialRef.kind,
    provider: credentialRef.provider,
    secretId: credentialRef.secretId,
    ...(credentialRef.version !== undefined ? { version: credentialRef.version } : {}),
  });
}

function assertExactRequestShape(
  request: SocialReadRequest | SocialWriteRequest,
  access: 'read' | 'write',
): void {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('social request must be a plain object');
  }
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('social request must be a plain object');
  }
  const allowed = new Set([
    'requestId',
    'principalId',
    'platform',
    'action',
    'accountRef',
    'credentialRef',
    'input',
    ...(access === 'write' ? ['idempotencyKey'] : []),
  ]);
  for (const key of Reflect.ownKeys(request)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new InlineSocialCredentialError('social request contains an unexpected inline field');
    }
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error('social request cannot contain hidden fields or accessors');
    }
  }
}

function classifyError(error: unknown): string {
  if (error instanceof SocialPolicyDeniedError) return error.reason;
  if (error instanceof SocialRateLimitError) return 'rate_limit_exceeded';
  if (error instanceof SocialAdapterUnavailableError) return 'adapter_unavailable';
  if (error instanceof InvalidSocialCredentialReferenceError) return 'invalid_credential_reference';
  if (error instanceof InlineSocialCredentialError) return 'inline_credential_forbidden';
  if (error instanceof SocialIdempotencyLeaseLostError) return 'idempotency_lease_lost';
  return 'invalid_request';
}
