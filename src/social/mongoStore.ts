import { MongoServerError, type Collection, type Db } from 'mongodb';
import { normalizeSocialHandle } from './evolution.js';
import type { ChatSocialState, MemberSocialProfile, SocialProfileStore } from './types.js';
import type { MemoryPrivacyGuard } from '../companion/memory/privacy.js';

/**
 * Mongo persistence for social profiles.
 *
 * Writes use optimistic concurrency. The engine retries on a version race, preventing two mining
 * jobs from silently overwriting each other's observations.
 */
export class MongoSocialProfileStore implements SocialProfileStore {
  private readonly members: Collection<MemberSocialProfile>;
  private readonly chats: Collection<ChatSocialState>;

  constructor(
    db: Db,
    private readonly privacy?: MemoryPrivacyGuard,
  ) {
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
    if (this.privacy) {
      const facets = [];
      for (const facet of profile.facets)
        if (await this.privacy.allowsSources(profile.chatId, facet.sourceMessageIds))
          facets.push(facet);
      profile = { ...profile, facets };
    }
    if (
      this.privacy &&
      !(await this.privacy.allowsHandles(
        [profile.handle, ...profile.aliases.filter((alias) => alias.startsWith('@'))],
        profile.telegramId,
      ))
    )
      return false;
    if (profile.version !== expectedVersion + 1) {
      throw new Error('social member profile version must increment by exactly one');
    }
    if (expectedVersion === 0) {
      try {
        await this.members.insertOne(profile);
        if (
          this.privacy &&
          !(await this.privacy.allowsHandles([profile.handle], profile.telegramId))
        ) {
          await this.members.deleteOne({ chatId: profile.chatId, handle: profile.handle });
          return false;
        }
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
    if (this.privacy && !(await this.privacy.allowsHandles([profile.handle], profile.telegramId))) {
      await this.members.deleteOne({ chatId: profile.chatId, handle: profile.handle });
      return false;
    }
    return result.modifiedCount === 1;
  }

  async deleteMember(chatId: number, handle: string): Promise<boolean> {
    const result = await this.members.deleteOne({ chatId, handle });
    return result.deletedCount === 1;
  }

  /** Forget the other derived facets supported by the same erased human evidence. */
  async forgetSource(chatId: number, sourceMessageId: number): Promise<void> {
    await this.members.updateMany({ chatId, 'facets.sourceMessageIds': sourceMessageId }, [
      {
        $set: {
          facets: {
            $filter: {
              input: '$facets',
              as: 'facet',
              cond: {
                $eq: [
                  { $in: [sourceMessageId, { $ifNull: ['$$facet.sourceMessageIds', []] }] },
                  false,
                ],
              },
            },
          },
          version: { $add: ['$version', 1] },
          updatedAt: new Date(),
        },
      },
    ]);
    const fields = ['relationships', 'runningJokes', 'norms'];
    const set = Object.fromEntries(
      fields.map((field) => [
        field,
        {
          $filter: {
            input: { $ifNull: [`$${field}`, []] },
            as: 'entry',
            cond: {
              $eq: [
                { $in: [sourceMessageId, { $ifNull: ['$$entry.sourceMessageIds', []] }] },
                false,
              ],
            },
          },
        },
      ]),
    );
    await this.chats.updateMany(
      { chatId, $or: fields.map((field) => ({ [`${field}.sourceMessageIds`]: sourceMessageId })) },
      [{ $set: { ...set, version: { $add: ['$version', 1] }, updatedAt: new Date() } }],
    );
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
    await this.privacy?.blockHandles(handles);

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
    // Whole-chat CAS cannot reintroduce a relationship removed by erasure. Filter each target
    // before persistence; deletion increments the stored version to fence in-flight old writes.
    if (this.privacy) {
      const relationships = [];
      for (const relation of state.relationships)
        if (
          (await this.privacy.allowsHandles([relation.fromHandle, relation.toHandle])) &&
          (await this.privacy.allowsSources(state.chatId, relation.sourceMessageIds))
        )
          relationships.push(relation);
      const runningJokes = [];
      for (const joke of state.runningJokes)
        if (
          (await this.privacy.allowsHandles(joke.targetHandles)) &&
          (await this.privacy.allowsSources(state.chatId, joke.sourceMessageIds))
        )
          runningJokes.push(joke);
      const norms = [];
      for (const norm of state.norms)
        if (await this.privacy.allowsSources(state.chatId, norm.sourceMessageIds)) norms.push(norm);
      state = { ...state, relationships, runningJokes, norms };
    }
    if (state.version !== expectedVersion + 1) {
      throw new Error('social chat state version must increment by exactly one');
    }
    if (expectedVersion === 0) {
      try {
        await this.chats.insertOne(state);
        await this.removeErasedReferences(state);
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
    await this.removeErasedReferences(state);
    return result.modifiedCount === 1;
  }

  private async removeErasedReferences(state: ChatSocialState): Promise<void> {
    if (!this.privacy) return;
    const handles = new Set([
      ...state.relationships.flatMap((relation) => [relation.fromHandle, relation.toHandle]),
      ...state.runningJokes.flatMap((joke) => joke.targetHandles),
    ]);
    for (const handle of handles)
      if (!(await this.privacy.allowsHandles([handle])))
        await this.deleteByHandleEverywhere(handle);
    const sources = new Set(
      [...state.relationships, ...state.runningJokes, ...state.norms].flatMap(
        (entry) => entry.sourceMessageIds,
      ),
    );
    for (const sourceId of sources)
      if (!(await this.privacy.allowsSources(state.chatId, [sourceId])))
        await this.forgetSource(state.chatId, sourceId);
  }
}
