import type { Collection, Db } from 'mongodb';
import type { AmbientDomain } from '../../ambient/domains.js';

/**
 * How much a chat actually cares about a subject, learned from what gets discussed.
 *
 * This is deliberately a counter and not a mined memory: "questo gruppo parla di Frieren" is an
 * observation the bot can make without spending a model call, and counting it is both cheaper and
 * more honest than asking an LLM to summarise the group's taste.
 */
export interface TopicAffinityDoc {
  chatId: number;
  domain: AmbientDomain;
  /** Stable subject identity, `<provider>:<id>`, matching AmbientFact.entityId. */
  entityId: string;
  /** Display name as the source spells it. */
  subject: string;
  /** Times the subject came up in this chat. */
  mentions: number;
  /** Distinct people who brought it up; a group interest is not one person's monologue. */
  handles: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** Subjects below this many mentions are noise, not taste. */
export const AFFINITY_INTEREST_THRESHOLD = 3;

export class TopicAffinityRepo {
  private readonly col: Collection<TopicAffinityDoc>;

  constructor(db: Db) {
    this.col = db.collection<TopicAffinityDoc>('topic_affinity');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<TopicAffinityDoc>('topic_affinity');
    await col.createIndex({ chatId: 1, entityId: 1 }, { unique: true });
    await col.createIndex({ chatId: 1, domain: 1, mentions: -1 });
    await col.createIndex({ chatId: 1, lastSeenAt: -1 });
  }

  /**
   * Record one mention.
   *
   * `$addToSet` on the handle is what makes the count mean "the group talks about this" rather
   * than "one person keeps posting about this".
   */
  async record(
    chatId: number,
    domain: AmbientDomain,
    entityId: string,
    subject: string,
    handle: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.col.updateOne(
      { chatId, entityId },
      {
        $set: { domain, subject, lastSeenAt: now },
        $inc: { mentions: 1 },
        $addToSet: { handles: handle },
        $setOnInsert: { chatId, entityId, firstSeenAt: now },
      },
      { upsert: true },
    );
  }

  /** The chat's strongest interests, most discussed first. */
  async top(chatId: number, limit = 10, domain?: AmbientDomain): Promise<TopicAffinityDoc[]> {
    return this.col
      .find({ chatId, ...(domain ? { domain } : {}) })
      .sort({ mentions: -1, lastSeenAt: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Subjects the chat is genuinely into: discussed repeatedly, by more than one person, recently.
   *
   * Used to decide whether a proactive suggestion is welcome or would just be the bot nagging
   * about something one member mentioned once.
   */
  async establishedInterests(
    chatId: number,
    domain: AmbientDomain,
    opts: { minMentions?: number; withinDays?: number; limit?: number } = {},
  ): Promise<TopicAffinityDoc[]> {
    const minMentions = opts.minMentions ?? AFFINITY_INTEREST_THRESHOLD;
    const withinDays = opts.withinDays ?? 30;
    return this.col
      .find({
        chatId,
        domain,
        mentions: { $gte: minMentions },
        lastSeenAt: { $gte: new Date(Date.now() - withinDays * 24 * 3_600_000) },
      })
      .sort({ mentions: -1 })
      .limit(opts.limit ?? 5)
      .toArray();
  }

  async get(chatId: number, entityId: string): Promise<TopicAffinityDoc | null> {
    return this.col.findOne({ chatId, entityId });
  }
}
