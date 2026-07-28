import { abortableDelay, throwIfAborted } from '../../utils/abort.js';
import type { ChatRequest } from './types.js';

const WINDOW_MS = 60_000;
const APPROXIMATE_BYTES_PER_TOKEN = 3;
const MESSAGE_OVERHEAD_TOKENS = 12;
const REQUEST_OVERHEAD_TOKENS = 32;
export const DEFAULT_MINING_OUTPUT_TOKEN_RESERVE = 2_048;

export interface MiningPacerOptions {
  maxRequestsPerMinute: number;
  maxTokensPerMinute: number;
}

interface PacedRequestOptions {
  /** Checked while this request owns the queue, before a rate-limit slot is consumed. */
  beforeStart?: () => void;
  /** Conservative input estimate plus the request's reserved output budget. */
  estimatedTokens: number;
  signal?: AbortSignal;
}

interface TokenReservation {
  startedAt: number;
  tokens: number;
}

/**
 * Raised before an HTTP request is dispatched when that request can never fit in the configured
 * one-minute mining budget. Callers must shrink/chunk the mining window rather than retry it.
 */
export class MiningTokenBudgetExceededError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly maxTokensPerMinute: number,
  ) {
    super(
      `mining request estimated at ${estimatedTokens} tokens exceeds the ` +
        `${maxTokensPerMinute} token/minute budget; request was not sent`,
    );
    this.name = 'MiningTokenBudgetExceededError';
  }
}

/**
 * Conservative tokenizer-independent preflight estimate for Gemma mining requests.
 *
 * UTF-8 bytes / 3 intentionally overestimates ordinary Italian/English text compared with the
 * usual chars / 4 heuristic. Framing overhead is charged per message and a bounded output is
 * always reserved, so a request cannot consume the whole TPM allowance with input alone.
 */
export function estimateMiningRequestTokens(
  req: ChatRequest,
  defaultOutputReserveTokens = DEFAULT_MINING_OUTPUT_TOKEN_RESERVE,
): number {
  if (!Number.isInteger(defaultOutputReserveTokens) || defaultOutputReserveTokens < 1) {
    throw new Error('mining defaultOutputReserveTokens must be an integer >= 1');
  }
  const contents = [req.system ?? '', ...req.messages.map((message) => message.content)];
  const bytes = contents.reduce((total, content) => total + Buffer.byteLength(content, 'utf8'), 0);
  const framedMessages = req.messages.length + (req.system ? 1 : 0);
  const inputTokens =
    Math.ceil(bytes / APPROXIMATE_BYTES_PER_TOKEN) +
    framedMessages * MESSAGE_OVERHEAD_TOKENS +
    REQUEST_OVERHEAD_TOKENS;
  const outputTokens =
    req.maxTokens === undefined
      ? defaultOutputReserveTokens
      : Math.max(1, Math.ceil(req.maxTokens));
  return inputTokens + outputTokens;
}

/**
 * Process-local FIFO gate for the dedicated continuous-mining provider.
 *
 * It deliberately combines four constraints:
 * - one request in flight at a time;
 * - evenly distributed starts (ceil(60s / RPM));
 * - an exact sliding-window cap as a guard against clock/timer jitter.
 * - a sliding-window estimated-token budget, including reserved output.
 *
 * The gate wraps the provider's `chatCompletion`, so structured-output retries and repairs consume
 * their own paced slots just like first attempts.
 */
export class MiningRequestPacer {
  private readonly maxRequestsPerMinute: number;
  private readonly maxTokensPerMinute: number;
  private readonly minimumStartGapMs: number;
  private readonly reservations: TokenReservation[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(options: MiningPacerOptions) {
    if (!Number.isInteger(options.maxRequestsPerMinute) || options.maxRequestsPerMinute < 1) {
      throw new Error('mining maxRequestsPerMinute must be an integer >= 1');
    }
    if (!Number.isInteger(options.maxTokensPerMinute) || options.maxTokensPerMinute < 1) {
      throw new Error('mining maxTokensPerMinute must be an integer >= 1');
    }
    this.maxRequestsPerMinute = options.maxRequestsPerMinute;
    this.maxTokensPerMinute = options.maxTokensPerMinute;
    this.minimumStartGapMs = Math.ceil(WINDOW_MS / options.maxRequestsPerMinute);
  }

  run<T>(
    request: () => Promise<T>,
    { beforeStart, estimatedTokens, signal }: PacedRequestOptions,
  ): Promise<T> {
    throwIfAborted(signal);
    if (!Number.isInteger(estimatedTokens) || estimatedTokens < 1) {
      return Promise.reject(new Error('mining estimatedTokens must be an integer >= 1'));
    }
    if (estimatedTokens > this.maxTokensPerMinute) {
      return Promise.reject(
        new MiningTokenBudgetExceededError(estimatedTokens, this.maxTokensPerMinute),
      );
    }

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
        await this.waitForSlot(estimatedTokens, signal);
        throwIfAborted(signal);
        beforeStart?.();
        this.noteStart(Date.now(), estimatedTokens);
        return await request();
      } finally {
        release();
      }
    })();
  }

  private async waitForSlot(estimatedTokens: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.prune(now);
      const previousStart = this.reservations.at(-1)?.startedAt;
      const spacingDelay =
        previousStart === undefined ? 0 : previousStart + this.minimumStartGapMs - now;
      const windowDelay =
        this.reservations.length < this.maxRequestsPerMinute
          ? 0
          : (this.reservations[0]?.startedAt ?? now) + WINDOW_MS - now;
      const tokenDelay = this.tokenBudgetDelay(now, estimatedTokens);
      const delay = Math.max(0, spacingDelay, windowDelay, tokenDelay);
      if (delay === 0) return;
      await abortableDelay(delay, signal);
    }
  }

  private tokenBudgetDelay(now: number, estimatedTokens: number): number {
    const reservedTokens = this.reservations.reduce(
      (total, reservation) => total + reservation.tokens,
      0,
    );
    let tokensToRelease = reservedTokens + estimatedTokens - this.maxTokensPerMinute;
    if (tokensToRelease <= 0) return 0;

    for (const reservation of this.reservations) {
      tokensToRelease -= reservation.tokens;
      if (tokensToRelease <= 0) return reservation.startedAt + WINDOW_MS - now;
    }
    // Oversized requests are rejected before entering the queue, so this is unreachable. Returning
    // one window is nevertheless a safe finite fallback if state is ever corrupted.
    return WINDOW_MS;
  }

  private noteStart(now: number, estimatedTokens: number): void {
    this.prune(now);
    this.reservations.push({ startedAt: now, tokens: estimatedTokens });
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while ((this.reservations[0]?.startedAt ?? Number.POSITIVE_INFINITY) <= cutoff) {
      this.reservations.shift();
    }
  }
}
