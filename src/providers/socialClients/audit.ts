import type { SocialAccess, SocialAction, SocialPlatform } from './types.js';

export type SocialAuditOutcome =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'rate_limited'
  | 'idempotent_replay'
  | 'idempotency_conflict';

/**
 * Intentionally excludes request input/output, URLs, credential references and idempotency keys.
 */
export interface SocialAuditEvent {
  timestamp: string;
  requestId: string;
  principalId: string;
  platform: SocialPlatform;
  action: SocialAction;
  access: SocialAccess;
  accountRef?: string;
  adapterId?: string;
  outcome: SocialAuditOutcome;
  reason?: string;
  durationMs?: number;
}

export interface SocialAuditSink {
  append(event: Readonly<SocialAuditEvent>): Promise<void>;
}

/** Test/development sink. Production deployments should use an append-only durable sink. */
export class InMemorySocialAuditSink implements SocialAuditSink {
  readonly events: SocialAuditEvent[] = [];

  async append(event: Readonly<SocialAuditEvent>): Promise<void> {
    this.events.push({ ...event });
  }
}
