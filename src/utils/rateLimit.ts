/**
 * Lightweight in-memory cooldown / rate-limit helpers used for anti-spam and autoengage pacing.
 *
 * These are intentionally in-memory: they reset on restart, which is the correct behaviour for
 * short-lived cooldowns. Durable per-hour caps are derived from persisted message counts.
 */

/** Tracks the last allowed timestamp per key and enforces a minimum interval. */
export class Cooldown {
  private readonly last = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  /** Returns true if the action is allowed now; records the time when allowed. */
  tryAcquire(key: string, now: number = Date.now()): boolean {
    if (this.intervalMs <= 0) return true;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.intervalMs) return false;
    this.last.set(key, now);
    return true;
  }

  /** Check whether the key is ready WITHOUT recording an action. */
  isReady(key: string, now: number = Date.now()): boolean {
    return this.remainingMs(key, now) === 0;
  }

  /** Milliseconds remaining before the key is allowed again (0 if allowed now). */
  remainingMs(key: string, now: number = Date.now()): number {
    const prev = this.last.get(key);
    if (prev === undefined) return 0;
    const elapsed = now - prev;
    return elapsed >= this.intervalMs ? 0 : this.intervalMs - elapsed;
  }

  /** Record an action time without checking (e.g. after a successful reply). */
  mark(key: string, now: number = Date.now()): void {
    this.last.set(key, now);
  }

  reset(key?: string): void {
    if (key === undefined) this.last.clear();
    else this.last.delete(key);
  }
}

/** Sliding-window counter for "max N per window" limits (e.g. replies per hour per chat). */
export class SlidingWindowCounter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  private prune(key: string, now: number): number[] {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, arr);
    return arr;
  }

  count(key: string, now: number = Date.now()): number {
    return this.prune(key, now).length;
  }

  isUnderLimit(key: string, now: number = Date.now()): boolean {
    if (this.max <= 0) return true;
    return this.prune(key, now).length < this.max;
  }

  record(key: string, now: number = Date.now()): void {
    const arr = this.prune(key, now);
    arr.push(now);
    this.hits.set(key, arr);
  }
}
