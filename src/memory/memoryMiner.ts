import type { LLMProvider } from '../providers/llm/types.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import {
  buildMemoryMiningPrompt,
  MEMORY_MINING_SCHEMA_HINT,
  MEMORY_MINING_SYSTEM,
} from '../prompts/memoryMining.js';
import { memoryMiningResultSchema } from './schemas.js';
import type { MemoryCandidate, MemoryItem } from './types.js';
import { childLogger } from '../utils/logger.js';
import { containsSensitive } from '../utils/secrets.js';
import { normalizeHandle } from '../utils/handles.js';

const log = childLogger('memory-miner');
const EPISODIC_CATEGORIES = new Set<MemoryCandidate['category']>(['meme', 'quote', 'group_lore']);

/**
 * Reject content that is sensitive (secrets, credentials, infrastructure or personal data) no matter
 * what the model returns, so it never enters durable memory, RAG candidates or embeddings.
 */
export function isSensitiveMemory(text: string): boolean {
  return containsSensitive(text);
}

const IDENTITY_ATTACK_RE =
  /\b(froci[oa]?|ricchion[ei]?|finocchi[oa]?|negro|nigger|retard(?:ed)?|ritardat[oaie]|autistic[oa]? livello|autismo livello)\b/i;
const INTIMATE_OR_ALLEGATION_RE =
  /\b(micropene|ha il pene|penis size|stuprator|pedofil|evasore|criminale|spacciatore)\b/i;

/**
 * Durable memory has a higher bar than chat banter. Identity attacks, diagnoses, intimate-body
 * claims and bare criminal allegations are never useful profile material even when the room is
 * vulgar. This does not censor the conversation; it prevents a transient insult becoming a person.
 */
export function isUnsafeSocialMemory(text: string): boolean {
  return IDENTITY_ATTACK_RE.test(text) || INTIMATE_OR_ALLEGATION_RE.test(text);
}

export interface MemoryMinerConfig {
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
  /**
   * Optional subset of human message ids that this pass may use as new evidence. This is useful
   * for overlapping context windows: older messages can provide context without being presented
   * as fresh reinforcement.
   */
  eligibleSourceMessageIds?: readonly number[];
  /** Handles known by the chat roster even when they did not speak in this particular window. */
  knownHandles?: readonly string[];
}

/** Canonical persisted form; never trust the model-provided normalizedText field. */
export function normalizeMemoryText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstDefined(
  record: Readonly<Record<string, unknown>>,
  names: readonly string[],
): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return undefined;
}

const MEMORY_ENUMS = {
  subjectType: new Set(['user', 'group', 'relationship', 'meme', 'quote', 'event', 'running_joke']),
  category: new Set([
    'nickname',
    'role',
    'running_joke',
    'meme',
    'preference',
    'quote',
    'group_lore',
    'relationship',
    'reputation',
    'recurring_topic',
    'chat_rule',
    'style_signal',
  ]),
  toxicity: new Set(['clean', 'vulgar', 'nsfw', 'risky', 'blocked']),
  operation: new Set(['new', 'reinforce', 'update', 'expire']),
} as const;

function canonicalEnum(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (typeof value !== 'string') return value;
  const canonical = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
  return allowed.has(canonical) ? canonical : value;
}

function unitNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(trimmed)) return value;
  return Number(trimmed);
}

function evidenceId(value: unknown, validMessageIds: ReadonlySet<number>): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const match = /^#?(\d+)$/u.exec(value.trim());
  if (!match) return value;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 && validMessageIds.has(parsed) ? parsed : value;
}

/**
 * Normalize serialization-only deviations commonly produced by local OpenAI-compatible models.
 * This never invents a fact: it unwraps the declared root, accepts snake_case spellings, converts
 * exact numeric strings and derives normalizedText from the candidate's own text. Unsupported
 * enums and unobserved evidence ids deliberately remain invalid so Zod/repair and the provenance
 * firewall retain authority.
 */
