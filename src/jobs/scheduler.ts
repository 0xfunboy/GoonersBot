import type { AppConfig } from '../config/index.js';
import type { Storage } from '../storage/index.js';
import { childLogger } from '../utils/logger.js';
import { runRetentionCleanup } from './cleanup.js';

const log = childLogger('scheduler');

/**
 * Minimal in-process scheduler. Runs periodic maintenance jobs on a fixed interval.
 * Kept dependency-free (setInterval) — no external cron/queue needed for these light tasks.
 *
 * Note: automatic fact extraction is performed inline on engaged replies (when /autofact is on),
 * mirroring the original. A periodic batch sweep is intentionally not run blindly over all chats
 * to avoid spending tokens unprompted; the inline path is the durable mechanism.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
  ) {}

  start(): void {
    // Run cleanup hourly (and once shortly after boot).
    const intervalMs = 60 * 60 * 1000;
    const tick = () => {
      void this.runMaintenance();
    };
    setTimeout(tick, 30_000).unref();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    log.info('scheduler started (hourly maintenance)');
  }

  private async runMaintenance(): Promise<void> {
    try {
      await runRetentionCleanup(this.storage, this.config.env.MESSAGE_HISTORY_RETENTION_DAYS);
    } catch (err) {
      log.error({ err }, 'maintenance run failed');
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
