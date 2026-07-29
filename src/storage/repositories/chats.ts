import type { Collection, Db } from 'mongodb';
import type {
  ChatDoc,
  NsfwMode,
  TelegramMembershipStatus,
} from '../../domain/entities.js';

export interface ChatDefaults {
  language: string;
  conversationTracker: boolean;
  autoengage: boolean;
  autopost: boolean;
  nsfwMode: NsfwMode;
}

export interface MiningCursor {
  timestamp: number;
  messageId: number;
}

export interface ChatMembershipAuditRow {
  chatId: number;
  chatName?: string;
  isStarted: boolean;
  status: TelegramMembershipStatus | 'unknown';
  updatedAt?: Date;
  auditedAt?: Date;
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

  /**
   * Persist Telegram's current view of the bot membership. A removal immediately disables every
   * autonomous feature so stale local toggles cannot keep scheduling work.
   */
  async setTelegramMembership(
    chatId: number,
    status: TelegramMembershipStatus,
    options: { chatName?: string; audited?: boolean; observedAt?: Date } = {},
  ): Promise<void> {
    const observedAt = options.observedAt ?? new Date();
    const inactive = status === 'left' || status === 'kicked';
    await this.col.updateOne(
      { chatId },
      {
        $set: {
          telegramMembershipStatus: status,
          telegramMembershipUpdatedAt: observedAt,
          ...(options.audited ? { telegramMembershipAuditedAt: observedAt } : {}),
          ...(options.chatName ? { chatName: options.chatName } : {}),
          ...(inactive
            ? {
                isStarted: false,
                autoengage: false,
                autopost: false,
                conversationTracker: false,
              }
            : {}),
          updatedAt: observedAt,
        },
      },
    );
  }

  async getTelegramMembership(chatId: number): Promise<TelegramMembershipStatus | undefined> {
    const doc = await this.col.findOne(
      { chatId },
      { projection: { telegramMembershipStatus: 1 } },
    );
    return doc?.telegramMembershipStatus;
  }

