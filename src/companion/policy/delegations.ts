import { z } from 'zod';

export const delegationScopeSchema = z
  .object({
    connectionId: z.string().uuid(),
    operation: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
    resource: z.string().min(1).max(240),
    recipient: z.string().min(1).max(240),
  })
  .strict();

export type DelegationScope = z.infer<typeof delegationScopeSchema>;

export interface IntegrationDelegation extends DelegationScope {
  id: string;
  ownerTelegramId: number;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

/** Exact equality deliberately excludes wildcard resources, changed recipients and implied consent. */
export function delegationAllows(
  grant: IntegrationDelegation,
  ownerTelegramId: number,
  requested: DelegationScope,
  now = new Date(),
): boolean {
  return (
    grant.ownerTelegramId === ownerTelegramId &&
    !grant.revokedAt &&
    grant.expiresAt.getTime() > now.getTime() &&
    grant.connectionId === requested.connectionId &&
    grant.operation === requested.operation &&
    grant.resource === requested.resource &&
    grant.recipient === requested.recipient
  );
}

export function assertImmutableOwner(ownerTelegramId: number): void {
  if (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0) {
    throw new Error('An immutable Telegram user ID is required');
  }
}
