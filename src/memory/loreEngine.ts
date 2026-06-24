import type { Storage } from '../storage/index.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import type { MemoryMiner } from './memoryMiner.js';
import { isSensitiveMemory } from './memoryMiner.js';
import { findDuplicate } from './memoryDeduper.js';
import type { MemoryCandidate, MemoryItem, MemoryCategory, MemorySubjectType } from './types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('lore-engine');

export interface MineAndStoreResult {
  stored: number;
  reinforced: number;
  candidates: number;
}

/**
 * LoreEngine: the single entry point for reading/writing durable memory. It mines, dedupes,
 * persists, reinforces, retrieves and expires `memory_items`. Reply generation never dumps raw
 * memory - it goes through the retriever.
 */
export class LoreEngine {
  constructor(
    private readonly storage: Storage,
    private readonly miner: MemoryMiner,
  ) {}

  /** Mine a window and persist accepted candidates (dedup-aware). */
  async mineAndStore(params: {
    chatId: number;
    messages: StoredMessage[];
    language: string;
    nsfwEnabled: boolean;
    minConfidence: number;
    source: MemoryItem['source'];
    createdByHandle: string | null;
    model?: string;
  }): Promise<MineAndStoreResult> {
    const existing = await this.storage.memoryItems.listActive(params.chatId, 300);
    const candidates = await this.miner.extractCandidates({
      messages: params.messages,
      existingMemories: existing,
      language: params.language,
      nsfwEnabled: params.nsfwEnabled,
      minConfidence: params.minConfidence,
      ...(params.model ? { model: params.model } : {}),
    });

    let stored = 0;
    let reinforced = 0;
    for (const c of candidates) {
      const dup = findDuplicate(c, existing);
      if (dup && dup._id) {
        await this.storage.memoryItems.reinforce(dup._id, c.sourceMessageIds);
        reinforced += 1;
        continue;
      }
      try {
        const item = await this.storage.memoryItems.insertCandidate(
          params.chatId,
          c,
          params.source,
          params.createdByHandle,
        );
        existing.push(item);
        stored += 1;
      } catch (err) {
        // unique-index race on normalizedText => treat as reinforce-noop
        log.debug({ err }, 'insert candidate skipped (duplicate)');
      }
    }
    log.info(
      { chatId: params.chatId, candidates: candidates.length, stored, reinforced },
      'mineAndStore',
    );
    return { stored, reinforced, candidates: candidates.length };
  }

  /** Admin manual insert (/setfact). Returns false if rejected (sensitive/empty). */
  async addManual(params: {
    chatId: number;
    subjectHandle: string | null;
    text: string;
    createdByHandle: string;
    toxicity?: MemoryItem['toxicity'];
  }): Promise<boolean> {
    const text = params.text.trim();
    if (text.length === 0 || isSensitiveMemory(text)) return false;
    const subjectType: MemorySubjectType = params.subjectHandle ? 'user' : 'group';
    const category: MemoryCategory = params.subjectHandle ? 'reputation' : 'group_lore';
    const candidate: MemoryCandidate = {
      subjectType,
      subjectHandle: params.subjectHandle,
      involvedHandles: params.subjectHandle ? [params.subjectHandle] : [],
      category,
      text,
      normalizedText: text.toLowerCase().replace(/\s+/g, ' ').trim(),
      confidence: 0.9,
      salience: 0.7,
      toxicity: params.toxicity ?? 'clean',
      sourceMessageIds: [],
      reason: 'admin manual insert',
    };
    const existing = await this.storage.memoryItems.listActive(params.chatId, 300);
    const dup = findDuplicate(candidate, existing);
    if (dup && dup._id) {
      await this.storage.memoryItems.reinforce(dup._id, []);
      return true;
    }
    await this.storage.memoryItems.insertCandidate(
      params.chatId,
      candidate,
      'admin',
      params.createdByHandle,
    );
    return true;
  }

  listForSubject(chatId: number, subjectHandle: string): Promise<MemoryItem[]> {
    return this.storage.memoryItems.listForSubject(chatId, subjectHandle, ['active']);
  }

  topLore(chatId: number, limit = 5): Promise<MemoryItem[]> {
    return this.storage.memoryItems.listTopLore(chatId, limit);
  }

  listActive(chatId: number, limit = 200): Promise<MemoryItem[]> {
    return this.storage.memoryItems.listActive(chatId, limit);
  }

  expireForSubject(chatId: number, subjectHandle: string): Promise<number> {
    return this.storage.memoryItems.expireBySubject(chatId, subjectHandle);
  }

  expireById(chatId: number, id: string): Promise<boolean> {
    return this.storage.memoryItems.expireById(chatId, id);
  }

  expireBySourceMessage(chatId: number, messageId: number): Promise<number> {
    return this.storage.memoryItems.expireBySourceMessage(chatId, messageId);
  }

  markUsed(ids: string[]): Promise<void> {
    return this.storage.memoryItems.markUsed(ids);
  }

  adjustSalience(id: string, delta: number, positive: boolean): Promise<void> {
    return this.storage.memoryItems.adjustSalience(id, delta, positive);
  }
}
