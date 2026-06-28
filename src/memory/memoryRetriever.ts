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
  scene: SceneAnalysis;
  activeHandles: string[];
  mentionedHandles: string[];
  repliedToHandle?: string | null;
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
    const mentioned = new Set(input.mentionedHandles.map((h) => h.toLowerCase()));
    const active = new Set(input.activeHandles.map((h) => h.toLowerCase()));
    if (input.repliedToHandle) mentioned.add(input.repliedToHandle.toLowerCase());

    const scored: RetrievedMemory[] = [];
    for (const item of all) {
      if (!this.toxicityAllowed(item, input.nsfwEnabled)) continue;
      if (item.lastUsedAt && now - new Date(item.lastUsedAt).getTime() < itemCdMs) continue;

      const handle = (item.subjectHandle ?? '').toLowerCase();
      let score = item.salience * 0.3;
      const reasons: string[] = [];
      if (handle && mentioned.has(handle)) {
        score += 0.5;
        reasons.push('subject mentioned');
      } else if (handle && active.has(handle)) {
        score += 0.3;
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
      if (item.subjectType !== 'user') score += 0.1;

      scored.push({
        item,
        relevance: Math.min(1, score),
        reason: reasons.join(', ') || 'baseline salience',
        allowedToUseExplicitly: false,
      });
    }

    scored.sort((a, b) => b.relevance - a.relevance);

    let cap = this.cfg.maxItems;
    if (!input.scene.shouldUseMemory) cap = Math.min(cap, 1);
    const top = scored.slice(0, cap).filter((r) => r.relevance > 0.2);

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