export function normalizeMemoryMiningCandidate(
  candidate: unknown,
  validMessageIds: ReadonlySet<number>,
): unknown {
  const root = Array.isArray(candidate) ? { candidates: candidate } : objectRecord(candidate);
  if (!root) return candidate;

  const rootCandidates = firstDefined(root, [
    'candidates',
    'memoryCandidates',
    'memory_candidates',
  ]);
  const looksLikeSingleCandidate =
    rootCandidates === undefined &&
    firstDefined(root, ['text']) !== undefined &&
    firstDefined(root, ['category']) !== undefined;
  const rawCandidates =
    rootCandidates === null
      ? []
      : Array.isArray(rootCandidates)
        ? rootCandidates
        : objectRecord(rootCandidates)
          ? [rootCandidates]
          : looksLikeSingleCandidate
            ? [root]
            : null;
  if (!rawCandidates) return candidate;

  const candidates = rawCandidates.map((value) => {
    const raw = objectRecord(value);
    if (!raw) return value;
    const normalized: Record<string, unknown> = { ...raw };
    const aliases: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['subjectType', ['subject_type']],
      ['subjectHandle', ['subject_handle']],
      ['involvedHandles', ['involved_handles']],
      ['normalizedText', ['normalized_text']],
      ['sourceMessageIds', ['source_message_ids']],
      ['targetMemoryId', ['target_memory_id']],
    ];
    for (const [field, names] of aliases) {
      if (normalized[field] === undefined) normalized[field] = firstDefined(raw, names);
    }

    for (const field of ['subjectType', 'category', 'toxicity', 'operation'] as const) {
      normalized[field] = canonicalEnum(normalized[field], MEMORY_ENUMS[field]);
    }
    normalized['confidence'] = unitNumber(normalized['confidence']);
    normalized['salience'] = unitNumber(normalized['salience']);

    if (normalized['involvedHandles'] === null) normalized['involvedHandles'] = [];
    else if (typeof normalized['involvedHandles'] === 'string') {
      normalized['involvedHandles'] = [normalized['involvedHandles']];
    }

    const rawSourceIds = normalized['sourceMessageIds'];
    if (rawSourceIds === null) normalized['sourceMessageIds'] = [];
    else if (Array.isArray(rawSourceIds)) {
      normalized['sourceMessageIds'] = rawSourceIds.map((id) => evidenceId(id, validMessageIds));
    } else if (rawSourceIds !== undefined) {
      normalized['sourceMessageIds'] = [evidenceId(rawSourceIds, validMessageIds)];
    }

    if (
      (normalized['normalizedText'] === undefined || normalized['normalizedText'] === null) &&
      typeof normalized['text'] === 'string'
    ) {
      normalized['normalizedText'] = normalizeMemoryText(normalized['text']);
    }
    if (normalized['subjectHandle'] === '') normalized['subjectHandle'] = null;
    if (normalized['targetMemoryId'] === '') normalized['targetMemoryId'] = null;
    return normalized;
  });
  return { candidates };
}

function sourceIdSet(input: MemoryMiningInput): Set<number> {
  const humanWindowIds = new Set(
    input.messages
      .filter((message) => !message.isBot)
      .map((message) => message.messageId)
      .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0),
  );
  if (input.eligibleSourceMessageIds === undefined) return humanWindowIds;
  const eligible = new Set(
    input.eligibleSourceMessageIds.filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  return new Set([...humanWindowIds].filter((id) => eligible.has(id)));
}

function handleKey(handle: string): string {
  return normalizeHandle(handle).toLowerCase();
}

/**
 * Build a case-insensitive allow-list while retaining the actually observed spelling. Existing
 * memories count as known context, but a handle produced only by the current LLM output does not.
 */
function knownHandleMap(input: MemoryMiningInput): Map<string, string> {
  const handles = new Map<string, string>();
  const add = (raw: string | null | undefined): void => {
    if (raw == null) return;
    const canonical = normalizeHandle(raw);
    if (!canonical || canonical === '@') return;
    handles.set(handleKey(canonical), canonical);
  };
  for (const message of input.messages) {
    if (message.isBot) continue;
    add(message.handle);
    add(message.replyToHandle);
  }
  for (const memory of input.existingMemories) {
    add(memory.subjectHandle);
    for (const handle of memory.involvedHandles) add(handle);
  }
  for (const handle of input.knownHandles ?? []) add(handle);
  return handles;
}

export class MemoryMiner {
  constructor(
    private readonly llm: LLMProvider,
    private readonly cfg: MemoryMinerConfig,
  ) {}

