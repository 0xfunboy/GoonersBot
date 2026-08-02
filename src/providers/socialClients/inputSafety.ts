import { createHash } from 'node:crypto';

const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 10_000;
const MAX_INPUT_TEXT_UNITS = 2 * 1024 * 1024;
const MAX_INPUT_KEY_LENGTH = 256;

const FORBIDDEN_NORMALIZED_KEYS = new Set([
  'apikey',
  'apisecret',
  'authorization',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'cookie',
  'cookieheader',
  'cookies',
  'credential',
  'credentialref',
  'credentials',
  'csrftoken',
  'idtoken',
  'passphrase',
  'passwd',
  'password',
  'privatekey',
  'proxyauthorization',
  'pwd',
  'refreshtoken',
  'secret',
  'sessionid',
  'sessiontoken',
  'setcookie',
  'token',
  'xcsrftoken',
  'xsrftoken',
]);

const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_KEY_MARKERS = [
  'apikey',
  'apitoken',
  'authorization',
  'clientsecret',
  'cookie',
  'credential',
  'passphrase',
  'passwd',
  'password',
  'privatekey',
  'secret',
] as const;

export class InlineSocialCredentialError extends Error {
  constructor(message = 'inline credentials are forbidden in social request input') {
    super(message);
    this.name = 'InlineSocialCredentialError';
  }
}

export class InvalidSocialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSocialInputError';
  }
}

interface CloneState {
  nodes: number;
  textUnits: number;
  ancestors: Set<object>;
}

export interface PreparedSocialInput<T> {
  /** Detached, deeply frozen JSON-compatible snapshot safe to pass across an async boundary. */
  input: T;
  /** SHA-256 over a key-sorted canonical JSON representation of the snapshot. */
  digest: string;
}

/** Reject secret-bearing/non-JSON structures and detach input from subsequent caller mutations. */
export function prepareSocialInput<T>(value: T): PreparedSocialInput<T> {
  const input = cloneValue(value, 0, {
    nodes: 0,
    textUnits: 0,
    ancestors: new Set<object>(),
  }) as T;
  const canonical = canonicalJson(input);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return { input, digest };
}

export function cloneAndFreezeSocialInput<T>(value: T): T {
  return prepareSocialInput(value).input;
}

function cloneValue(value: unknown, depth: number, state: CloneState): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_INPUT_NODES) throw new InvalidSocialInputError('social input is too large');
  if (depth > MAX_INPUT_DEPTH)
    throw new InvalidSocialInputError('social input is too deeply nested');

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new InvalidSocialInputError('social input number is invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string') {
    state.textUnits += value.length;
    if (state.textUnits > MAX_INPUT_TEXT_UNITS) {
      throw new InvalidSocialInputError('social input text is too large');
    }
    assertStringContainsNoInlineCredential(value);
    return value;
  }
  if (typeof value !== 'object') {
    throw new InvalidSocialInputError('social input must contain only JSON-compatible values');
  }
  if (state.ancestors.has(value))
    throw new InvalidSocialInputError('social input cannot be cyclic');
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) return cloneArray(value, depth, state);
    return cloneRecord(value, depth, state);
  } finally {
    state.ancestors.delete(value);
  }
}

function cloneArray(value: unknown[], depth: number, state: CloneState): readonly unknown[] {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        (key !== 'length' && (!/^\d+$/u.test(key) || Number(key) >= value.length)),
    )
  ) {
    throw new InvalidSocialInputError('social input arrays cannot have custom properties');
  }
  const clone: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new InvalidSocialInputError('social input arrays cannot be sparse');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      throw new InvalidSocialInputError('social input cannot contain accessors');
    }
    clone.push(cloneValue(descriptor.value, depth + 1, state));
  }
  return Object.freeze(clone);
}

function cloneRecord(
  value: object,
  depth: number,
  state: CloneState,
): Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidSocialInputError('social input objects must be plain records');
  }
  const clone: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      throw new InvalidSocialInputError('social input keys must be strings');
    if (key.length < 1 || key.length > MAX_INPUT_KEY_LENGTH) {
      throw new InvalidSocialInputError('social input key length is invalid');
    }
    if (DANGEROUS_OBJECT_KEYS.has(key)) {
      throw new InvalidSocialInputError('social input contains a dangerous object key');
    }
    assertKeyIsNotCredential(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new InvalidSocialInputError('social input cannot contain hidden fields or accessors');
    }
    clone[key] = cloneValue(descriptor.value, depth + 1, state);
  }
  return Object.freeze(clone);
}

function assertKeyIsNotCredential(key: string): void {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (
    FORBIDDEN_NORMALIZED_KEYS.has(normalized) ||
    FORBIDDEN_KEY_MARKERS.some((marker) => normalized.includes(marker)) ||
    normalized.startsWith('token') ||
    normalized.endsWith('token')
  ) {
    throw new InlineSocialCredentialError();
  }
}

function assertStringContainsNoInlineCredential(value: string): void {
  if (/^(?:basic|bearer)\s+\S+/iu.test(value.trim())) throw new InlineSocialCredentialError();
  if (!/^https?:\/\//iu.test(value.trim())) return;
  try {
    const url = new URL(value);
    if (url.username || url.password) throw new InlineSocialCredentialError();
  } catch (error) {
    if (error instanceof InlineSocialCredentialError) throw error;
    // An invalid URL-shaped application string is the adapter's concern, not a credential leak.
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
