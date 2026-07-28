import type { Storage } from '../storage/index.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import type { MemoryMiner } from './memoryMiner.js';
import { isSensitiveMemory, isUnsafeSocialMemory } from './memoryMiner.js';
import { findDuplicate } from './memoryDeduper.js';
import type { MemoryCandidate, MemoryItem, MemoryCategory, MemorySubjectType } from './types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('lore-engine');

function sameSubject(
  left: Pick<MemoryItem, 'subjectType' | 'subjectHandle'>,
  right: Pick<MemoryCandidate, 'subjectType' | 'subjectHandle'>,
): boolean {
  return (
    left.subjectType === right.subjectType &&
    (left.subjectHandle ?? '').trim().toLowerCase() ===
      (right.subjectHandle ?? '').trim().toLowerCase()
  );
}

export interface MineAndStoreResult {
  stored: number;
  reinforced: number;
  updated: number;
  expired: number;
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
    eligibleSourceMessageIds?: readonly number[];
  }): Promise<MineAndStoreResult> {
    const [existing, knownHandles] = await Promise.all([
      this.storage.memoryItems.listActive(params.chatId, 300),
      this.storage.chatMembers.listHandles(params.chatId),
    ]);
    const candidates = await this.miner.extractCandidates({
      messages: params.messages,
      existingMemories: existing,
      language: params.language,
      nsfwEnabled: params.nsfwEnabled,
      minConfidence: params.minConfidence,
      eligibleSourceMessageIds: params.eligibleSourceMessageIds,
      knownHandles,
    });

    let stored = 0;
    let reinforced = 0;
    let updated = 0;
    let expired = 0;
    for (const c of candidates) {
      const target =
        c.targetMemoryId != null
          ? existing.find((item) => item._id === c.targetMemoryId)
          : undefined;
      if (c.operation === 'expire') {
        if (
          target?._id &&
          target.chatId === params.chatId &&
          c.confidence >= 0.82 &&
          c.sourceMessageIds.length > 0 &&
          sameSubject(target, c)
        ) {
          if (await this.storage.memoryItems.expireById(params.chatId, target._id)) {
            target.status = 'expired';
            expired += 1;
          }
        }
        continue;
      }
      if (c.operation === 'update') {
        const compatibleCategory =
          target?.category === c.category ||
          (target?.category === 'recurring_topic' && c.category === 'preference') ||
          (target?.category === 'preference' && c.category === 'recurring_topic');
        if (
          target?._id &&
          target.chatId === params.chatId &&
          sameSubject(target, c) &&
          compatibleCategory &&
          c.confidence >= 0.72 &&
          c.sourceMessageIds.length > 0 &&
          (await this.storage.memoryItems.updateFromCandidate(target._id, c))
        ) {
          Object.assign(target, c, {
            status: 'active',
            revision: (target.revision ?? 1) + 1,
            updatedAt: new Date(),
          });
          updated += 1;
        }
        // `update` is never a fallback insertion. Invalid/missing targets require fresh evidence
        // from a later pass rather than silently creating a contradictory second item.
        continue;
      }
      if (c.operation === 'reinforce') {
        if (
          target?._id &&
          target.chatId === params.chatId &&
          sameSubject(target, c) &&
          (await this.storage.memoryItems.reinforce(target._id, c.sourceMessageIds))
        ) {
          reinforced += 1;
        }
        // `reinforce` without its exact target is not a new memory.
        continue;
      }
      const dup = findDuplicate(c, existing);
      if (dup && dup._id) {
        if (await this.storage.memoryItems.reinforce(dup._id, c.sourceMessageIds)) {
          reinforced += 1;
        }
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
      {
        chatId: params.chatId,
        candidates: candidates.length,
        stored,
        reinforced,
        updated,
        expired,
      },
      'mineAndStore',
    );
    return { stored, reinforced, updated, expired, candidates: candidates.length };
  }

  /** Admin manual insert (/setfact). Returns false if rejected (sensitive/empty). */
  async addManual(params: {
    chatId: number;
    subjectHandle: string | null;
    text: string;
    createdByHandle: string;
    toxicity?: MemoryItem['toxicity'];
    category?: MemoryCategory;
    source?: Extract<MemoryItem['source'], 'self_declared' | 'admin'>;
  }): Promise<boolean> {
    const text = params.text.trim();
    if (text.length === 0 || isSensitiveMemory(text) || isUnsafeSocialMemory(text)) return false;
    const subjectType: MemorySubjectType = params.subjectHandle ? 'user' : 'group';
    const category: MemoryCategory =
      params.category ?? (params.subjectHandle ? 'reputation' : 'group_lore');
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
      params.source ?? 'admin',
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

  /** Boot-safe hygiene for legacy lore written before provenance and social-safety rules existed. */
  async maintainLegacyMemory(chatId: number): Promise<{ unsafeExpired: number; cooled: number }> {
    const active = await this.storage.memoryItems.listActive(chatId, 1_000);
    let unsafeExpired = 0;
    for (const item of active) {
      if (item._id && isUnsafeSocialMemory(item.text)) {
        if (await this.storage.memoryItems.expireById(chatId, item._id)) unsafeExpired += 1;
      }
    }
    const cooled = await this.storage.memoryItems.coolOverused(chatId);
    return { unsafeExpired, cooled };
  }
}
