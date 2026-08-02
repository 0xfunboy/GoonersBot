export type SocialIdempotencyConflictState = 'in_progress' | 'uncertain' | 'input_mismatch';

export type SocialIdempotencyClaim<T = unknown> =
  | { status: 'acquired'; fenceToken: string }
  | { status: 'replay'; value: T }
  | { status: 'conflict'; state: SocialIdempotencyConflictState };

export interface SocialIdempotencyStore {
  claim(
    key: string,
    inputDigest: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<SocialIdempotencyClaim>;
  complete(
    key: string,
    inputDigest: string,
    fenceToken: string,
    value: unknown,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean>;
  markUncertain(
    key: string,
    inputDigest: string,
    fenceToken: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean>;
  release(key: string, fenceToken: string): Promise<boolean>;
}

interface StoredClaimBase {
  inputDigest: string;
  fenceToken: string;
  expiresAtMs: number;
}

type StoredClaim =
  | (StoredClaimBase & { state: 'in_progress' | 'uncertain' })
  | (StoredClaimBase & { state: 'completed'; value: unknown });

/** Test/single-process store. Durable shared storage is mandatory before production writes. */
export class InMemorySocialIdempotencyStore implements SocialIdempotencyStore {
  private readonly claims = new Map<string, StoredClaim>();
  private nextFence = 0n;

  async claim(
    key: string,
    inputDigest: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<SocialIdempotencyClaim> {
    assertClaimTimes(expiresAtMs, nowMs);
    assertInputDigest(inputDigest);
    const existing = this.claims.get(key);
    if (existing !== undefined && existing.expiresAtMs <= nowMs) this.claims.delete(key);

    const active = this.claims.get(key);
    if (active !== undefined && active.inputDigest !== inputDigest) {
      return { status: 'conflict', state: 'input_mismatch' };
    }
    if (active?.state === 'completed') return { status: 'replay', value: active.value };
    if (active !== undefined) return { status: 'conflict', state: active.state };

    const fenceToken = String(++this.nextFence);
    this.claims.set(key, { state: 'in_progress', inputDigest, fenceToken, expiresAtMs });
    return { status: 'acquired', fenceToken };
  }

  async complete(
    key: string,
    inputDigest: string,
    fenceToken: string,
    value: unknown,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const active = this.ownedClaim(key, inputDigest, fenceToken);
    if (active?.state !== 'in_progress') return false;
    if (active.expiresAtMs <= nowMs || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
      // Keep the old fence observable so markUncertain can replace it atomically. If claim()
      // installs a newer fence first, markUncertain's ownership check prevents an overwrite.
      return false;
    }
    this.claims.set(key, {
      state: 'completed',
      inputDigest,
      fenceToken,
      value,
      expiresAtMs,
    });
    return true;
  }

  async markUncertain(
    key: string,
    inputDigest: string,
    fenceToken: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const active = this.ownedClaim(key, inputDigest, fenceToken);
    if (active?.state !== 'in_progress') return false;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return false;
    this.claims.set(key, {
      state: 'uncertain',
      inputDigest,
      fenceToken,
      expiresAtMs,
    });
    return true;
  }

  async release(key: string, fenceToken: string): Promise<boolean> {
    const active = this.claims.get(key);
    if (active?.state !== 'in_progress' || active.fenceToken !== fenceToken) return false;
    return this.claims.delete(key);
  }

  private ownedClaim(
    key: string,
    inputDigest: string,
    fenceToken: string,
  ): StoredClaim | undefined {
    const active = this.claims.get(key);
    return active?.inputDigest === inputDigest && active.fenceToken === fenceToken
      ? active
      : undefined;
  }
}

export class SocialIdempotencyConflictError extends Error {
  constructor(public readonly state: SocialIdempotencyConflictState) {
    super(
      state === 'input_mismatch'
        ? 'social write idempotency key was reused with different input'
        : `social write idempotency key is ${state}`,
    );
    this.name = 'SocialIdempotencyConflictError';
  }
}

export class SocialIdempotencyLeaseLostError extends Error {
  constructor() {
    super('social write idempotency lease expired or was superseded');
    this.name = 'SocialIdempotencyLeaseLostError';
  }
}

function assertInputDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('invalid social input digest');
}

function assertClaimTimes(expiresAtMs: number, nowMs: number): void {
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    expiresAtMs <= nowMs
  ) {
    throw new Error('invalid social idempotency claim expiry');
  }
}
