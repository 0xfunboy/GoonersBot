import type { LLMProvider } from '../providers/llm/types.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import { buildMemoryMiningPrompt, MEMORY_MINING_SYSTEM } from '../prompts/memoryMining.js';
import { memoryMiningResultSchema } from './schemas.js';
import type { MemoryCandidate, MemoryItem } from './types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('memory-miner');

/** Reject obviously sensitive content regardless of what the model returns. */
const SENSITIVE_PATTERNS = [
  /\bpassword\b/i,
  /\bssn\b/i,
  /\bsocial security\b/i,
  /\bcredit card\b/i,
  /\biban\b/i,
  /\bhome address\b/i,
  /\bcodice fiscale\b/i,
  /\b\d{1,5}\s+(via|viale|piazza|corso|street|st|avenue|ave|road|rd)\b/i,
  /\b\+?\d[\d\s().-]{7,}\d\b/, // phone-like
];

export function isSensitiveMemory(text: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

export interface MemoryMinerConfig {
  model: string | undefined;
  temperature: number;
  maxCandidates: number;
  minSalience: number;
}

export interface MemoryMiningInput {
  messages: StoredMessage[];
  existingMemories: MemoryItem[];
  language: string;
  nsfwEnabled: boolean;
  minConfidence: number;
  /** Group-plan model override for manual extraction. */
  model?: string;
}

export class MemoryMiner {
  constructor(
    private readonly llm: LLMProvider,
    private readonly cfg: MemoryMinerConfig,
  ) {}

  /** Extract durable lore candidates from a chat window. Returns [] on any failure (graceful). */
  async extractCandidates(input: MemoryMiningInput): Promise<MemoryCandidate[]> {
    if (input.messages.length === 0) return [];
    const prompt = buildMemoryMiningPrompt({
      messages: input.messages,
      existingMemories: input.existingMemories,
      language: input.language,
      nsfwEnabled: input.nsfwEnabled,
      maxCandidates: this.cfg.maxCandidates,
    });
    const model = input.model ?? this.cfg.model;
    const result = await this.llm.jsonCompletion({
      system: MEMORY_MINING_SYSTEM,
      prompt,
      schema: memoryMiningResultSchema,
      temperature: this.cfg.temperature,
      ...(model ? { model } : {}),
      maxTokens: 1500,
    });
    if (!result) return [];

    const candidates = result.candidates ?? [];
    const accepted: MemoryCandidate[] = [];
    for (const c of candidates) {
      if (c.toxicity === 'blocked') continue;
      if (isSensitiveMemory(c.text) || isSensitiveMemory(c.normalizedText)) continue;
      if (c.confidence < input.minConfidence) continue;
      if (c.salience < this.cfg.minSalience) continue;
      accepted.push({
        subjectType: c.subjectType,
        subjectHandle: c.subjectHandle ?? null,
        involvedHandles: c.involvedHandles ?? [],
        category: c.category,
        text: c.text,
        normalizedText: c.normalizedText,
        confidence: c.confidence,
        salience: c.salience,
        toxicity: c.toxicity,
        sourceMessageIds: c.sourceMessageIds ?? [],
        reason: c.reason ?? '',
      });
      if (accepted.length >= this.cfg.maxCandidates) break;
    }
    log.debug({ returned: candidates.length, accepted: accepted.length }, 'mined candidates');
    return accepted;
  }
}
