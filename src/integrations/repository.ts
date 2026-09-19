import { MongoServerError, type Collection, type Db } from 'mongodb';
import type { DelegationScope, IntegrationDelegation } from '../companion/policy/delegations.js';
import type {
  IntegrationConnection,
  IntegrationEffect,
  IntegrationRepository,
  IntegrationResult,
} from './types.js';

export class MongoIntegrationRepository implements IntegrationRepository {
  private readonly connections: Collection<IntegrationConnection>;
  private readonly delegations: Collection<IntegrationDelegation>;
  private readonly effects: Collection<IntegrationEffect>;

  constructor(db: Db) {
    this.connections = db.collection('companion_connections');
    this.delegations = db.collection('companion_delegations');
    this.effects = db.collection('companion_connector_effects');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    for (const name of [
      'companion_connections',
      'companion_delegations',
      'companion_connector_effects',
    ]) {
      const col = db.collection(name);
      await col.createIndex({ id: 1 }, { unique: true });
      await col.createIndex({ ownerTelegramId: 1 });
    }
    // Uncertain receipts deliberately have no TTL: expiration must not reopen an ambiguous send.
    await db
      .collection('companion_delegations')
      .createIndex({ ownerTelegramId: 1, connectionId: 1, operation: 1 });
  }

  async addConnection(value: IntegrationConnection): Promise<void> {
    await this.connections.insertOne(value);
  }
  getConnection(id: string, ownerTelegramId: number): Promise<IntegrationConnection | null> {
    return this.connections.findOne({ id, ownerTelegramId });
  }
  listConnections(ownerTelegramId: number): Promise<IntegrationConnection[]> {
    return this.connections.find({ ownerTelegramId }).sort({ createdAt: -1 }).limit(100).toArray();
  }
  async revokeConnection(id: string, ownerTelegramId: number, now: Date): Promise<boolean> {
    const result = await this.connections.updateOne(
      { id, ownerTelegramId },
      { $set: { revokedAt: now } },
    );
    await this.delegations.updateMany(
      { connectionId: id, ownerTelegramId },
      { $set: { revokedAt: now } },
    );
    return result.matchedCount > 0;
  }
  async addGrant(value: IntegrationDelegation): Promise<void> {
    await this.delegations.insertOne(value);
  }
  grants(ownerTelegramId: number, scope: DelegationScope): Promise<IntegrationDelegation[]> {
    return this.delegations
      .find({ ownerTelegramId, ...scope, revokedAt: { $exists: false } })
      .limit(100)
      .toArray();
  }
  async revokeGrant(id: string, ownerTelegramId: number, now: Date): Promise<boolean> {
    const result = await this.delegations.updateOne(
      { id, ownerTelegramId },
      { $set: { revokedAt: now } },
    );
    return result.matchedCount > 0;
  }
  async claimEffect(
    effect: IntegrationEffect,
  ): Promise<{ claimed: boolean; effect: IntegrationEffect }> {
    try {
      await this.effects.insertOne(effect);
      return { claimed: true, effect };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const stored = await this.effects.findOne({ id: effect.id });
      if (!stored) throw new Error('Connector receipt disappeared');
      return { claimed: false, effect: stored };
    }
  }
  async settleEffect(
    id: string,
    state: 'complete' | 'uncertain',
    now: Date,
    result?: IntegrationResult,
  ): Promise<void> {
    const settled = await this.effects.updateOne(
      { id, state: 'pending' },
      { $set: { state, updatedAt: now, ...(result ? { result } : {}) } },
    );
    if (settled.modifiedCount !== 1) throw new Error('Connector receipt authority lost');
  }
  async eraseOwner(ownerTelegramId: number): Promise<void> {
    // Keep anonymous effect-key tombstones. The revoked connection cannot execute again; a
    // digest-only record also blocks a stale already-admitted request without retaining identity.
    await this.connections.deleteMany({ ownerTelegramId });
    await this.delegations.deleteMany({ ownerTelegramId });
    await this.effects.updateMany(
      { ownerTelegramId },
      {
        $unset: { result: '', ownerTelegramId: '', connectionId: '' },
        $set: { state: 'uncertain' },
      },
    );
  }
}
