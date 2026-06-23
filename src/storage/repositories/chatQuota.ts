import type { Collection, Db } from 'mongodb';
import type { ChatQuotaDoc } from '../../domain/entities.js';
import { DEFAULT_QUOTA_PLAN, type QuotaPlanId } from '../../quota/plans.js';

export class ChatQuotaRepo {
  private readonly col: Collection<ChatQuotaDoc>;

  constructor(db: Db) {
    this.col = db.collection<ChatQuotaDoc>('chat_quotas');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<ChatQuotaDoc>('chat_quotas');
    await col.createIndex({ chatId: 1 }, { unique: true });
  }

  async getOrCreate(chatId: number): Promise<ChatQuotaDoc> {
    const existing = await this.col.findOne({ chatId });
    if (existing) return existing;
    const now = new Date();
    const fresh = emptyQuota(chatId, DEFAULT_QUOTA_PLAN, now);
    try {
      await this.col.insertOne(fresh);
      return fresh;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const raced = await this.col.findOne({ chatId });
      if (!raced) throw err;
      return raced;
    }
  }

  async compareAndSet(doc: ChatQuotaDoc, expectedVersion: number): Promise<boolean> {
    const result = await this.col.replaceOne(
      { chatId: doc.chatId, version: expectedVersion },
      doc,
      {
        upsert: false,
      },
    );
    return result.matchedCount === 1;
  }

  async setPlan(chatId: number, plan: QuotaPlanId): Promise<ChatQuotaDoc> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await this.getOrCreate(chatId);
      const next: ChatQuotaDoc = {
        ...current,
        plan,
        version: current.version + 1,
        updatedAt: new Date(),
      };
      if (await this.compareAndSet(next, current.version)) return next;
    }
    throw new Error('chat quota plan update contention');
  }
}

export function emptyQuota(chatId: number, plan: QuotaPlanId, now: Date): ChatQuotaDoc {
  return {
    chatId,
    plan,
    version: 0,
    dayKey: '',
    hourKey: '',
    minuteKey: '',
    daily: emptyDailyCounters(),
    hourly: emptyHourlyCounters(),
    minute: { chatRequests: 0, userRequests: {} },
    lastUserRequestAt: {},
    updatedAt: now,
  };
}

export function emptyDailyCounters(): ChatQuotaDoc['daily'] {
  return {
    conversations: 0,
    llmTokens: 0,
    webSearches: 0,
    pageScans: 0,
    news: 0,
    images: 0,
    media: 0,
    mediaBytes: 0,
  };
}

export function emptyHourlyCounters(): ChatQuotaDoc['hourly'] {
  return { conversations: 0, passiveReplies: 0 };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}
