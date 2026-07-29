import type { Collection, Db } from 'mongodb';
import type {
  ChatMembershipEventDoc,
  TelegramMembershipStatus,
} from '../../domain/entities.js';

export interface RecordMembershipEvent {
  chatId: number;
  chatName?: string;
  status: TelegramMembershipStatus;
  previousStatus?: TelegramMembershipStatus;
  source: ChatMembershipEventDoc['source'];
  updateId?: number;
  occurredAt?: Date;
}

/** Append-only, idempotent audit trail for Telegram bot membership changes and audits. */
export class ChatMembershipEventsRepo {
  private readonly col: Collection<ChatMembershipEventDoc>;

  constructor(db: Db) {
    this.col = db.collection<ChatMembershipEventDoc>('chat_membership_events');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<ChatMembershipEventDoc>('chat_membership_events');
    await col.createIndex({ chatId: 1, occurredAt: -1 });
    await col.createIndex(
      { updateId: 1 },
      {
        unique: true,
        partialFilterExpression: { updateId: { $type: 'number' } },
      },
    );
  }

  async record(event: RecordMembershipEvent): Promise<void> {
    const occurredAt = event.occurredAt ?? new Date();
    const doc: ChatMembershipEventDoc = {
      chatId: event.chatId,
      status: event.status,
      source: event.source,
      occurredAt,
      createdAt: new Date(),
      ...(event.chatName ? { chatName: event.chatName } : {}),
      ...(event.previousStatus ? { previousStatus: event.previousStatus } : {}),
      ...(event.updateId !== undefined ? { updateId: event.updateId } : {}),
    };
    if (event.updateId === undefined) {
      await this.col.insertOne(doc);
      return;
    }
    await this.col.updateOne({ updateId: event.updateId }, { $setOnInsert: doc }, { upsert: true });
  }
}
