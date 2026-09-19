import { describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import {
  IntegrationService,
  TelegramConnector,
  type IntegrationConnection,
  type IntegrationEffect,
  type IntegrationRepository,
  type IntegrationResult,
} from '../src/integrations/index.js';
import type {
  DelegationScope,
  IntegrationDelegation,
} from '../src/companion/policy/delegations.js';

class MemoryRepo implements IntegrationRepository {
  connections = new Map<string, IntegrationConnection>();
  delegations = new Map<string, IntegrationDelegation>();
  effects = new Map<string, IntegrationEffect>();
  async addConnection(value: IntegrationConnection) {
    this.connections.set(value.id, value);
  }
  async getConnection(id: string, owner: number) {
    const value = this.connections.get(id);
    return value?.ownerTelegramId === owner ? value : null;
  }
  async listConnections(owner: number) {
    return [...this.connections.values()].filter((item) => item.ownerTelegramId === owner);
  }
  async revokeConnection(id: string, owner: number, now: Date) {
    const value = await this.getConnection(id, owner);
    if (!value) return false;
    value.revokedAt = now;
    return true;
  }
  async addGrant(value: IntegrationDelegation) {
    this.delegations.set(value.id, value);
  }
  async grants(owner: number, scope: DelegationScope) {
    return [...this.delegations.values()].filter(
      (item) => item.ownerTelegramId === owner && item.connectionId === scope.connectionId,
    );
  }
  async revokeGrant(id: string, owner: number, now: Date) {
    const value = this.delegations.get(id);
    if (!value || value.ownerTelegramId !== owner) return false;
    value.revokedAt = now;
    return true;
  }
  async claimEffect(value: IntegrationEffect) {
    const existing = this.effects.get(value.id);
    if (existing) return { claimed: false, effect: existing };
    this.effects.set(value.id, value);
    return { claimed: true, effect: value };
  }
  async settleEffect(
    id: string,
    state: 'complete' | 'uncertain',
    now: Date,
    result?: IntegrationResult,
  ) {
    Object.assign(this.effects.get(id)!, { state, updatedAt: now, result });
  }
  async eraseOwner(owner: number) {
    for (const item of this.connections.values())
      if (item.ownerTelegramId === owner) this.connections.delete(item.id);
  }
}

async function fixture() {
  const now = new Date('2026-09-19T10:00:00Z');
  const repo = new MemoryRepo();
  const sendMessage = vi
    .fn()
    .mockResolvedValue({ chat: { id: -123 }, message_id: 88, date: 1789812000 });
  const getChat = vi.fn().mockResolvedValue({ id: -123, type: 'supergroup', title: 'Test room' });
  const authorize = vi.fn().mockResolvedValue(true);
  const service = new IntegrationService(repo, {
    adapters: [new TelegramConnector({ sendMessage, getChat } as unknown as Api)],
    authorize,
    now: () => now,
  });
  const connect = (owner: number) =>
    service.connect(owner, {
      provider: 'telegram',
      accountId: 'configured-bot',
      credentialRef: {
        kind: 'secret_store',
        provider: 'environment',
        secretId: 'TELEGRAM_BOT_TOKEN',
      },
      expiresAt: new Date('2026-09-20T10:00:00Z'),
    });
  const connection = await connect(10);
  const request = {
    connectionId: connection.id,
    operation: 'message.send',
    resource: 'chat:-123',
    recipient: 'telegram:-123',
    requestKey: 'turn-25-message',
    input: { text: 'Ciao!' },
  };
  const grant = await service.grant(10, {
    connectionId: connection.id,
    operation: request.operation,
    resource: request.resource,
    recipient: request.recipient,
    expiresAt: new Date('2026-09-20T09:00:00Z'),
  });
  return {
    now,
    repo,
    service,
    connection,
    request,
    grant,
    connect,
    sendMessage,
    getChat,
    authorize,
  };
}

describe('Scoped live-provider connector boundary', () => {
  it('reuses consent and receipts without granting another owner or recipient access', async () => {
    const { service, request, sendMessage, connect } = await fixture();
    const second = await connect(20);
    expect(second.id).not.toBe(request.connectionId);
    await expect(service.execute(20, request)).rejects.toMatchObject({
      reason: 'connection_unavailable',
    });
    await expect(
      service.execute(10, { ...request, recipient: 'telegram:-456', resource: 'chat:-456' }),
    ).rejects.toMatchObject({ reason: 'needs_delegation' });
    const first = await service.execute(10, request);
    expect(first.receipt?.externalId).toBe('-123:88');
    expect(await service.execute(10, request)).toEqual(first);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await expect(
      service.execute(10, { ...request, input: { text: 'Changed content' } }),
    ).rejects.toMatchObject({ reason: 'request_conflict' });
  });

  it('reads and drafts through the actual Telegram adapter without sending', async () => {
    const { service, request, sendMessage, getChat } = await fixture();
    for (const operation of ['chat.read', 'message.draft']) {
      await service.grant(10, {
        connectionId: request.connectionId,
        operation,
        resource: request.resource,
        recipient: request.recipient,
        expiresAt: new Date('2026-09-20T09:00:00Z'),
      });
      const result = await service.execute(10, {
        ...request,
        operation,
        input: operation === 'chat.read' ? {} : request.input,
      });
      expect(result.verified).toBe(true);
    }
    expect(getChat).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('honors expiry and revocation between task preparation and effect', async () => {
    const { service, request, repo, authorize, sendMessage, now } = await fixture();
    authorize.mockImplementationOnce(async () => {
      await repo.revokeConnection(request.connectionId, 10, now);
      return true;
    });
    await expect(service.execute(10, request)).rejects.toMatchObject({
      reason: 'connection_unavailable',
    });
    expect(sendMessage).not.toHaveBeenCalled();
    const expired = await fixture();
    expired.now.setUTCDate(21);
    await expect(expired.service.execute(10, expired.request)).rejects.toMatchObject({
      reason: 'connection_unavailable',
    });
  });

  it('does not repeat a write after an external timeout or accept inline credentials', async () => {
    const { service, request, sendMessage } = await fixture();
    sendMessage.mockRejectedValue(new Error('connection lost after send'));
    await expect(service.execute(10, request)).rejects.toThrow('connection lost');
    await expect(service.execute(10, request)).rejects.toMatchObject({
      reason: 'delivery_unknown',
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    await expect(
      service.execute(10, { ...request, input: { text: 'hello', password: 'secret' } }),
    ).rejects.toThrow(/credential/);
  });
});
