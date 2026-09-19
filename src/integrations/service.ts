import { createHash, randomUUID } from 'node:crypto';
import { assertSafeCredentialReference } from '../providers/socialClients/credentials.js';
import { prepareSocialInput } from '../providers/socialClients/inputSafety.js';
import {
  assertImmutableOwner,
  delegationAllows,
  delegationScopeSchema,
  type IntegrationDelegation,
} from '../companion/policy/delegations.js';
import type {
  IntegrationAdapter,
  IntegrationConnection,
  IntegrationRepository,
  IntegrationRequest,
  IntegrationResult,
} from './types.js';

export class IntegrationAccessError extends Error {
  constructor(
    readonly reason:
      | 'connection_unavailable'
      | 'needs_delegation'
      | 'host_denied'
      | 'delivery_unknown'
      | 'request_conflict',
  ) {
    super(reason);
    this.name = 'IntegrationAccessError';
  }
}

export interface IntegrationServiceOptions {
  adapters: readonly IntegrationAdapter[];
  /** Recheck current membership, accepted terms and host permission, never model-provided claims. */
  authorize: (ownerTelegramId: number, request: IntegrationRequest) => Promise<boolean>;
  now?: () => Date;
}

export class IntegrationService {
  private readonly adapters: Map<string, IntegrationAdapter>;
  private readonly now: () => Date;
  constructor(
    private readonly repo: IntegrationRepository,
    private readonly options: IntegrationServiceOptions,
  ) {
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
    this.now = options.now ?? (() => new Date());
  }

  /** Host-only provisioning boundary. Never map arbitrary LLM args into credentials or ownership. */
  async connect(
    ownerTelegramId: number,
    input: Pick<IntegrationConnection, 'provider' | 'accountId' | 'credentialRef' | 'expiresAt'>,
  ): Promise<IntegrationConnection> {
    assertImmutableOwner(ownerTelegramId);
    assertSafeCredentialReference(input.credentialRef);
    const adapter = this.adapters.get(input.provider);
    if (!adapter?.accepts(input)) throw new IntegrationAccessError('connection_unavailable');
    const now = this.now();
    validateExpiry(input.expiresAt, now);
    const existing = await this.repo.listConnections(ownerTelegramId);
    const reusable = existing.find(
      (connection) =>
        !connection.revokedAt &&
        connection.expiresAt > now &&
        connection.provider === input.provider &&
        connection.accountId === input.accountId &&
        JSON.stringify(connection.credentialRef) === JSON.stringify(input.credentialRef),
    );
    if (reusable) return reusable;
    if (existing.filter((item) => !item.revokedAt && item.expiresAt > now).length >= 10)
      throw new Error('Too many connected accounts');
    const connection: IntegrationConnection = {
      ...input,
      credentialRef: structuredClone(input.credentialRef),
      id: randomUUID(),
      ownerTelegramId,
      createdAt: now,
    };
    await this.repo.addConnection(connection);
    return connection;
  }

  /** Only call after explicit user consent or a narrowly scoped host-approved current request. */
  async grant(
    ownerTelegramId: number,
    input: Omit<IntegrationDelegation, 'id' | 'ownerTelegramId' | 'createdAt' | 'revokedAt'>,
  ): Promise<IntegrationDelegation> {
    assertImmutableOwner(ownerTelegramId);
    const scope = delegationScopeSchema.parse({
      connectionId: input.connectionId,
      operation: input.operation,
      resource: input.resource,
      recipient: input.recipient,
    });
    const connection = await this.requireConnection(ownerTelegramId, input.connectionId);
    const operation = this.adapters
      .get(connection.provider)
      ?.operations.find((item) => item.id === scope.operation);
    if (!operation) throw new IntegrationAccessError('connection_unavailable');
    const now = this.now();
    validateExpiry(input.expiresAt, now);
    if (input.expiresAt > connection.expiresAt)
      throw new Error('Delegation cannot outlive its connection');
    const existing = (await this.repo.grants(ownerTelegramId, scope)).find((grant) =>
      delegationAllows(grant, ownerTelegramId, scope, now),
    );
    if (existing) return existing;
    const value: IntegrationDelegation = {
      ...scope,
      id: randomUUID(),
      ownerTelegramId,
      createdAt: now,
      expiresAt: input.expiresAt,
    };
    await this.repo.addGrant(value);
    return value;
  }

  async descriptors(ownerTelegramId: number): Promise<
    Array<{
      connectionId: string;
      provider: string;
      accountId: string;
      operations: IntegrationAdapter['operations'];
      expiresAt: string;
    }>
  > {
    assertImmutableOwner(ownerTelegramId);
    const now = this.now();
    return (await this.repo.listConnections(ownerTelegramId))
      .filter(
        (item) =>
          !item.revokedAt &&
          item.expiresAt > now &&
          this.adapters.get(item.provider)?.accepts(item),
      )
      .map((item) => ({
        connectionId: item.id,
        provider: item.provider,
        accountId: item.accountId,
        operations: this.adapters.get(item.provider)!.operations,
        expiresAt: item.expiresAt.toISOString(),
      }));
  }

