import { MongoServerError, type Collection, type Db } from 'mongodb';
import { normalizeSocialHandle } from './evolution.js';
import type { ChatSocialState, MemberSocialProfile, SocialProfileStore } from './types.js';

/**
 * Mongo persistence for social profiles.
 *
 * Writes use optimistic concurrency. The engine retries on a version race, preventing two mining
 * jobs from silently overwriting each other's observations.
 */
export class MongoSocialProfileStore implements SocialProfileStore {
  private readonly members: Collection<MemberSocialProfile>;
  private readonly chats: Collection<ChatSocialState>;

  constructor(db: Db) {
    this.members = db.collection<MemberSocialProfile>('social_member_profiles');
    this.chats = db.collection<ChatSocialState>('social_chat_states');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const members = db.collection<MemberSocialProfile>('social_member_profiles');
    await members.createIndex({ chatId: 1, handle: 1 }, { unique: true });
    await members.createIndex({ chatId: 1, lastSeenAt: -1 });
    await members.createIndex({ chatId: 1, telegramId: 1 });

    const chats = db.collection<ChatSocialState>('social_chat_states');
    await chats.createIndex({ chatId: 1 }, { unique: true });
  }

  async getMember(chatId: number, handle: string): Promise<MemberSocialProfile | null> {
    return this.members.findOne({ chatId, handle });
  }

  async getMemberByTelegramId(
    chatId: number,
    telegramId: number,
  ): Promise<MemberSocialProfile | null> {
    return this.members.findOne({ chatId, telegramId }, { sort: { lastSeenAt: -1 } });
  }

  async listMembers(chatId: number, limit = 100): Promise<MemberSocialProfile[]> {
    return this.members
      .find({ chatId })
      .sort({ lastSeenAt: -1, messageCount: -1 })
      .limit(Math.max(1, Math.min(limit, 500)))
      .toArray();
  }

  async saveMember(profile: MemberSocialProfile, expectedVersion: number): Promise<boolean> {
    if (profile.version !== expectedVersion + 1) {
      throw new Error('social member profile version must increment by exactly one');
    }
    if (expectedVersion === 0) {
      try {
        await this.members.insertOne(profile);
        return true;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) return false;
        throw error;
      }
    }
    const result = await this.members.replaceOne(
      { chatId: profile.chatId, handle: profile.handle, version: expectedVersion },
      profile,
    );
    return result.modifiedCount === 1;
  }

  async deleteMember(chatId: number, handle: string): Promise<boolean> {
    const result = await this.members.deleteOne({ chatId, handle });
    return result.deletedCount === 1;
  }

  /**
   * Permanently erase one identity from every chat.
   *
   * Profiles may have moved to a new Telegram username, so handle-shaped aliases discovered on a
   * matching profile are erased too. Chat-state cleanup is a versioned atomic update: concurrent
   * optimistic writes will fail their old version instead of resurrecting relationships or jokes.
   */
  async deleteByHandleEverywhere(
    handle: string,
  ): Promise<{ membersDeleted: number; chatStatesUpdated: number }> {
    const normalizedHandle = normalizeSocialHandle(handle);
    if (!normalizedHandle) return { membersDeleted: 0, chatStatesUpdated: 0 };

    const linkedProfiles = await this.members
      .find(
        {
          $or: [{ handle: normalizedHandle }, { aliases: normalizedHandle }],
        },
        {
          projection: { handle: 1, aliases: 1 },
          collation: { locale: 'en', strength: 2 },
        },
      )
      .toArray();
    const handles = [
      ...new Set([
        normalizedHandle,
        ...linkedProfiles.flatMap((profile) => [
          normalizeSocialHandle(profile.handle),
          ...(profile.aliases ?? [])
            .filter((alias) => alias.trim().startsWith('@'))
            .map(normalizeSocialHandle),
        ]),
      ]),
    ].filter(Boolean);

    const membersResult = await this.members.deleteMany(
      {
        $or: [{ handle: { $in: handles } }, { aliases: { $in: handles } }],
      },
      { collation: { locale: 'en', strength: 2 } },
    );
    const chatFilter = {
      $or: [
        { 'relationships.fromHandle': { $in: handles } },
        { 'relationships.toHandle': { $in: handles } },
        { 'runningJokes.targetHandles': { $in: handles } },
      ],
    };
    const chatsResult = await this.chats.updateMany(
      chatFilter,
      [
        {
          $set: {
            relationships: {
              $filter: {
                input: { $ifNull: ['$relationships', []] },
                as: 'relationship',
                cond: {
                  $and: [
                    { $eq: [{ $in: ['$$relationship.fromHandle', handles] }, false] },
                    { $eq: [{ $in: ['$$relationship.toHandle', handles] }, false] },
                  ],
                },
              },
            },
            runningJokes: {
              $filter: {
                input: { $ifNull: ['$runningJokes', []] },
                as: 'joke',
                cond: {
                  $eq: [
                    {
                      $size: {
                        $setIntersection: [{ $ifNull: ['$$joke.targetHandles', []] }, handles],
                      },
                    },
                    0,
                  ],
                },
              },
            },
            updatedAt: new Date(),
            version: { $add: [{ $ifNull: ['$version', 0] }, 1] },
          },
        },
      ],
      { collation: { locale: 'en', strength: 2 } },
    );
    return {
      membersDeleted: membersResult.deletedCount,
      chatStatesUpdated: chatsResult.modifiedCount,
    };
  }

  async getChatState(chatId: number): Promise<ChatSocialState | null> {
    return this.chats.findOne({ chatId });
  }

  async saveChatState(state: ChatSocialState, expectedVersion: number): Promise<boolean> {
    if (state.version !== expectedVersion + 1) {
      throw new Error('social chat state version must increment by exactly one');
    }
    if (expectedVersion === 0) {
      try {
        await this.chats.insertOne(state);
        return true;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) return false;
        throw error;
      }
    }
    const result = await this.chats.replaceOne(
      { chatId: state.chatId, version: expectedVersion },
      state,
    );
    return result.modifiedCount === 1;
  }
}
