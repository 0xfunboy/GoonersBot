export interface Scored<T> {
  value: T;
  score: number;
  reason: string;
}

export interface SemanticRetriever<T> {
  retrieve(queryText: string, k: number): Promise<Scored<T>[]>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  const score = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(score) ? score : 0;
}
