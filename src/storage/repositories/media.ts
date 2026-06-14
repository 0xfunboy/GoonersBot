import type { Collection, Db } from 'mongodb';
import type { MediaDoc, MediaDirection, MediaKind } from '../../domain/entities.js';

export class MediaRepo {
  private readonly col: Collection<MediaDoc>;

  constructor(db: Db) {
    this.col = db.collection<MediaDoc>('media');
  }

  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection<MediaDoc>('media');
    await col.createIndex({ chatId: 1, createdAt: -1 });
    await col.createIndex({ handle: 1 });
    await col.createIndex({ createdAt: 1 });
  }

  async record(input: {
    chatId: number;
    handle: string;
    direction: MediaDirection;
    kind: MediaKind;
    description?: string | null;
    url?: string | null;
    byteSize?: number | null;
  }): Promise<void> {
    await this.col.insertOne({
      chatId: input.chatId,
      handle: input.handle,
      direction: input.direction,
      kind: input.kind,
      description: input.description ?? null,
      url: input.url ?? null,
      byteSize: input.byteSize ?? null,
      createdAt: new Date(),
    });
  }
}
