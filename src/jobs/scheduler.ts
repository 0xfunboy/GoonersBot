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
  private readonly runningJobs = new Map<string, Promise<void>>();
  private stopped = false;

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
    /** Polls followed anime series and announces new episodes; needs the bot's send API. */
    private readonly animeReleaseTick?: () => Promise<void>,
    /** Announces finished /learn development jobs so the admin never has to poll. */
    private readonly learnNotifyTick?: () => Promise<void>,
    /** Wakes the durable anime worker in case an enqueue raced the previous empty drain. */
    private readonly animeArchiveTick?: () => Promise<void>,
  ) {}

  start(): void {
    this.stopped = false;
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
          runFeedbackLearningJob(this.storage, this.lore, this.config, this.getApprovedChatIds()),
        ),
      );
    }
    if (this.config.auto.autopostEnabled && this.autopostTick) {
      const tick = this.autopostTick;
      this.every(this.config.auto.autopostIntervalMinutes * 60_000, 120_000, () =>
        this.safe('autopost', () => tick()),
      );
    }
    if (this.config.anime.follows.enabled && this.animeReleaseTick) {
      const tick = this.animeReleaseTick;
      this.every(this.config.anime.follows.pollMinutes * 60_000, 90_000, () =>
        this.safe('anime-releases', () => tick()),
      );
    }
    if (this.learnNotifyTick) {
      const tick = this.learnNotifyTick;
      // A development job is worth checking often: the admin is usually waiting for it.
      this.every(60_000, 45_000, () => this.safe('learn-notify', () => tick()));
    }
    if (this.config.auto.generatedImageAutopostEnabled && this.generatedImageTick) {
      const tick = this.generatedImageTick;
      this.every(this.config.auto.generatedImageAutopostIntervalMinutes * 60_000, 150_000, () =>
        this.safe('generated-image-autopost', () => tick()),
      );
    }
    if (this.config.animeArchive.enabled && this.animeArchiveTick) {
      const tick = this.animeArchiveTick;
      this.every(30_000, 5_000, () => this.safe('anime-archive', () => tick()));
    }
    log.info(
      {
        generatedImageAutopostEnabled: this.config.auto.generatedImageAutopostEnabled,
        animeFollowsEnabled: this.config.anime.follows.enabled,
        animeArchiveEnabled: this.config.animeArchive.enabled,
      },
      'scheduler started (cleanup + mining + feedback + autopost + anime releases)',
    );
  }

  private every(intervalMs: number, firstDelayMs: number, fn: () => void | Promise<void>): void {
    const first = setTimeout(() => {
      if (!this.stopped) void fn();
    }, firstDelayMs);
    first.unref();
    const interval = setInterval(() => {
      if (!this.stopped) void fn();
    }, intervalMs);
    interval.unref();
    this.timers.push(first, interval);
  }

  private safe(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.runningJobs.has(name)) {
      log.debug({ job: name }, 'scheduled job still running; overlapping tick skipped');
      return Promise.resolve();
    }
    const run = Promise.resolve()
      .then(fn)
      .catch((err) => log.error({ err, job: name }, 'scheduled job failed'))
      .finally(() => this.runningJobs.delete(name));
    this.runningJobs.set(name, run);
    return run;
  }

  /** Cancels initial/periodic ticks and waits for storage-using work already in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    await Promise.allSettled([...this.runningJobs.values()]);
  }
}
