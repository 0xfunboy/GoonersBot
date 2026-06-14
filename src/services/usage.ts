import type { Storage } from '../storage/index.js';
import type { UsageEventInput } from '../storage/repositories/usage.js';

/** Rough token estimate (~4 chars/token) for pre-flight limit checks. */
function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

export class UsageService {
  constructor(private readonly storage: Storage) {}

  ensure(handle: string): Promise<void> {
    return this.storage.usage.ensureAndMaybeReset(handle);
  }

  /**
   * Cheap pre-flight check: estimated cost of this turn + current usage must be under the limit.
   * Image/audio inputs add a flat surcharge to the estimate.
   */
  async isUnderLimit(
    handle: string,
    text: string,
    hasImage: boolean,
    hasAudio: boolean,
  ): Promise<boolean> {
    const estimate = estimateTokens(text) + (hasImage ? 500 : 0) + (hasAudio ? 500 : 0);
    const [usage, limit] = await Promise.all([
      this.storage.usage.getUsage(handle),
      this.storage.usage.getLimit(handle),
    ]);
    return usage + estimate < limit;
  }

  getLimit(handle: string): Promise<number> {
    return this.storage.usage.getLimit(handle);
  }

  getReport(handle: string): Promise<{ usage: number; limit: number; lastReset: Date }> {
    return this.storage.usage.getReport(handle);
  }

  record(event: UsageEventInput): Promise<void> {
    return this.storage.usage.record(event);
  }
}
