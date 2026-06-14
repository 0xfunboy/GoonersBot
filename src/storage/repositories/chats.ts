import type { Collection, Db } from 'mongodb';
import type { ChatDoc } from '../../domain/entities.js';

export interface ChatDefaults {
  language: string;
  conversationTracker: boolean;
  autoFact: boolean;
  autoengage: boolean;
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
  async createIfNotExists(chatId: number, chatName: string | undefined, defaults: ChatDefaults): Promise<void> {
    const now = new Date();
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
          createdAt: now,
          updatedAt: now,
        },
        ...(chatName ? { $set: { chatName, updatedAt: now } } : {}),
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

  /** Toggle a boolean flag and return the new value. */
  private async toggle(chatId: number, field: 'conversationTracker' | 'autoFact' | 'autoengage'): Promise<boolean> {
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
}
