import { abortableDelay, throwIfAborted } from '../../utils/abort.js';

const WINDOW_MS = 60_000;

export interface MiningPacerOptions {
  maxRequestsPerMinute: number;
}

interface PacedRequestOptions {
  /** Checked while this request owns the queue, before a rate-limit slot is consumed. */
  beforeStart?: () => void;
  signal?: AbortSignal;
}

/**
 * Process-local FIFO gate for the dedicated continuous-mining provider.
 *
 * It deliberately combines three constraints:
 * - one request in flight at a time;
 * - evenly distributed starts (ceil(60s / RPM));
 * - an exact sliding-window cap as a guard against clock/timer jitter.
 *
 * The gate wraps the provider's `chatCompletion`, so structured-output retries and repairs consume
 * their own paced slots just like first attempts.
 */
export class MiningRequestPacer {
  private readonly maxRequestsPerMinute: number;
  private readonly minimumStartGapMs: number;
  private readonly starts: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(options: MiningPacerOptions) {
    if (!Number.isInteger(options.maxRequestsPerMinute) || options.maxRequestsPerMinute < 1) {
      throw new Error('mining maxRequestsPerMinute must be an integer >= 1');
    }
    this.maxRequestsPerMinute = options.maxRequestsPerMinute;
    this.minimumStartGapMs = Math.ceil(WINDOW_MS / options.maxRequestsPerMinute);
  }

  run<T>(request: () => Promise<T>, { beforeStart, signal }: PacedRequestOptions = {}): Promise<T> {
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      // A queued cancellation cannot release its ticket early: successors must never overtake it
      // while the predecessor is still in flight.
      await predecessor;
      try {
        throwIfAborted(signal);
        beforeStart?.();
        await this.waitForSlot(signal);
        throwIfAborted(signal);
        beforeStart?.();
        this.noteStart(Date.now());
        return await request();
      } finally {
        release();
      }
    })();
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.prune(now);
      const previousStart = this.starts.at(-1);
      const spacingDelay =
        previousStart === undefined ? 0 : previousStart + this.minimumStartGapMs - now;
      const windowDelay =
        this.starts.length < this.maxRequestsPerMinute
          ? 0
          : (this.starts[0] ?? now) + WINDOW_MS - now;
      const delay = Math.max(0, spacingDelay, windowDelay);
      if (delay === 0) return;
      await abortableDelay(delay, signal);
    }
  }

  private noteStart(now: number): void {
    this.prune(now);
    this.starts.push(now);
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while ((this.starts[0] ?? Number.POSITIVE_INFINITY) <= cutoff) this.starts.shift();
  }
}
