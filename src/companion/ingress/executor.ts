import { childLogger } from '../../utils/logger.js';

const log = childLogger('companion-ingress');

export class QueueCapacityError extends Error {
  constructor(readonly capacity: number) {
    super(`Telegram ingress queue capacity (${capacity}) reached`);
    this.name = 'QueueCapacityError';
  }
}

/**
 * Small in-process scheduler used after the durable inbox has acknowledged an update.
 *
 * Work from one conversation is serialized, while unrelated chats share a bounded global
 * semaphore. A failed update never poisons the next item in the same conversation.
 */
export class ConversationExecutor {
  private readonly tails = new Map<string, Promise<void>>();
  private active = 0;
  private pending = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error('ConversationExecutor concurrency must be a positive integer');
    }
    if (!Number.isSafeInteger(maxPending) || maxPending < concurrency) {
      throw new Error('ConversationExecutor maxPending must be >= concurrency');
    }
  }

  get pendingCount(): number {
    return this.pending;
  }

  get activeCount(): number {
    return this.active;
  }

  enqueue(key: string, task: () => Promise<void>): Promise<void> {
    if (this.pending >= this.maxPending) throw new QueueCapacityError(this.maxPending);
    this.pending += 1;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        await this.acquire();
        this.active += 1;
        try {
          await task();
        } finally {
          this.active -= 1;
          this.release();
        }
      })
      .finally(() => {
        this.pending -= 1;
        if (this.tails.get(key) === run) this.tails.delete(key);
      });
    this.tails.set(key, run);
    return run;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
  }

  reportFailure(error: unknown, context: Record<string, unknown>): void {
    log.error({ err: error, ...context }, 'detached Telegram update failed');
  }

  async drain(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(100, deadline - Date.now())),
      );
    }
    if (this.pending > 0) {
      log.warn({ pending: this.pending, active: this.active }, 'ingress drain deadline reached');
    }
  }
}
