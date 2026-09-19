import type { SocialCredentialReference } from '../providers/socialClients/types.js';
import type { DelegationScope, IntegrationDelegation } from '../companion/policy/delegations.js';

export interface IntegrationConnection {
  id: string;
  ownerTelegramId: number;
  provider: string;
  accountId: string;
  credentialRef: SocialCredentialReference;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface IntegrationRequest extends DelegationScope {
  requestKey: string;
  input: Readonly<Record<string, unknown>>;
}

export interface IntegrationResult {
  summary: string;
  verified: boolean;
  data?: Readonly<Record<string, unknown>>;
  receipt?: { provider: string; externalId: string; recipient: string; timestamp: string };
}

export interface IntegrationAdapter {
  readonly id: string;
  readonly operations: readonly {
    id: string;
    effect: 'read' | 'draft' | 'send';
    description: string;
  }[];
  accepts(connection: Pick<IntegrationConnection, 'accountId' | 'credentialRef'>): boolean;
  execute(
    connection: IntegrationConnection,
    request: IntegrationRequest,
    signal?: AbortSignal,
  ): Promise<IntegrationResult>;
}

export interface IntegrationEffect {
  id: string;
  ownerTelegramId: number;
  connectionId: string;
  digest: string;
  state: 'pending' | 'complete' | 'uncertain';
  createdAt: Date;
  updatedAt: Date;
  result?: IntegrationResult;
}

export interface IntegrationRepository {
  addConnection(value: IntegrationConnection): Promise<void>;
  getConnection(id: string, ownerTelegramId: number): Promise<IntegrationConnection | null>;
  listConnections(ownerTelegramId: number): Promise<IntegrationConnection[]>;
  revokeConnection(id: string, ownerTelegramId: number, now: Date): Promise<boolean>;
  addGrant(value: IntegrationDelegation): Promise<void>;
  grants(ownerTelegramId: number, scope: DelegationScope): Promise<IntegrationDelegation[]>;
  revokeGrant(id: string, ownerTelegramId: number, now: Date): Promise<boolean>;
  claimEffect(effect: IntegrationEffect): Promise<{ claimed: boolean; effect: IntegrationEffect }>;
  settleEffect(
    id: string,
    state: 'complete' | 'uncertain',
    now: Date,
    result?: IntegrationResult,
  ): Promise<void>;
  eraseOwner(ownerTelegramId: number): Promise<void>;
}
