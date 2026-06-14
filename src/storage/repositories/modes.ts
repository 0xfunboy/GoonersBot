import { ObjectId, type Collection, type Db, type WithId } from 'mongodb';
import type { ModeDoc } from '../../domain/entities.js';
import type { BuiltinMode } from '../../config/modes.js';

export interface ModeView {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
}

export class ModesRepo {
  private readonly col: Collection<ModeDoc>;

  constructor(db: Db) {
    this.col = db.collection<ModeDoc>('modes');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<ModeDoc>('modes');
    await col.createIndex({ chatId: 1, name: 1 }, { unique: true });
    await col.createIndex({ chatId: 1, isActive: 1 });
  }

  /** Seed built-in modes for a chat (idempotent; never overwrites a customized description). */
  async seedDefaults(chatId: number, modes: BuiltinMode[]): Promise<void> {
    const now = new Date();
    for (const mode of modes) {
      await this.col.updateOne(
        { chatId, name: mode.name },
        {
          $setOnInsert: {
            chatId,
            name: mode.name,
            description: mode.description,
            isBuiltin: true,
            isActive: false,
            createdByHandle: null,
            createdAt: now,
          },
        },
        { upsert: true },
      );
    }
  }

  private toView(doc: WithId<ModeDoc>): ModeView {
    return {
      id: doc._id.toString(),
      name: doc.name,
      description: doc.description,
      isActive: doc.isActive,
    };
  }

  async list(chatId: number): Promise<ModeView[]> {
    const docs = await this.col.find({ chatId }).sort({ createdAt: 1 }).toArray();
    return docs.map((d) => this.toView(d));
  }

  /** Active mode, or the first mode as fallback (mirrors original behaviour). */
  async getActive(chatId: number): Promise<ModeView | null> {
    const active = await this.col.findOne({ chatId, isActive: true });
    if (active) return this.toView(active);
    const first = await this.col.find({ chatId }).sort({ createdAt: 1 }).limit(1).next();
    return first ? this.toView(first) : null;
  }

  async getNameById(chatId: number, modeId: string): Promise<string | null> {
    if (!ObjectId.isValid(modeId)) return null;
    const doc = await this.col.findOne(
      { chatId, _id: new ObjectId(modeId) },
      { projection: { name: 1 } },
    );
    return doc?.name ?? null;
  }

  async setActive(chatId: number, modeId: string): Promise<boolean> {
    if (!ObjectId.isValid(modeId)) return false;
    await this.col.updateMany({ chatId }, { $set: { isActive: false } });
    const res = await this.col.updateOne(
      { chatId, _id: new ObjectId(modeId) },
      { $set: { isActive: true } },
    );
    return res.matchedCount > 0;
  }

  async delete(chatId: number, modeId: string): Promise<boolean> {
    if (!ObjectId.isValid(modeId)) return false;
    const res = await this.col.deleteOne({ chatId, _id: new ObjectId(modeId) });
    return res.deletedCount > 0;
  }

  /**
   * Add a custom mode. Returns false if a mode with that name already exists in the chat.
   */
  async add(
    chatId: number,
    name: string,
    description: string,
    createdByHandle: string,
  ): Promise<boolean> {
    const existing = await this.col.findOne({ chatId, name });
    if (existing) return false;
    await this.col.insertOne({
      chatId,
      name,
      description,
      isBuiltin: false,
      isActive: false,
      createdByHandle,
      createdAt: new Date(),
    });
    return true;
  }

  /** Remove all custom modes added by a user (for data wipe). */
  async deleteByCreator(handle: string): Promise<void> {
    await this.col.deleteMany({ createdByHandle: handle });
  }
}
