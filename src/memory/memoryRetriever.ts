import type { SceneAnalysis } from '../brain/types.js';
import type { Storage } from '../storage/index.js';
import { jaccard } from './memoryDeduper.js';
import type { MemoryItem, RetrievedMemory } from './types.js';

export interface MemoryRetrieverConfig {
  maxItems: number;
  maxExplicitCallbacks: number;
  itemCooldownMinutes: number;
  subjectCooldownMinutes: number;
}

export interface MemoryRetrievalInput {
  chatId: number;
  currentMessage: string;
  /** Current speaker. Personal lore about unrelated active users should not leak into their turn. */
  currentHandle?: string;
  scene: SceneAnalysis;
  activeHandles: string[];
  mentionedHandles: string[];
  repliedToHandle?: string | null;
  /** Explicit group-memory questions may search across people; ordinary turns stay subject-bound. */
  allowBroadUserRecall?: boolean;
  nsfwEnabled: boolean;
  recentMessages?: string[];
}

/**
 * Retrieve ONLY the memory that helps this specific reply. Never returns the whole store.
 * Heuristic scoring (no embeddings required): handle relevance + keyword/topic overlap + salience,
 * minus recency cooldowns. Honours scene signals (criticism => nothing; shouldUseMemory=false => ≤1).
 */
export class MemoryRetriever {
  constructor(
    private readonly storage: Storage,
    private readonly cfg: MemoryRetrieverConfig,
  ) {}

  async retrieve(input: MemoryRetrievalInput): Promise<RetrievedMemory[]> {
    // If the chat is roasting the bot for being repetitive, do not pile on more callbacks.
    if (input.scene.botIsBeingCriticized) return [];

    const fetched = await this.storage.memoryItems.listActive(input.chatId, 250);
    // Deterministic cross-chat isolation guard (drop anything not belonging to this chat).
    const all = fetched.filter((i) => i.chatId === input.chatId);
    if (all.length === 0) return [];

    const now = Date.now();
    const itemCdMs = this.cfg.itemCooldownMinutes * 60 * 1000;
    const subjectCdMs = this.cfg.subjectCooldownMinutes * 60 * 1000;
    const mentioned = new Set(input.mentionedHandles.map((h) => h.toLowerCase()));
    const active = new Set(input.activeHandles.map((h) => h.toLowerCase()));
    const currentHandle = input.currentHandle?.toLowerCase();
    if (currentHandle) mentioned.add(currentHandle);
    if (input.repliedToHandle) mentioned.add(input.repliedToHandle.toLowerCase());
    const subjectLastUsed = latestUseBySubject(all);

    const scored: RetrievedMemory[] = [];
    for (const item of all) {
      if (!this.toxicityAllowed(item, input.nsfwEnabled)) continue;
      if (!identityMemoryAllowed(item)) continue;
      if (item.lastUsedAt && now - new Date(item.lastUsedAt).getTime() < itemCdMs) continue;

      const handle = (item.subjectHandle ?? '').toLowerCase();
      // Hard attribution boundary: ordinary conversation may only retrieve personal lore for the
      // current/replied/explicitly-mentioned people. Keyword overlap can never pull a random user's
      // biography into somebody else's turn. Broad cross-user recall is opt-in for explicit memory
      // questions/recaps only.
      if (
        item.subjectType === 'user' &&
        handle &&
        !input.allowBroadUserRecall &&
        !mentioned.has(handle)
      ) {
        continue;
      }
      const lastSubjectUse = handle ? subjectLastUsed.get(handle) : undefined;
      if (lastSubjectUse && now - lastSubjectUse < subjectCdMs) continue;
      const ageDays = Math.max(0, (now - new Date(item.lastSeenAt).getTime()) / 86_400_000);
      const freshness = Math.max(0.35, Math.exp(-ageDays / 120));
      let score = item.salience * 0.28 * freshness;
      const reasons: string[] = [];
      if (handle && currentHandle && handle === currentHandle) {
        score += 0.55;
        reasons.push('current speaker');
      } else if (handle && mentioned.has(handle)) {
        score += 0.5;
        reasons.push('subject mentioned');
      } else if (handle && active.has(handle)) {
        score += 0.08;
        reasons.push('subject active');
      }
      const kw = jaccard(item.text, input.currentMessage);
      if (kw > 0) {
        score += kw * 0.4;
        reasons.push('keyword overlap');
      }
      if (input.scene.currentTopic) {
        const t = jaccard(item.text, input.scene.currentTopic);
        if (t > 0) {
          score += t * 0.2;
          reasons.push('topic overlap');
        }
      }
      // group lore gets a small baseline so the bot has callbacks even with no handle match
      if (item.subjectType !== 'user') score += 0.06;
      score -= Math.min(0.32, Math.log1p(item.useCount) * 0.065);

      scored.push({
        item,
        relevance: Math.max(0, Math.min(1, score)),
        reason: reasons.join(', ') || 'baseline salience',
        allowedToUseExplicitly: false,
      });
    }

    scored.sort((a, b) => b.relevance - a.relevance);

    let cap = this.cfg.maxItems;
    if (!input.scene.shouldUseMemory) cap = Math.min(cap, 1);
    const top = diversify(
      scored.filter((r) => r.relevance > 0.24),
      cap,
      currentHandle,
    );

    // allow at most N explicit callbacks (the highest-relevance ones)
    let explicit = 0;
    for (const r of top) {
      if (explicit < this.cfg.maxExplicitCallbacks && r.relevance >= 0.45) {
        r.allowedToUseExplicitly = true;
        explicit += 1;
      }
    }
    return top;
  }

