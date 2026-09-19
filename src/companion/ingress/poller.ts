import type { Update } from 'grammy/types';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('companion-ingress-poller');

export interface PollRequest {
  offset?: number;
  limit: number;
  timeout: number;
  allowed_updates?: ReadonlyArray<Exclude<keyof Update, 'update_id'>>;
}

export interface DurableTelegramPollerOptions {
  fetchUpdates: (request: PollRequest, signal: AbortSignal) => Promise<Update[]>;
  admit: (update: Update) => Promise<void>;
  onAdmitted: () => void;
  onFatal?: (error: unknown) => void;
  retryMs?: number;
}

const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'message_reaction',
  'my_chat_member',
] as const;

/** Long polling whose offset advances only after a durable inbox admission succeeds. */
export class DurableTelegramPoller {
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: DurableTelegramPollerOptions) {}

  start(): void {
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.loop(this.controller.signal)
      .catch((error) => {
        if (!this.controller?.signal.aborted) {
          log.fatal({ err: error }, 'durable Telegram polling stopped unexpectedly');
          this.options.onFatal?.(error);
        }
      })
      .finally(() => {
        this.running = null;
      });
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running;
    this.controller = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let offset: number | undefined;
    let includeAllowedUpdates = true;
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await this.options.fetchUpdates(
          {
            ...(offset === undefined ? {} : { offset }),
            limit: 100,
            timeout: 30,
            ...(includeAllowedUpdates ? { allowed_updates: ALLOWED_UPDATES } : {}),
          },
          signal,
        );
        includeAllowedUpdates = false;
      } catch (error) {
        if (signal.aborted) return;
        const errorCode = (error as { error_code?: unknown } | null)?.error_code;
        if (errorCode === 401 || errorCode === 409) throw error;
        log.warn({ err: error }, 'Telegram getUpdates failed; preserving durable offset');
        await this.delay(this.options.retryMs ?? 1_000, signal);
        continue;
      }

      let admissionBlocked = false;
      for (const update of updates) {
        try {
          await this.options.admit(update);
        } catch (error) {
          admissionBlocked = true;
          log.warn(
            { err: error, updateId: update.update_id },
            'Telegram update was not acknowledged because durable admission failed',
          );
          break;
        }
        offset = Math.max(offset ?? 0, update.update_id + 1);
        this.options.onAdmitted();
      }
      if (admissionBlocked) await this.delay(this.options.retryMs ?? 1_000, signal);
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const abort = (): void => done();
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve();
      }
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
