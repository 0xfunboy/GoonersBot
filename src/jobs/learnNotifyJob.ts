import type { LocalDevelopmentService } from '../capabilities/localDevelopmentService.js';
import type { LocalDevelopmentJob } from '../capabilities/localDevelopmentJobs.js';
import type { Storage } from '../storage/index.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('learn-notify');

const KIND = 'local_development';

/** Delivery callback; false means "not delivered" and releases the claim for the next tick. */
export type LearnNotifier = (notification: LearnNotification) => Promise<boolean>;

export interface LearnNotification {
  chatId: number;
  job: LocalDevelopmentJob;
  /** Ready-to-run next command, already shortened. */
  nextCommand?: string | undefined;
}

export interface LearnNotifyResult {
  inspected: number;
  notified: number;
}

/**
 * Announce finished `/learn code` jobs instead of making the admin poll for them.
 *
 * A build can take minutes; before this, it finished silently and the only way to find out was to
 * keep typing `/learn status`. The claim is taken before sending and released on failure, so the
 * worst case is a retried notification, never a duplicated one.
 */
export async function runLearnNotifyJob(
  localDevelopment: Pick<LocalDevelopmentService, 'enabled' | 'listTerminal'>,
  storage: Storage,
  notify: LearnNotifier,
): Promise<LearnNotifyResult> {
  const result: LearnNotifyResult = { inspected: 0, notified: 0 };
  if (!localDevelopment.enabled) return result;

  const jobs = await localDevelopment.listTerminal(50).catch((error: unknown) => {
    log.warn({ error }, 'listing terminal local development jobs failed');
    return [] as LocalDevelopmentJob[];
  });

  for (const job of jobs) {
    result.inspected += 1;
    const chatId = job.privateChatId;
    if (!Number.isSafeInteger(chatId)) continue;

    const claimed = await storage.jobNotifications
      .claim(KIND, job.id, job.state, chatId)
      .catch((error: unknown) => {
        log.warn({ error, jobId: job.id }, 'job notification claim failed');
        return false;
      });
    if (!claimed) continue;

    let delivered = false;
    try {
      delivered = await notify({ chatId, job, nextCommand: nextCommandFor(job) });
    } catch (error) {
      log.warn({ error, jobId: job.id }, 'learn notification failed');
    }
    if (delivered) {
      result.notified += 1;
      continue;
    }
    await storage.jobNotifications
      .release(KIND, job.id, job.state)
      .catch((error: unknown) => log.warn({ error, jobId: job.id }, 'claim release failed'));
  }

  if (result.notified > 0) log.info(result, 'learn job notifications delivered');
  return result;
}

/**
 * The single command the admin most likely wants next.
 *
 * A finished job is only useful if the next step is obvious; `ready` in particular is worthless
 * without the diff, because nothing is applied until it is reviewed.
 */
export function nextCommandFor(job: LocalDevelopmentJob): string | undefined {
  const short = job.id.slice(0, 8);
  if (job.state === 'ready') return `/learn diff ${short}`;
  if (job.state === 'failed' || job.state === 'conflict') return `/learn status ${short}`;
  return undefined;
}