  async listMembershipAudit(chatIds: readonly number[]): Promise<ChatMembershipAuditRow[]> {
    if (chatIds.length === 0) return [];
    const docs = await this.col
      .find(
        { chatId: { $in: [...chatIds] } },
        {
          projection: {
            chatId: 1,
            chatName: 1,
            isStarted: 1,
            telegramMembershipStatus: 1,
            telegramMembershipUpdatedAt: 1,
            telegramMembershipAuditedAt: 1,
          },
        },
      )
      .toArray();
    const byId = new Map(docs.map((doc) => [doc.chatId, doc]));
    return chatIds.map((chatId) => {
      const doc = byId.get(chatId);
      return {
        chatId,
        ...(doc?.chatName ? { chatName: doc.chatName } : {}),
        isStarted: doc?.isStarted ?? false,
        status: doc?.telegramMembershipStatus ?? 'unknown',
        ...(doc?.telegramMembershipUpdatedAt
          ? { updatedAt: doc.telegramMembershipUpdatedAt }
          : {}),
        ...(doc?.telegramMembershipAuditedAt
          ? { auditedAt: doc.telegramMembershipAuditedAt }
          : {}),
      };
    });
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

  async getAutoengage(chatId: number): Promise<boolean> {
    const doc = await this.col.findOne({ chatId }, { projection: { autoengage: 1 } });
    return doc?.autoengage ?? false;
  }

  /** Newest message timestamp (epoch ms) seen by the last memory-mining run; 0 if never mined. */
  async getLastMinedAt(chatId: number): Promise<number> {
    const doc = await this.col.findOne({ chatId }, { projection: { lastMinedAt: 1 } });
    return doc?.lastMinedAt ?? 0;
  }

  async setLastMinedAt(chatId: number, ts: number): Promise<void> {
    if (!Number.isFinite(ts)) return;
    await this.col.updateOne(
      { chatId },
      { $max: { lastMinedAt: ts }, $set: { updatedAt: new Date() } },
    );
  }

  async getLoreMiningCursor(chatId: number): Promise<MiningCursor> {
    const doc = await this.col.findOne(
      { chatId },
      { projection: { lastMinedAt: 1, lastMinedMessageId: 1 } },
    );
    return {
      timestamp: doc?.lastMinedAt ?? 0,
      messageId: doc?.lastMinedMessageId ?? 0,
    };
  }

  async setLoreMiningCursor(chatId: number, cursor: MiningCursor): Promise<void> {
    if (!Number.isFinite(cursor.timestamp) || !Number.isSafeInteger(cursor.messageId)) return;
    await this.col.updateOne(
      { chatId },
      {
        $max: {
          lastMinedAt: cursor.timestamp,
          lastMinedMessageId: Math.max(0, cursor.messageId),
        },
        $set: { updatedAt: new Date() },
      },
    );
  }

  /** Newest human-message timestamp processed by the social-profile miner. */
  async getLastSocialMinedAt(chatId: number): Promise<number> {
    const doc = await this.col.findOne({ chatId }, { projection: { lastSocialMinedAt: 1 } });
    return doc?.lastSocialMinedAt ?? 0;
  }

  async setLastSocialMinedAt(chatId: number, ts: number): Promise<void> {
    if (!Number.isFinite(ts)) return;
    await this.col.updateOne(
      { chatId },
      { $max: { lastSocialMinedAt: ts }, $set: { updatedAt: new Date() } },
    );
  }

  async getSocialMiningCursor(chatId: number): Promise<MiningCursor> {
    const doc = await this.col.findOne(
      { chatId },
      { projection: { lastSocialMinedAt: 1, lastSocialMinedMessageId: 1 } },
    );
    return {
      timestamp: doc?.lastSocialMinedAt ?? 0,
      messageId: doc?.lastSocialMinedMessageId ?? 0,
    };
  }

  async setSocialMiningCursor(chatId: number, cursor: MiningCursor): Promise<void> {
    if (!Number.isFinite(cursor.timestamp) || !Number.isSafeInteger(cursor.messageId)) return;
    await this.col.updateOne(
      { chatId },
      {
        $max: {
          lastSocialMinedAt: cursor.timestamp,
          lastSocialMinedMessageId: Math.max(0, cursor.messageId),
        },
        $set: { updatedAt: new Date() },
      },
    );
  }

  async getAutopost(chatId: number): Promise<boolean> {
    const doc = await this.col.findOne({ chatId }, { projection: { autopost: 1 } });
    return doc?.autopost ?? false;
  }

  switchAutopost(chatId: number): Promise<boolean> {
    return this.toggle(chatId, 'autopost');
  }

  /** Approved, active Telegram chats with autopost enabled. */
  async listForAutopost(
    approvedChatIds: readonly number[],
  ): Promise<Array<{ chatId: number; language: string }>> {
    if (approvedChatIds.length === 0) return [];
    const docs = await this.col
      .find(
        {
          chatId: { $in: [...approvedChatIds] },
          isStarted: true,
          autopost: true,
          telegramMembershipStatus: { $in: ['member', 'administrator'] },
        },
        { projection: { chatId: 1, language: 1 } },
      )
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
    field: 'conversationTracker' | 'autoengage' | 'autopost',
  ): Promise<boolean> {
    const current = await this.col.findOne({ chatId }, { projection: { [field]: 1 } });
    const next = !(current?.[field] ?? false);
    await this.col.updateOne({ chatId }, { $set: { [field]: next, updatedAt: new Date() } });
    return next;
  }

  switchConversationTracker(chatId: number): Promise<boolean> {
    return this.toggle(chatId, 'conversationTracker');
  }

  switchAutoengage(chatId: number): Promise<boolean> {
    return this.toggle(chatId, 'autoengage');
  }

  /** Link-media rehosting is ON by default, so an absent flag reads as enabled. */
  async getLinkMedia(chatId: number): Promise<boolean> {
    const doc = await this.col.findOne({ chatId }, { projection: { linkMedia: 1 } });
    return doc?.linkMedia ?? true;
  }

  async switchLinkMedia(chatId: number): Promise<boolean> {
    const current = await this.col.findOne({ chatId }, { projection: { linkMedia: 1 } });
    const next = !(current?.linkMedia ?? true);
    await this.col.updateOne({ chatId }, { $set: { linkMedia: next, updatedAt: new Date() } });
    return next;
  }

  /** Only approved chats where Telegram confirms active membership may be mined. */
  async listForMining(
    approvedChatIds: readonly number[],
  ): Promise<Array<{ chatId: number; language: string; nsfwMode: NsfwMode }>> {
    if (approvedChatIds.length === 0) return [];
    const docs = await this.col
      .find(
        {
          chatId: { $in: [...approvedChatIds] },
          isStarted: true,
          telegramMembershipStatus: { $in: ['member', 'administrator'] },
        },
        { projection: { chatId: 1, language: 1, nsfwMode: 1 } },
      )
      .toArray();
    return docs.map((d) => ({
      chatId: d.chatId,
      language: d.language,
      nsfwMode: d.nsfwMode ?? 'off',
    }));
  }

  /** Approved started chats where Telegram confirms that the bot is still present. */
  async listStartedChatIds(approvedChatIds: readonly number[]): Promise<number[]> {
    if (approvedChatIds.length === 0) return [];
    const docs = await this.col
      .find(
        {
          chatId: { $in: [...approvedChatIds] },
          isStarted: true,
          telegramMembershipStatus: { $in: ['member', 'administrator'] },
        },
        { projection: { chatId: 1 } },
      )
      .toArray();
    return docs.map((d) => d.chatId);
  }
}
