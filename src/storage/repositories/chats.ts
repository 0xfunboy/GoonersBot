import type { Collection, Db } from 'mongodb';
import type { ChatDoc, NsfwMode } from '../../domain/entities.js';

export interface ChatDefaults {
  language: string;
  conversationTracker: boolean;
  autoFact: boolean;
  autoengage: boolean;
  autopost: boolean;
  nsfwMode: NsfwMode;
}

export class ChatsRepo {
  private readonly col: Collection<ChatDoc>;

  constructor(db: Db) {
    this.col = db.collection<ChatDoc>('chats');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<ChatDoc>('chats');
    await col.createIndex({ chatId: 1 }, { unique: true });
  }

  /** Create the chat document with default toggles if it does not exist yet. */
  async createIfNotExists(
    chatId: number,
    chatName: string | undefined,
    defaults: ChatDefaults,
  ): Promise<void> {
    const now = new Date();
    // `updatedAt` lives only in $set (always), `createdAt` only in $setOnInsert - keeping them in
    // separate operators avoids Mongo's "would create a conflict" error on upsert.
    await this.col.updateOne(
      { chatId },
      {
        $setOnInsert: {
          chatId,
          language: defaults.language,
          isStarted: false,
          conversationTracker: defaults.conversationTracker,
          autoFact: defaults.autoFact,
          autoengage: defaults.autoengage,
          autopost: defaults.autopost,
          nsfwMode: defaults.nsfwMode,
          createdAt: now,
        },
        $set: { updatedAt: now, ...(chatName ? { chatName } : {}) },
      },
      { upsert: true },
    );
  }

  async get(chatId: number): Promise<ChatDoc | null> {
    return this.col.findOne({ chatId });
  }

  async startChat(chatId: number): Promise<void> {
    await this.col.updateOne({ chatId }, { $set: { isStarted: true, updatedAt: new Date() } });
  }

  async stopChat(chatId: number): Promise<void> {
    await this.col.updateOne({ chatId }, { $set: { isStarted: false, updatedAt: new Date() } });
  }

  async isStarted(chatId: number): Promise<boolean> {
    const doc = await this.col.findOne({ chatId }, { projection: { isStarted: 1 } });
    return doc?.isStarted ?? false;
  }

  async setLanguage(chatId: number, language: string): Promise<void> {
    await this.col.updateOne({ chatId }, { $set: { language, updatedAt: new Date() } });
  }

  async getLanguage(chatId: number, fallback: string): Promise<string> {
    const doc = await this.col.findOne({ chatId }, { projection: { language: 1 } });
    return doc?.language ?? fallback;
  }

  async getConversationTracker(chatId: number): Promise<boolean> {
    const doc = await this.col.findOne({ chatId }, { projection: { conversationTracker: 1 } });
    return doc?.conversationTracker ?? false;
  }

  async getAutoFact(chatId: number): Promise<boolean> {
    const doc = await this.col.findOne({ chatId }, { projection: { autoFact: 1 } });
    return doc?.autoFact ?? false;
  }

  async getAutoengage(chatId: number): Promise<boolean> {
    const doc = await this.col.findOne({ chatId }, { projection: { autoengage: 1 } });
    return doc?.autoengage ?? false;
  }

  async getAutopost(chatId: number): Promise<boolean> {
    const doc = await this.col.findOne({ chatId }, { projection: { autopost: 1 } });
    return doc?.autopost ?? false;
  }

  switchAutopost(chatId: number): Promise<boolean> {
    return this.toggle(chatId, 'autopost');
  }

  /** Started chats with autopost enabled (targets for the autonomous-posting tick). */
  async listForAutopost(): Promise<Array<{ chatId: number; language: string }>> {
    const docs = await this.col
      .find({ isStarted: true, autopost: true }, { projection: { chatId: 1, language: 1 } })
      .toArray();
    return docs.map((d) => ({ chatId: d.chatId, language: d.language }));
  }

  async getNsfwMode(chatId: number, fallback: NsfwMode): Promise<NsfwMode> {
    const doc = await this.col.findOne({ chatId }, { projection: { nsfwMode: 1 } });
    return doc?.nsfwMode ?? fallback;
  }

  async setNsfwMode(chatId: number, mode: NsfwMode): Promise<void> {
    await this.col.updateOne({ chatId }, { $set: { nsfwMode: mode, updatedAt: new Date() } });
  }

  /** Toggle a boolean flag and return the new value. */
  private async toggle(
    chatId: number,
    field: 'conversationTracker' | 'autoFact' | 'autoengage' | 'autopost',
  ): Promise<boolean> {
    const current = await this.col.findOne({ chatId }, { projection: { [field]: 1 } });
    const next = !(current?.[field] ?? false);
    await this.col.updateOne({ chatId }, { $set: { [field]: next, updatedAt: new Date() } });
    return next;
  }

  switchConversationTracker(chatId: number): Promise<boolean> {
    return this.toggle(chatId, 'conversationTracker');
  }

  switchAutoFact(chatId: number): Promise<boolean> {
    return this.toggle(chatId, 'autoFact');
  }

  switchAutoengage(chatId: number): Promise<boolean> {
    return this.toggle(chatId, 'autoengage');
  }

  /** Started chats with auto-fact enabled (targets for the background mining job). */
  async listForMining(): Promise<Array<{ chatId: number; language: string; nsfwMode: NsfwMode }>> {
    const docs = await this.col
      .find(
        { isStarted: true, autoFact: true },
        { projection: { chatId: 1, language: 1, nsfwMode: 1 } },
      )
      .toArray();
    return docs.map((d) => ({
      chatId: d.chatId,
      language: d.language,
      nsfwMode: d.nsfwMode ?? 'off',
    }));
  }

  /** All started chats (targets for the feedback job). */
  async listStartedChatIds(): Promise<number[]> {
    const docs = await this.col.find({ isStarted: true }, { projection: { chatId: 1 } }).toArray();
    return docs.map((d) => d.chatId);
  }
}
