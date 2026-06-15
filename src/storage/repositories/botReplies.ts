import { ObjectId, type Collection, type Db, type WithId } from 'mongodb';
import type { BotReplyRecord } from '../../brain/types.js';

type Doc = Omit<BotReplyRecord, '_id'>;

export class BotRepliesRepo {
  private readonly col: Collection<Doc>;

  constructor(
    db: Db,
    private readonly retentionDays: number,
  ) {
    this.col = db.collection<Doc>('bot_replies');
  }

  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ chatId: 1, createdAt: -1 });
    await this.col.createIndex({ chatId: 1, fingerprint: 1 });
    if (this.retentionDays > 0) {
      await this.col.createIndex(
        { createdAt: 1 },
        { name: 'botreplies_ttl', expireAfterSeconds: this.retentionDays * 24 * 60 * 60 },
      );
    }
  }

  async record(
    rec: Omit<BotReplyRecord, '_id' | 'createdAt'> & { createdAt?: Date },
  ): Promise<string> {
    const doc: Doc = { ...rec, createdAt: rec.createdAt ?? new Date() };
    const res = await this.col.insertOne(doc);
    return res.insertedId.toString();
  }

  async getRecent(chatId: number, limit: number): Promise<BotReplyRecord[]> {
    const docs = await this.col.find({ chatId }).sort({ createdAt: -1 }).limit(limit).toArray();
    return docs.map((d: WithId<Doc>) => ({ ...(d as Doc), _id: d._id.toString() }));
  }

  async setFeedback(id: string, score: number, reasons: string[]): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    await this.col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { feedbackScore: score, feedbackReasons: reasons } },
    );
  }

  /** Recent replies that have not yet been scored (for the feedback job). */
  async getUnscored(chatId: number, limit: number): Promise<BotReplyRecord[]> {
    const docs = await this.col
      .find({ chatId, feedbackScore: { $exists: false } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d: WithId<Doc>) => ({ ...(d as Doc), _id: d._id.toString() }));
  }

  async distinctChatIds(): Promise<number[]> {
    return (await this.col.distinct('chatId')) as number[];
  }
}