  /** Extract durable lore candidates from a chat window on the dedicated mining provider. */
  async extractCandidates(input: MemoryMiningInput): Promise<MemoryCandidate[]> {
    if (input.messages.length === 0) return [];
    const prompt = buildMemoryMiningPrompt({
      messages: input.messages,
      existingMemories: input.existingMemories,
      language: input.language,
      nsfwEnabled: input.nsfwEnabled,
      maxCandidates: this.cfg.maxCandidates,
    });
    const result = await this.llm.jsonCompletion({
      system: MEMORY_MINING_SYSTEM,
      prompt,
      schema: memoryMiningResultSchema,
      schemaHint: MEMORY_MINING_SCHEMA_HINT,
      normalizeCandidate: (candidate) =>
        normalizeMemoryMiningCandidate(
          candidate,
          new Set(
            input.messages
              .filter((message) => !message.isBot)
              .map((message) => message.messageId)
              .filter(
                (id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
              ),
          ),
        ),
      temperature: this.cfg.temperature,
      maxTokens: 1500,
    });
    // A validated {"candidates":[]} is a successful empty pass. `null` means structured-output
    // failure and must propagate so the caller does not advance the mining cursor.
    if (!result) throw new Error('continuous memory miner returned no schema-valid output');

    const candidates = result.candidates ?? [];
    const accepted: MemoryCandidate[] = [];
    const allowedSourceIds = sourceIdSet(input);
    const allowedHandles = knownHandleMap(input);
    for (const c of candidates) {
      const text = c.text.trim();
      const normalizedText = normalizeMemoryText(text);
      if (!normalizedText) continue;
      if (c.toxicity === 'blocked') continue;
      if (isSensitiveMemory(text) || isSensitiveMemory(normalizedText)) continue;
      if (isUnsafeSocialMemory(text) || isUnsafeSocialMemory(normalizedText)) continue;
      if (c.confidence < input.minConfidence) continue;
      if (c.salience < this.cfg.minSalience) continue;
      // People, preferences, relationships, norms and running jokes have one authoritative home:
      // the evolving social graph. Episodic memory may still update/expire old migrated items, but
      // it must not create or reinforce a second competing profile.
      const operation = c.operation ?? 'new';
      if (
        (operation === 'new' || operation === 'reinforce') &&
        !EPISODIC_CATEGORIES.has(c.category)
      ) {
        continue;
      }

      const sourceMessageIds = [
        ...new Set(
          (c.sourceMessageIds ?? []).filter(
            (id) => Number.isSafeInteger(id) && id > 0 && allowedSourceIds.has(id),
          ),
        ),
      ];
      // Every automatically mined change needs at least one real, human-authored piece of
      // evidence. Manual/admin memories bypass the miner and remain possible without message ids.
      if (sourceMessageIds.length === 0) continue;

      const rawSubjectHandle = c.subjectHandle ?? null;
      const subjectHandle =
        rawSubjectHandle == null ? null : (allowedHandles.get(handleKey(rawSubjectHandle)) ?? null);
      if (rawSubjectHandle != null && subjectHandle == null) continue;
      if (c.subjectType === 'user' && subjectHandle == null) continue;

      const involvedHandles: string[] = [];
      let hasUnknownInvolvedHandle = false;
      for (const rawHandle of c.involvedHandles ?? []) {
        const known = allowedHandles.get(handleKey(rawHandle));
        if (!known) {
          hasUnknownInvolvedHandle = true;
          break;
        }
        if (!involvedHandles.some((handle) => handleKey(handle) === handleKey(known))) {
          involvedHandles.push(known);
        }
      }
      if (hasUnknownInvolvedHandle) continue;

      accepted.push({
        subjectType: c.subjectType,
        subjectHandle,
        involvedHandles,
        category: c.category,
        text,
        normalizedText,
        confidence: c.confidence,
        salience: c.salience,
        toxicity: c.toxicity,
        sourceMessageIds,
        reason: c.reason ?? '',
        operation,
        targetMemoryId: c.targetMemoryId ?? null,
      });
      if (accepted.length >= this.cfg.maxCandidates) break;
    }
    log.debug({ returned: candidates.length, accepted: accepted.length }, 'mined candidates');
    return accepted;
  }
}
