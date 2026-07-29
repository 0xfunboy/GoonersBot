import type { AppConfig } from '../config/index.js';
import type { Storage } from '../storage/index.js';
import type { LoreEngine } from '../memory/loreEngine.js';
import { childLogger } from '../utils/logger.js';
import { runRetentionCleanup } from './cleanup.js';
import { runMemoryMiningJob } from './memoryMiningJob.js';
import { runFeedbackLearningJob } from './feedbackLearningJob.js';
import type { SocialLearningPipeline } from '../social/index.js';

const log = childLogger('scheduler');

/**
 * In-process scheduler (setInterval; no external cron/queue). Runs:
 *  - hourly retention cleanup
 *  - background memory mining (always-on for started chats, dedicated quota-independent model)
 *  - feedback learning (scores recent replies, adapts memory salience)
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private readonly runningJobs = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly lore: LoreEngine,
    /** optional autonomous-posting tick (sends unprompted posts); needs the bot's send API */
    private readonly autopostTick?: () => Promise<void>,
    /** independent generated-image posting tick; intentionally has separate enablement/pace */
    private readonly generatedImageTick?: () => Promise<void>,
    /** evolving people/relationship/community model, mined beside durable lore */
    private readonly socialLearning?: SocialLearningPipeline,
    /** Runtime approval store; evaluated on every tick so revocations take effect immediately. */
    private readonly getApprovedChatIds: () => readonly number[] = () => [],
  ) {}

  start(): void {
    this.every(60 * 60 * 1000, 30_000, () =>
      this.safe('cleanup', () =>
        runRetentionCleanup(this.storage, this.config.env.MESSAGE_HISTORY_RETENTION_DAYS),
      ),
    );

    if (this.config.env.MEMORY_MINING_ENABLED) {
      this.every(this.config.env.MEMORY_MINING_INTERVAL_SECONDS * 1000, 60_000, () =>
        this.safe('mining', () =>
          runMemoryMiningJob(
            this.storage,
            this.lore,
            this.config,
            this.socialLearning,
            this.getApprovedChatIds(),
          ),
        ),
      );
    }
    if (this.config.env.FEEDBACK_LEARNING_ENABLED) {
      this.every(90_000, 75_000, () =>
        this.safe('feedback', () =>
          runFeedbackLearningJob(
            this.storage,
            this.lore,
            this.config,
            this.getApprovedChatIds(),
          ),
        ),
      );
    }
    if (this.config.auto.autopostEnabled && this.autopostTick) {
      const tick = this.autopostTick;
      this.every(this.config.auto.autopostIntervalMinutes * 60_000, 120_000, () =>
        this.safe('autopost', () => tick()),
      );
    }
    if (this.config.auto.generatedImageAutopostEnabled && this.generatedImageTick) {
      const tick = this.generatedImageTick;
      this.every(this.config.auto.generatedImageAutopostIntervalMinutes * 60_000, 150_000, () =>
        this.safe('generated-image-autopost', () => tick()),
      );
    }
    log.info(
      { generatedImageAutopostEnabled: this.config.auto.generatedImageAutopostEnabled },
      'scheduler started (cleanup + mining + feedback + autopost)',
    );
  }

  private every(intervalMs: number, firstDelayMs: number, fn: () => void): void {
    setTimeout(fn, firstDelayMs).unref();
    const t = setInterval(fn, intervalMs);
    t.unref();
    this.timers.push(t);
  }

  private async safe(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.runningJobs.has(name)) {
      log.debug({ job: name }, 'scheduled job still running; overlapping tick skipped');
      return;
    }
    this.runningJobs.add(name);
    try {
      await fn();
    } catch (err) {
      log.error({ err, job: name }, 'scheduled job failed');
    } finally {
      this.runningJobs.delete(name);
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
