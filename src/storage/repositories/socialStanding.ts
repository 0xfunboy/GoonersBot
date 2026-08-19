import type { Collection, Db } from 'mongodb';

/**
 * How one person has treated the bot over time, per chat.
 *
 * Deliberately separate from `user_heat`: heat is arousal - how hot *this exchange* is, decaying
 * back to baseline within minutes - while standing is a months-long memory of conduct. A friend
 * can be in a heated argument, and conflating the two would make the bot go soft mid-fight or
 * turn on a friend who teases it.
 */
export interface SocialStandingDoc {
  chatId: number;
  handle: string;
  /** -100..+100. Positive is warmth earned, negative is hostility received. */
  rapport: number;
  /** Persisted flag, not merely a band: promotion and demotion follow their own rules. */
  friend: boolean;
  /** Turns observed; a tag should not be earned on three messages. */
  interactions: number;
  /** Genuine hostility only. Teasing is never counted here. */
  conflicts: number;
  lastConflictAt?: Date | undefined;
  /** Set when the friend tag was granted, cleared on demotion. */
  friendSince?: Date | undefined;
  firstSeenAt: Date;
  lastSeenAt: Date;
  updatedAt: Date;
}

export type StandingBand = 'friend' | 'warm' | 'neutral' | 'prickly' | 'hostile';

export const RAPPORT_MIN = -100;
export const RAPPORT_MAX = 100;
/** Rapport needed before the friend tag is even considered. */
export const FRIEND_RAPPORT_THRESHOLD = 40;
/** A tag should reflect a relationship, not a good afternoon. */
export const FRIEND_MIN_INTERACTIONS = 20;
/** Hostility-free window required for promotion. */
export const FRIEND_QUIET_DAYS = 30;
/** A former friend restarts from `warm`: falling out is not the same as never having met. */
export const DEMOTION_FLOOR = 10;

export function bandFor(doc: Pick<SocialStandingDoc, 'rapport' | 'friend'>): StandingBand {
  if (doc.friend) return 'friend';
  if (doc.rapport >= FRIEND_RAPPORT_THRESHOLD) return 'warm';
  if (doc.rapport >= 10) return 'warm';
  if (doc.rapport > -10) return 'neutral';
  if (doc.rapport > -40) return 'prickly';
  return 'hostile';
}

export class SocialStandingRepo {
  private readonly col: Collection<SocialStandingDoc>;

  constructor(db: Db) {
    this.col = db.collection<SocialStandingDoc>('social_standing');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<SocialStandingDoc>('social_standing');
    await col.createIndex({ chatId: 1, handle: 1 }, { unique: true });
    await col.createIndex({ chatId: 1, friend: 1 });
    await col.createIndex({ chatId: 1, rapport: -1 });
  }

  async get(chatId: number, handle: string): Promise<SocialStandingDoc | null> {
    return this.col.findOne({ chatId, handle });
  }

  async listFriends(chatId: number, limit = 50): Promise<SocialStandingDoc[]> {
    return this.col.find({ chatId, friend: true }).limit(limit).toArray();
  }

  /**
   * Apply one turn's observation.
   *
   * `conflict` is genuine hostility only - the caller must have already ruled out banter, which is
   * how this group normally talks and must cost nothing.
   */
  async record(
    chatId: number,
    handle: string,
    delta: number,
    conflict: boolean,
    now: Date = new Date(),
  ): Promise<SocialStandingDoc> {
    const existing = await this.get(chatId, handle);
    const base = existing ? decayed(existing, now) : 0;
    const rapport = clamp(base + delta);

    const doc: SocialStandingDoc = {
      chatId,
      handle,
      rapport,
      friend: existing?.friend ?? false,
      interactions: (existing?.interactions ?? 0) + 1,
      conflicts: (existing?.conflicts ?? 0) + (conflict ? 1 : 0),
      lastConflictAt: conflict ? now : existing?.lastConflictAt,
      friendSince: existing?.friendSince,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      updatedAt: now,
    };

    // Demotion first: a genuine conflict revokes the tag regardless of how high rapport is.
    if (conflict && doc.friend) {
      doc.friend = false;
      doc.friendSince = undefined;
      doc.rapport = Math.max(DEMOTION_FLOOR, Math.min(doc.rapport, DEMOTION_FLOOR));
    } else if (!doc.friend && qualifiesAsFriend(doc, now)) {
      doc.friend = true;
      doc.friendSince = now;
    }

    await this.col.updateOne({ chatId, handle }, { $set: doc }, { upsert: true });
    return doc;
  }
}

/**
 * Promotion test.
 *
 * Slow on purpose: warmth, volume and a quiet stretch must all be present, so the tag means
 * "this person has never actually turned on me" rather than "we had a nice evening".
 */
export function qualifiesAsFriend(
  doc: Pick<SocialStandingDoc, 'rapport' | 'interactions' | 'lastConflictAt'>,
  now: Date = new Date(),
): boolean {
  if (doc.rapport < FRIEND_RAPPORT_THRESHOLD) return false;
  if (doc.interactions < FRIEND_MIN_INTERACTIONS) return false;
  if (!doc.lastConflictAt) return true;
  const quietFor = now.getTime() - doc.lastConflictAt.getTime();
  return quietFor >= FRIEND_QUIET_DAYS * 24 * 3_600_000;
}

/**
 * Decay, applied only to the negative side.
 *
 * Earned warmth persists and grudges expire, which is both how the group actually works and what
 * "until there is a genuinely new conflict" requires. Symmetric decay would quietly delete every
 * friendship during a quiet week.
 */
export function decayed(doc: Pick<SocialStandingDoc, 'rapport' | 'updatedAt'>, now: Date): number {
  if (doc.rapport >= 0) return doc.rapport;
  const days = Math.max(0, (now.getTime() - doc.updatedAt.getTime()) / (24 * 3_600_000));
  return Math.min(0, doc.rapport + Math.floor(days));
}

function clamp(value: number): number {
  return Math.max(RAPPORT_MIN, Math.min(RAPPORT_MAX, Math.round(value)));
}
