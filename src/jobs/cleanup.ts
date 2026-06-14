import type { Storage } from '../storage/index.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('job-cleanup');

/**
 * Retention sweep: deletes raw messages older than the configured retention window.
 * This is a belt-and-braces complement to the TTL index on `messages.createdAt`
 * (covers the case where TTL is disabled or the index is missing).
 */
export async function runRetentionCleanup(storage: Storage, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await storage.messages.purgeOlderThan(cutoff);
  await storage.jobs.record('retention_cleanup', 'done', { deleted, cutoff: cutoff.toISOString() });
  if (deleted > 0) log.info({ deleted, retentionDays }, 'purged old messages');
}
