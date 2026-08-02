import {
  SOCIAL_PLATFORMS,
  type SocialAction,
  type SocialPlatform,
  type SocialReadAction,
  type SocialWriteAction,
} from './types.js';

export interface SocialRateLimitRule {
  maxAttempts: number;
  windowMs: number;
}

export interface SocialPolicyConfig {
  allowedPrincipals: readonly string[];
  allowedPlatforms: readonly SocialPlatform[];
  allowedReadActions: readonly SocialReadAction[];
  write: {
    enabled: boolean;
    allowedActions: readonly SocialWriteAction[];
    allowedAccountRefs: readonly string[];
  };
  rateLimits?: Partial<Record<SocialAction, SocialRateLimitRule>>;
}

export interface SocialPolicySubject {
  principalId: string;
  platform: SocialPlatform;
  action: SocialAction;
  access: 'read' | 'write';
  accountRef?: string;
}

export type SocialPolicyDenialReason =
  | 'principal_not_allowed'
  | 'platform_not_allowed'
  | 'read_action_not_allowed'
  | 'write_disabled'
  | 'write_action_not_allowed'
  | 'write_account_not_allowed';

export class SocialPolicyDeniedError extends Error {
  constructor(public readonly reason: SocialPolicyDenialReason) {
    super(`social client policy denied the request: ${reason}`);
    this.name = 'SocialPolicyDeniedError';
  }
}

export class SocialRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`social client rate limit exceeded; retry in ${retryAfterMs}ms`);
    this.name = 'SocialRateLimitError';
  }
}

interface RateBucket {
  hits: number[];
}

/** Process-local limiter. Replace it with a shared implementation before multi-instance posting. */
export class SocialPolicyEngine {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(private readonly config: Readonly<SocialPolicyConfig>) {
    validatePolicy(config);
  }

  assertAllowed(subject: SocialPolicySubject): void {
    if (!this.config.allowedPrincipals.includes(subject.principalId)) {
      throw new SocialPolicyDeniedError('principal_not_allowed');
    }
    if (!this.config.allowedPlatforms.includes(subject.platform)) {
      throw new SocialPolicyDeniedError('platform_not_allowed');
    }

    if (subject.access === 'read') {
      if (!this.config.allowedReadActions.includes(subject.action as SocialReadAction)) {
        throw new SocialPolicyDeniedError('read_action_not_allowed');
      }
      return;
    }

    if (!this.config.write.enabled) {
      throw new SocialPolicyDeniedError('write_disabled');
    }
    if (!this.config.write.allowedActions.includes(subject.action as SocialWriteAction)) {
      throw new SocialPolicyDeniedError('write_action_not_allowed');
    }
    if (
      subject.accountRef === undefined ||
      !this.config.write.allowedAccountRefs.includes(subject.accountRef)
    ) {
      throw new SocialPolicyDeniedError('write_account_not_allowed');
    }
  }

  consumeRateLimit(subject: SocialPolicySubject, nowMs: number = Date.now()): void {
    const rule = this.config.rateLimits?.[subject.action];
    if (rule === undefined) return;

    const key = JSON.stringify([
      subject.principalId,
      subject.platform,
      subject.action,
      subject.accountRef ?? '',
    ]);
    const cutoff = nowMs - rule.windowMs;
    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((hit) => hit > cutoff);

    if (bucket.hits.length >= rule.maxAttempts) {
      const oldest = bucket.hits[0] ?? nowMs;
      throw new SocialRateLimitError(Math.max(1, oldest + rule.windowMs - nowMs));
    }

    bucket.hits.push(nowMs);
    this.buckets.set(key, bucket);
  }
}

/** Explicitly inert default: callers must opt principals, platforms and actions in. */
export const DENY_ALL_SOCIAL_POLICY: Readonly<SocialPolicyConfig> = Object.freeze({
  allowedPrincipals: Object.freeze([]),
  allowedPlatforms: Object.freeze([]),
  allowedReadActions: Object.freeze([]),
  write: Object.freeze({
    enabled: false,
    allowedActions: Object.freeze([]),
    allowedAccountRefs: Object.freeze([]),
  }),
});

function validatePolicy(config: Readonly<SocialPolicyConfig>): void {
  const invalidPlatform = config.allowedPlatforms.find(
    (platform) => !SOCIAL_PLATFORMS.includes(platform),
  );
  if (invalidPlatform !== undefined) throw new Error(`invalid social platform: ${invalidPlatform}`);

  for (const [action, rule] of Object.entries(config.rateLimits ?? {})) {
    if (!Number.isSafeInteger(rule.maxAttempts) || rule.maxAttempts <= 0) {
      throw new Error(`invalid maxAttempts for ${action}`);
    }
    if (!Number.isSafeInteger(rule.windowMs) || rule.windowMs <= 0) {
      throw new Error(`invalid windowMs for ${action}`);
    }
  }
}
