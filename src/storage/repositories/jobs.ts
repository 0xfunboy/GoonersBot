import type { Collection, Db } from 'mongodb';
import type { JobDoc, JobStatus } from '../../domain/entities.js';

export class JobsRepo {
  private readonly col: Collection<JobDoc>;

  constructor(db: Db) {
    this.col = db.collection<JobDoc>('jobs');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<JobDoc>('jobs');
    await col.createIndex({ status: 1, scheduledFor: 1 });
    await col.createIndex({ type: 1 });
    await col.createIndex({ createdAt: 1 });
  }

  async record(type: string, status: JobStatus, payload?: Record<string, unknown>): Promise<void> {
    const now = new Date();
    await this.col.insertOne({
      type,
      status,
      ...(payload ? { payload } : {}),
      scheduledFor: now,
      startedAt: status === 'running' ? now : null,
      finishedAt: status === 'done' || status === 'failed' ? now : null,
      error: null,
      createdAt: now,
    });
  }

  /** Returns the most recent run time for a job type, or null. */
  async lastRun(type: string): Promise<Date | null> {
    const doc = await this.col.findOne({ type }, { sort: { createdAt: -1 } });
    return doc?.createdAt ?? null;
  }
}