  async execute(
    ownerTelegramId: number,
    request: IntegrationRequest,
    signal?: AbortSignal,
  ): Promise<IntegrationResult> {
    assertImmutableOwner(ownerTelegramId);
    signal?.throwIfAborted();
    const scope = delegationScopeSchema.parse({
      connectionId: request.connectionId,
      operation: request.operation,
      resource: request.resource,
      recipient: request.recipient,
    });
    if (!request.requestKey || request.requestKey.length > 240)
      throw new Error('A bounded stable request key is required');
    const prepared = prepareSocialInput(request.input);
    const safeRequest: IntegrationRequest = {
      ...scope,
      requestKey: request.requestKey,
      input: prepared.input,
    };
    const connection = await this.requireConnection(ownerTelegramId, scope.connectionId);
    const adapter = this.adapters.get(connection.provider)!;
    const operation = adapter.operations.find((item) => item.id === scope.operation);
    if (!operation) throw new IntegrationAccessError('connection_unavailable');
    await this.assertAllowed(ownerTelegramId, safeRequest);
    if (operation.effect !== 'send') {
      signal?.throwIfAborted();
      return adapter.execute(connection, safeRequest, signal);
    }
    const id = createHash('sha256')
      .update(JSON.stringify([ownerTelegramId, scope.connectionId, request.requestKey]))
      .digest('hex');
    const digest = createHash('sha256')
      .update(JSON.stringify([scope, prepared.digest]))
      .digest('hex');
    const now = this.now();
    const claim = await this.repo.claimEffect({
      id,
      ownerTelegramId,
      connectionId: scope.connectionId,
      digest,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    if (claim.effect.digest !== digest) throw new IntegrationAccessError('request_conflict');
    if (!claim.claimed) {
      if (claim.effect.state === 'complete' && claim.effect.result) return claim.effect.result;
      throw new IntegrationAccessError('delivery_unknown');
    }
    try {
      // Revocation between planning/claiming and the external effect is effective immediately.
      await this.requireConnection(ownerTelegramId, scope.connectionId);
      await this.assertAllowed(ownerTelegramId, safeRequest);
      signal?.throwIfAborted();
      const result = await adapter.execute(connection, safeRequest, signal);
      if (
        !result.verified ||
        !result.receipt?.externalId ||
        result.receipt.recipient !== scope.recipient
      )
        throw new Error('Missing verified external receipt');
      if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024)
        throw new Error('Connector receipt too large');
      await this.repo.settleEffect(id, 'complete', this.now(), result);
      return result;
    } catch (error) {
      await this.repo.settleEffect(id, 'uncertain', this.now()).catch(() => undefined);
      throw error;
    }
  }

  async revoke(ownerTelegramId: number, connectionId: string): Promise<boolean> {
    assertImmutableOwner(ownerTelegramId);
    return this.repo.revokeConnection(connectionId, ownerTelegramId, this.now());
  }
  async revokeDelegation(ownerTelegramId: number, delegationId: string): Promise<boolean> {
    assertImmutableOwner(ownerTelegramId);
    return this.repo.revokeGrant(delegationId, ownerTelegramId, this.now());
  }
  async eraseOwner(ownerTelegramId: number): Promise<void> {
    assertImmutableOwner(ownerTelegramId);
    await this.repo.eraseOwner(ownerTelegramId);
  }

  private async requireConnection(
    ownerTelegramId: number,
    id: string,
  ): Promise<IntegrationConnection> {
    const connection = await this.repo.getConnection(id, ownerTelegramId);
    if (
      !connection ||
      connection.revokedAt ||
      connection.expiresAt <= this.now() ||
      !this.adapters.get(connection.provider)?.accepts(connection)
    )
      throw new IntegrationAccessError('connection_unavailable');
    return connection;
  }
  private async assertAllowed(ownerTelegramId: number, request: IntegrationRequest): Promise<void> {
    if (!(await this.options.authorize(ownerTelegramId, request)))
      throw new IntegrationAccessError('host_denied');
    const { connectionId, operation, resource, recipient } = request;
    const scope = { connectionId, operation, resource, recipient };
    if (
      !(await this.repo.grants(ownerTelegramId, scope)).some((grant) =>
        delegationAllows(grant, ownerTelegramId, scope, this.now()),
      )
    )
      throw new IntegrationAccessError('needs_delegation');
  }
}

function validateExpiry(expiresAt: Date, now: Date): void {
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt.getTime() - now.getTime() > 366 * 86_400_000
  )
    throw new Error('Expiry must be within one year');
}
