import type { SceneAnalysis } from '../brain/types.js';
import type { Embedder } from '../rag/embedder.js';
import { cosineSimilarity } from '../rag/types.js';
import type { Storage } from '../storage/index.js';
import { jaccard } from './memoryDeduper.js';
import type { MemoryItem, RetrievedMemory } from './types.js';
import type { MemoryRetrieverConfig, MemoryRetrievalInput } from './memoryRetriever.js';

export interface VectorMemoryRetrieverConfig extends MemoryRetrieverConfig {
  embeddingDim: number;
  minScore: number;
}

export class VectorMemoryRetriever {
  constructor(
    private readonly storage: Storage,
    private readonly embedder: Embedder,
    private readonly cfg: VectorMemoryRetrieverConfig,
  ) {}

  async retrieve(input: MemoryRetrievalInput): Promise<RetrievedMemory[]> {
    if (input.scene.botIsBeingCriticized) return [];

    const all = await this.storage.memoryItems.listActive(input.chatId, 250);
    if (all.length === 0) return [];

    const queryText = buildQueryText(input);
    const queryVec = this.embedder.enabled
      ? ((await this.embedder.embed([queryText]))[0] ?? [])
      : [];
    const now = Date.now();
    const itemCdMs = this.cfg.itemCooldownMinutes * 60 * 1000;
    const mentioned = new Set(input.mentionedHandles.map((h) => h.toLowerCase()));
    const active = new Set(input.activeHandles.map((h) => h.toLowerCase()));
    if (input.repliedToHandle) mentioned.add(input.repliedToHandle.toLowerCase());

    const scored: RetrievedMemory[] = [];
    for (const item of all) {
      if (!toxicityAllowed(item, input.nsfwEnabled)) continue;
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

      const cosine =
        queryVec.length === this.cfg.embeddingDim &&
        item.embedding?.length === this.cfg.embeddingDim
          ? cosineSimilarity(queryVec, item.embedding)
          : 0;
      if (cosine > 0) {
        score += cosine * 0.4;
        reasons.push(`cos ${cosine.toFixed(2)}`);
      } else {
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
      }
      if (item.subjectType !== 'user') score += 0.1;

      scored.push({
        item,
        relevance: Math.min(1, score),
        cosineScore: cosine,
        reason: reasons.join(', ') || 'baseline salience',
        allowedToUseExplicitly: false,
      });
    }

    scored.sort((a, b) => b.relevance - a.relevance);

    let cap = this.cfg.maxItems;
    if (!input.scene.shouldUseMemory) cap = Math.min(cap, 1);
    const top = scored.slice(0, cap).filter((r) => r.relevance > 0.2);

    let explicit = 0;
    for (const r of top) {
      if (explicit < this.cfg.maxExplicitCallbacks && r.relevance >= 0.45) {
        r.allowedToUseExplicitly = true;
        explicit += 1;
      }
    }
    return top;
  }
}

function buildQueryText(input: MemoryRetrievalInput): string {
  return [input.currentMessage, input.scene.currentTopic, ...(input.recentMessages ?? []).slice(-3)]
    .filter(Boolean)
    .join(' ');
}

function toxicityAllowed(item: MemoryItem, nsfw: boolean): boolean {
  if (item.toxicity === 'blocked') return false;
  if (!nsfw && (item.toxicity === 'nsfw' || item.toxicity === 'risky')) return false;
  return true;
}

export type VectorMemoryRetrievalInput = MemoryRetrievalInput & { scene: SceneAnalysis };
