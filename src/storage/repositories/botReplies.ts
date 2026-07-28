import { ObjectId, type Collection, type Db, type WithId } from 'mongodb';
import type { BotReplyRecord } from '../../brain/types.js';

type ReactionScore = -1 | 0 | 1;

type Doc = Omit<BotReplyRecord, '_id'> & {
  /** Latest explicit Telegram vote per reacting user/chat. */
  reactionFeedbackByActor?: Record<string, ReactionScore>;
  reactionReasonsByActor?: Record<string, string[]>;
  /** Unclamped sum; feedbackScore stores only its sign for existing consumers. */
  reactionFeedbackScore?: number;
  /** CAS version makes concurrent reaction updates from different actors lossless. */
  reactionFeedbackVersion?: number;
};

export interface ReactionFeedbackChange {
  previousScore: ReactionScore;
  currentScore: ReactionScore;
}

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
    await this.col.createIndex({ chatId: 1, recipientHandle: 1, createdAt: -1 });
    await this.col.createIndex({ chatId: 1, fingerprint: 1 });
    await this.col.createIndex({ chatId: 1, messageIds: 1 });
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

  async getRecentFor(
    chatId: number,
    recipientHandle: string,
    limit: number,
  ): Promise<BotReplyRecord[]> {
    const docs = await this.col
      .find({ chatId, recipientHandle })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d: WithId<Doc>) => ({ ...(d as Doc), _id: d._id.toString() }));
  }

  async findByMessageId(chatId: number, messageId: number): Promise<BotReplyRecord | null> {
    const doc = await this.col.findOne({
      chatId,
      $or: [{ messageId }, { messageIds: messageId }],
    });
    return doc ? { ...(doc as Doc), _id: doc._id.toString() } : null;
  }

  async setFeedback(id: string, score: number, reasons: string[]): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    await this.col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { feedbackScore: score, feedbackReasons: reasons } },
    );
  }

  /**
   * Persist one actor's complete reaction state and return the old/new vote.
   *
   * Telegram may redeliver updates and different users can react concurrently. A small CAS loop
   * serializes the per-message map, so callers can apply only the true delta to learned memory.
   */
  async setReactionFeedback(
    id: string,
    actorKey: string,
    score: ReactionScore,
    reasons: string[],
  ): Promise<ReactionFeedbackChange | null> {
    if (!ObjectId.isValid(id) || !/^(?:user|chat)_-?\d+$/.test(actorKey)) return null;
    const objectId = new ObjectId(id);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await this.col.findOne(
        { _id: objectId },
        {
          projection: {
            reactionFeedbackByActor: 1,
            reactionReasonsByActor: 1,
            reactionFeedbackScore: 1,
            reactionFeedbackVersion: 1,
          },
        },
      );
      if (!current) return null;

      const scores = { ...(current.reactionFeedbackByActor ?? {}) };
      const previousScore = normalizeReactionScore(scores[actorKey]);
      scores[actorKey] = score;
      const reasonMap = {
        ...(current.reactionReasonsByActor ?? {}),
        [actorKey]: reasons.slice(0, 8),
      };
      const aggregate = Object.values(scores).reduce<number>((sum, value) => sum + value, 0);
      const version = current.reactionFeedbackVersion ?? 0;
      const versionFilter =
        current.reactionFeedbackVersion === undefined
          ? { reactionFeedbackVersion: { $exists: false } }
          : { reactionFeedbackVersion: version };

      const updated = await this.col.updateOne(
        { _id: objectId, ...versionFilter },
        {
          $set: {
            reactionFeedbackByActor: scores,
            reactionReasonsByActor: reasonMap,
            reactionFeedbackScore: aggregate,
            reactionFeedbackVersion: version + 1,
            feedbackScore: normalizeReactionScore(aggregate),
            feedbackReasons: [...new Set(Object.values(reasonMap).flat())].slice(0, 8),
          },
        },
      );
      if (updated.modifiedCount === 1) return { previousScore, currentScore: score };
    }
    throw new Error('bot reply reaction feedback update contention');
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

function normalizeReactionScore(value: number | undefined): ReactionScore {
  const numeric = value ?? 0;
  return numeric > 0 ? 1 : numeric < 0 ? -1 : 0;
}
