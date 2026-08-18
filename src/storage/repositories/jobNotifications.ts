import type { Collection, Db } from 'mongodb';

/**
 * Durable "this job outcome was already announced" marker.
 *
 * Modelled on the autopost history repo: a unique insert *is* the reservation, so a restarted
 * scheduler re-reading the same finished job cannot announce it twice.
 */
export interface JobNotificationDoc {
  /** Namespace, e.g. `local_development`. */
  kind: string;
  jobId: string;
  /** Terminal state that was announced; a later state change is a new, announceable event. */
  state: string;
  chatId: number;
  createdAt: Date;
}

export class JobNotificationsRepo {
  private readonly col: Collection<JobNotificationDoc>;

  constructor(db: Db) {
    this.col = db.collection<JobNotificationDoc>('job_notifications');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<JobNotificationDoc>('job_notifications');
    await col.createIndex({ kind: 1, jobId: 1, state: 1 }, { unique: true });
    // Announcements are only interesting while the job is recent; 30 days is generous.
    await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3_600 });
  }

  /**
   * Claim the right to announce this job outcome.
   *
   * Returns false when someone already claimed it, which is the only thing standing between a
   * scheduler restart and a duplicate notification.
   */
  async claim(kind: string, jobId: string, state: string, chatId: number): Promise<boolean> {
    try {
      await this.col.insertOne({ kind, jobId, state, chatId, createdAt: new Date() });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  /** Give the claim back when delivery failed, so the next tick retries. */
  async release(kind: string, jobId: string, state: string): Promise<void> {
    await this.col.deleteOne({ kind, jobId, state });
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
