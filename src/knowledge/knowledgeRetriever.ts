import type { Storage } from '../storage/index.js';
import type { KnowledgeDoc } from '../storage/repositories/knowledge.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('knowledge');

export interface KnowledgeRetrieverConfig {
  enabled: boolean;
  maxItems: number;
}

export interface RetrievedKnowledge {
  topic: string;
  text: string;
  score: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * On-demand knowledge recall (RAG): scores curated entries by alias/topic/tag overlap with the
 * current message + scene topic and returns only the top few that actually match. Most turns match
 * nothing → no prompt weight added, so the character never becomes monothematic. The whole set is
 * cached in memory and refreshed lazily.
 */
export class KnowledgeRetriever {
  private cache: KnowledgeDoc[] | null = null;
  private cacheAt = 0;

  constructor(
    private readonly storage: Storage,
    private readonly cfg: KnowledgeRetrieverConfig,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  async retrieve(message: string, topic = ''): Promise<RetrievedKnowledge[]> {
    if (!this.cfg.enabled) return [];
    const hay = ` ${normalize(`${message} ${topic}`)} `;
    if (hay.trim().length < 3) return [];
    const entries = await this.load();
    if (entries.length === 0) return [];

    const scored: RetrievedKnowledge[] = [];
    for (const e of entries) {
      let hits = 0;
      for (const term of [e.topic, ...e.aliases, ...e.tags]) {
        if (matches(hay, term)) hits += 1;
      }
      if (hits === 0) continue;
      scored.push({ topic: e.topic, text: e.text, score: hits + e.salience });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, this.cfg.maxItems);
  }

  private async load(): Promise<KnowledgeDoc[]> {
    const now = Date.now();
    if (this.cache && now - this.cacheAt < CACHE_TTL_MS) return this.cache;
    try {
      this.cache = await this.storage.knowledge.listAll();
      this.cacheAt = now;
    } catch (err) {
      log.warn({ err }, 'knowledge load failed');
      this.cache = this.cache ?? [];
    }
    return this.cache;
  }
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-word (or phrase) match of a term inside the already-normalized, space-padded haystack. */
function matches(hay: string, term: string): boolean {
  const t = normalize(term);
  if (t.length < 3) return false; // skip noise-prone short tokens
  return hay.includes(` ${t} `) || hay.includes(`${t} `) || hay.includes(` ${t}`);
}
