import type { Collection, Db } from 'mongodb';
import type { ChatMemberDoc } from '../../domain/entities.js';
import type { Person } from '../../domain/types.js';

export class ChatMembersRepo {
  private readonly col: Collection<ChatMemberDoc>;

  constructor(db: Db) {
    this.col = db.collection<ChatMemberDoc>('chat_members');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<ChatMemberDoc>('chat_members');
    await col.createIndex({ chatId: 1, handle: 1 }, { unique: true });
    await col.createIndex({ chatId: 1 });
  }

  async touch(chatId: number, person: Person): Promise<void> {
    await this.col.updateOne(
      { chatId, handle: person.userHandle },
      {
        $setOnInsert: { chatId, handle: person.userHandle },
        $set: { telegramId: person.telegramId, lastSeenAt: new Date() },
        $inc: { messageCount: 1 },
      },
      { upsert: true },
    );
  }

  async listHandles(chatId: number): Promise<string[]> {
    const docs = await this.col.find({ chatId }, { projection: { handle: 1 } }).toArray();
    return docs.map((d) => d.handle);
  }
}