  private toxicityAllowed(item: MemoryItem, nsfw: boolean): boolean {
    if (item.toxicity === 'blocked') return false;
    if (!nsfw && (item.toxicity === 'nsfw' || item.toxicity === 'risky')) return false;
    return true;
  }
}

function identityMemoryAllowed(item: MemoryItem): boolean {
  if (item.subjectType !== 'user') return true;
  const identityLike =
    /\b(?:origin|origine|national|nazional|citizenship|cittadin|passport|passaporto|sard[oa]|spagnol[oa]|sicilian[oa]|italian[oa]|frances[ea]|tedesc[oa])\b/i.test(
      `${item.category} ${item.text}`,
    );
  if (!identityLike) return true;
  // Historical auto-mined identity claims are too damaging when wrong. Only operator/manual
  // curation may make them prompt-visible; social facets have their own repeated-evidence gate.
  return item.source === 'admin' || item.source === 'manual_extract';
}

function latestUseBySubject(items: MemoryItem[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const handle = item.subjectHandle?.toLowerCase();
    if (!handle || !item.lastUsedAt) continue;
    const time = new Date(item.lastUsedAt).getTime();
    result.set(handle, Math.max(result.get(handle) ?? 0, time));
  }
  return result;
}

function diversify(
  scored: RetrievedMemory[],
  cap: number,
  currentHandle: string | undefined,
): RetrievedMemory[] {
  const picked: RetrievedMemory[] = [];
  const subjects = new Map<string, number>();
  const subjectCategories = new Set<string>();
  for (const candidate of scored) {
    const subject = candidate.item.subjectHandle?.toLowerCase() ?? candidate.item.subjectType;
    const count = subjects.get(subject) ?? 0;
    const subjectCap = currentHandle && subject === currentHandle ? 2 : 1;
    const categoryKey = `${subject}:${candidate.item.category}`;
    if (count >= subjectCap || subjectCategories.has(categoryKey)) continue;
    picked.push(candidate);
    subjects.set(subject, count + 1);
    subjectCategories.add(categoryKey);
    if (picked.length >= cap) break;
  }
  return picked;
}
