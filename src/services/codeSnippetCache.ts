import crypto from 'node:crypto';

interface CachedSnippet {
  code: string;
  context?: string;
  createdAt: number;
}

const cache = new Map<string, CachedSnippet>();
const MAX_CACHE = 200;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function prune(): void {
  const now = Date.now();
  for (const [id, entry] of cache.entries()) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      cache.delete(id);
    }
  }
  while (cache.size > MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
    else break;
  }
}

/** Cache code snippets from messages for quick peer-review fix actions */
export function cacheCodeSnippet(code: string, context?: string): string {
  prune();
  const id = crypto.randomBytes(6).toString('hex');
  cache.set(id, {
    code,
    context,
    createdAt: Date.now(),
  });
  return id;
}

/** Retrieve cached code snippet */
export function getCachedCodeSnippet(id: string): { code: string; context?: string } | undefined {
  prune();
  return cache.get(id);
}
