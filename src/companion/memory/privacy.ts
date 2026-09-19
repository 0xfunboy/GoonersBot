import { createHash } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { normalizeSocialHandle } from '../../social/evolution.js';

interface ErasureTombstone {
  _id: string;
  erasedAt: Date;
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const textKey = (chatId: number, text: string): string =>
  digest(`text:${chatId}:${text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()}`);
const handleKey = (handle: string): string => digest(`handle:${normalizeSocialHandle(handle)}`);

/** No erased plaintext is retained. No TTL: old backups must not resurrect opted-out profiles. */
export class MemoryPrivacyGuard {
  private readonly col: Collection<ErasureTombstone>;
  constructor(db: Db) {
    this.col = db.collection<ErasureTombstone>('memory_erasure_tombstones');
  }

  async blockHandles(handles: string[], actorTelegramId?: number): Promise<void> {
    const keys = handles.filter((handle) => normalizeSocialHandle(handle)).map(handleKey);
    if (actorTelegramId) keys.push(digest(`actor:${actorTelegramId}`));
    await this.block(keys);
  }

  async blockMemory(chatId: number, text: string, sourceIds: number[]): Promise<void> {
    await this.block([
      textKey(chatId, text),
      ...sourceIds.map((id) => digest(`message:${chatId}:${id}`)),
    ]);
  }

  async allowsHandles(
    handles: (string | null | undefined)[],
    actorTelegramId?: number | null,
  ): Promise<boolean> {
    const keys = handles
      .filter((handle): handle is string => Boolean(handle && normalizeSocialHandle(handle)))
      .map(handleKey);
    if (actorTelegramId) keys.push(digest(`actor:${actorTelegramId}`));
    return this.allowed(keys);
  }

  async allowsMemory(
    chatId: number,
    memory: {
      text: string;
      sourceMessageIds: number[];
      subjectHandle?: string | null;
      involvedHandles?: string[];
      createdByHandle?: string | null;
    },
  ): Promise<boolean> {
    const handles = [
      memory.subjectHandle,
      memory.createdByHandle,
      ...(memory.involvedHandles ?? []),
    ];
    return (
      (await this.allowsHandles(handles)) &&
      (await this.allowed([
        textKey(chatId, memory.text),
        ...memory.sourceMessageIds.map((id) => digest(`message:${chatId}:${id}`)),
      ]))
    );
  }

  async allowsSources(chatId: number, sourceIds: number[]): Promise<boolean> {
    return this.allowed(sourceIds.map((id) => digest(`message:${chatId}:${id}`)));
  }

  private async allowed(keys: string[]): Promise<boolean> {
    return (
      !keys.length || !(await this.col.findOne({ _id: { $in: keys } }, { projection: { _id: 1 } }))
    );
  }
  private async block(keys: string[]): Promise<void> {
    for (const key of new Set(keys))
      await this.col.updateOne({ _id: key }, { $set: { erasedAt: new Date() } }, { upsert: true });
  }
}
