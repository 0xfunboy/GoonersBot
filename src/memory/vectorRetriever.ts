import type { SceneAnalysis } from '../brain/types.js';
import type { Embedder } from '../rag/embedder.js';
import { cosineSimilarity } from '../rag/types.js';
import type { Storage } from '../storage/index.js';
import { jaccard } from './memoryDeduper.js';
import type { MemoryItem, RetrievedMemory } from './types.js';
import type { MemoryRetrieverConfig, MemoryRetrievalInput } from './memoryRetriever.js';
import { redactSecrets } from '../utils/secrets.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('vector-retriever');

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

    const fetched = await this.storage.memoryItems.listActive(input.chatId, 250);
    // Deterministic cross-chat isolation: never consider an item that does not belong to this chat,
    // even if a query ever returned one. A mismatch is an upstream bug, so make it loud.
    const all = fetched.filter((i) => i.chatId === input.chatId);
    if (all.length !== fetched.length) {
      log.error(
        { chatId: input.chatId, dropped: fetched.length - all.length },
        'cross-chat memory items returned by query; dropped (isolation guard)',
      );
    }
    if (all.length === 0) return [];

    const queryText = buildQueryText(input);
    const queryVec = this.embedder.enabled
      ? ((await this.embedder.embed([queryText]))[0] ?? [])
      : [];
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
      if (!toxicityAllowed(item, input.nsfwEnabled)) continue;
      if (item.lastUsedAt && now - new Date(item.lastUsedAt).getTime() < itemCdMs) continue;

      const handle = (item.subjectHandle ?? '').toLowerCase();
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

      const cosine =
        queryVec.length === this.cfg.embeddingDim &&
        item.embedding?.length === this.cfg.embeddingDim
          ? cosineSimilarity(queryVec, item.embedding)
          : 0;
      if (cosine >= this.cfg.minScore) {
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
      if (item.subjectType !== 'user') score += 0.06;
      score -= Math.min(0.32, Math.log1p(item.useCount) * 0.065);

      scored.push({
        item,
        relevance: Math.max(0, Math.min(1, score)),
        cosineScore: cosine,
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

function buildQueryText(input: MemoryRetrievalInput): string {
  // Redact secrets so they are never sent to the embedding endpoint.
  return redactSecrets(
    [input.currentMessage, input.scene.currentTopic, ...(input.recentMessages ?? []).slice(-3)]
      .filter(Boolean)
      .join(' '),
  );
}

function toxicityAllowed(item: MemoryItem, nsfw: boolean): boolean {
  if (item.toxicity === 'blocked') return false;
  if (!nsfw && (item.toxicity === 'nsfw' || item.toxicity === 'risky')) return false;
  return true;
}

export type VectorMemoryRetrievalInput = MemoryRetrievalInput & { scene: SceneAnalysis };
