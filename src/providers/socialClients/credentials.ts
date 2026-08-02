import type { SocialCredentialReference } from './types.js';

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;
const REFERENCE_PART = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u;

export class InvalidSocialCredentialReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSocialCredentialReferenceError';
  }
}

/**
 * Rejects inline/unknown fields as well as malformed references. This makes accidentally passing
 * `{ password: ... }`, a cookie value, or a token fail before an adapter or audit sink sees it.
 */
export function assertSafeCredentialReference(value: SocialCredentialReference): void {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidSocialCredentialReferenceError('credential reference must be an object');
  }
  const record = value as SocialCredentialReference & Record<string, unknown>;

  if (record.kind === 'cookie_jar') {
    assertExactKeys(record, ['kind', 'pathEnv']);
    if (typeof record.pathEnv !== 'string' || !ENV_NAME.test(record.pathEnv)) {
      throw new InvalidSocialCredentialReferenceError(
        'cookie_jar.pathEnv must name an environment variable, not contain a path or secret',
      );
    }
    return;
  }

  if (record.kind === 'secret_store') {
    assertExactKeys(record, ['kind', 'provider', 'secretId', 'version']);
    if (
      typeof record.provider !== 'string' ||
      typeof record.secretId !== 'string' ||
      !REFERENCE_PART.test(record.provider) ||
      !REFERENCE_PART.test(record.secretId)
    ) {
      throw new InvalidSocialCredentialReferenceError(
        'secret_store must contain opaque provider and secret identifiers',
      );
    }
    if (
      record.version !== undefined &&
      (typeof record.version !== 'string' || !REFERENCE_PART.test(record.version))
    ) {
      throw new InvalidSocialCredentialReferenceError('secret_store.version is invalid');
    }
    return;
  }

  throw new InvalidSocialCredentialReferenceError('unknown credential reference kind');
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new InvalidSocialCredentialReferenceError(
      'credential reference contains forbidden fields',
    );
  }
}
