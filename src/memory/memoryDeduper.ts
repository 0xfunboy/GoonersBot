import type { MemoryCandidate, MemoryItem } from './types.js';

/** Tokenize for similarity (lowercase words, length >= 3). */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

/** Jaccard similarity between two token sets. */
export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export const SIMILARITY_DUP_THRESHOLD = 0.6;

/**
 * Find an existing active memory that a candidate duplicates:
 * exact normalizedText, OR same subject+category with high text similarity.
 */
export function findDuplicate(
  candidate: MemoryCandidate,
  existing: MemoryItem[],
): MemoryItem | null {
  const candNorm = candidate.normalizedText.trim().toLowerCase();
  for (const item of existing) {
    if (item.status !== 'active') continue;
    if (item.normalizedText.trim().toLowerCase() === candNorm) return item;
    const sameSubject = (item.subjectHandle ?? null) === (candidate.subjectHandle ?? null);
    const sameCategory = item.category === candidate.category;
    if (
      sameSubject &&
      sameCategory &&
      jaccard(item.text, candidate.text) >= SIMILARITY_DUP_THRESHOLD
    ) {
      return item;
    }
  }
  return null;
}
