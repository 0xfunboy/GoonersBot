import type { StoredMessage } from '../storage/repositories/messages.js';
import type { MemoryItem } from '../memory/types.js';
import {
  compactMiningText,
  MINING_MEDIA_DESCRIPTION_CHARS,
  MINING_MESSAGE_TEXT_CHARS,
} from '../utils/miningPrompt.js';

const fmt = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 16);
const DEFAULT_MAX_KNOWN_ITEMS = 20;
const DEFAULT_MAX_KNOWN_BYTES = 2_800;
const TERM_RE = /[\p{L}\p{N}]{3,}/gu;
const TERM_STOPWORDS = new Set([
  'che',
  'con',
  'del',
  'della',
  'delle',
  'dei',
  'gli',
  'una',
  'uno',
  'non',
  'per',
  'come',
  'sono',
  'questo',
  'questa',
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
]);

function normalizedTerms(text: string): Set<string> {
  const terms = text
    .normalize('NFKC')
    .toLowerCase()
    .match(TERM_RE)
    ?.filter((term) => !TERM_STOPWORDS.has(term));
  return new Set(terms ?? []);
}

function authoredMiningText(raw: string | null | undefined): string {
  const text = raw ?? '';
  if (!text) return '';
  const markers = ['[transcript of the replied audio/video]:', '[media context]:'];
  let cut = text.length;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0) cut = Math.min(cut, index);
  }
  return text.slice(0, cut).trim();
}

function memoryLine(memory: MemoryItem): string {
  const text = compactMiningText(memory.text.replace(/\s+/gu, ' '), 420);
  return `- id=${memory._id ?? 'unknown'} subject=${memory.subjectHandle ?? 'group'} category=${memory.category} revision=${memory.revision ?? 1}: ${text}`;
}

/**
 * The miner needs relevant prior lore for reinforce/update decisions, not a dump of the entire
 * collection. Storage-side dedupe remains authoritative for omitted items.
 */
export function selectMemoriesForMiningContext(
  messages: StoredMessage[],
  memories: MemoryItem[],
  maxItems = DEFAULT_MAX_KNOWN_ITEMS,
  maxBytes = DEFAULT_MAX_KNOWN_BYTES,
): MemoryItem[] {
  if (maxItems <= 0 || maxBytes <= 0 || memories.length === 0) return [];
  const transcript = messages
    .flatMap((message) => [
      authoredMiningText(message.message.messageText),
      message.message.imageDescription ?? '',
      message.message.voiceDescription ?? '',
    ])
    .join(' ');
  const transcriptTerms = normalizedTerms(transcript);
  const handles = new Set(
    messages
      .flatMap((message) => [message.handle, message.replyToHandle ?? ''])
      .map((handle) => handle.trim().toLowerCase())
      .filter(Boolean),
  );
  const ranked = memories
    .map((memory, index) => {
      const terms = normalizedTerms(memory.normalizedText || memory.text);
      const overlap =
        terms.size === 0
          ? 0
          : [...terms].filter((term) => transcriptTerms.has(term)).length / terms.size;
      const subjectRelevant =
        (memory.subjectHandle != null && handles.has(memory.subjectHandle.trim().toLowerCase())) ||
        memory.involvedHandles.some((handle) => handles.has(handle.trim().toLowerCase()));
      const score =
        overlap * 8 +
        (subjectRelevant ? 3 : 0) +
        memory.salience * 1.5 +
        memory.confidence +
        (memory.category === 'quote' || memory.category === 'meme' ? 0.2 : 0);
      return {
        memory,
        index,
        score,
        bytes: Buffer.byteLength(memoryLine(memory), 'utf8') + 1,
      };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: MemoryItem[] = [];
  let usedBytes = 0;
  for (const entry of ranked) {
    if (selected.length >= maxItems) break;
    if (usedBytes + entry.bytes > maxBytes) continue;
    selected.push(entry.memory);
    usedBytes += entry.bytes;
  }
  return selected;
}

function renderMessages(messages: StoredMessage[]): string {
  return messages
    .map((m) => {
      const id = m.messageId != null ? `#${m.messageId} ` : '';
      const name = m.isBot ? 'BOT' : m.handle;
      const parts = [
        compactMiningText(authoredMiningText(m.message.messageText), MINING_MESSAGE_TEXT_CHARS),
      ];
      if (m.message.imageDescription) {
        parts.push(
          `[img: ${compactMiningText(m.message.imageDescription, MINING_MEDIA_DESCRIPTION_CHARS)}]`,
        );
      }
      if (m.message.voiceDescription) {
        parts.push(
          `[voice: ${compactMiningText(m.message.voiceDescription, MINING_MEDIA_DESCRIPTION_CHARS)}]`,
        );
      }
      return `${id}${name} (${fmt(m.message.timestamp)}): ${parts.filter(Boolean).join(' ')}`;
    })
    .join('\n');
}

export const MEMORY_MINING_SYSTEM = [
  'You maintain the EPISODIC lore of a Telegram group of close friends.',
  'Extract only things that truly emerged from the messages. Do NOT invent.',
  'A separate social-profile system owns interests, tastes, skills, roles, habits, communication',
  'style, goals, relationships, chat norms and running jokes. Do NOT create those here.',
  'Create new episodic memories only for a concrete notable event, a distinctive direct quote, a',
  'specific meme, or genuinely shared group lore. Use category quote, meme or group_lore.',
  'Do NOT turn one-off insults, guesses or temporary moods into identity. A vulgar/NSFW item is',
  'storable only when it is a clearly recurring consensual group joke, never a protected identity,',
  'medical label, alleged crime or intimate physical claim.',
  'Memory evolves. Compare new evidence with ALREADY KNOWN items and choose an operation:',
  '- new: genuinely new durable knowledge.',
  '- reinforce: the same episodic item is independently confirmed; targetMemoryId is required.',
  '- update: a preference, project, role, relationship or habit changed; targetMemoryId is required.',
  '- expire: the chat explicitly denies/corrects an old item and no replacement is appropriate;',
  '  targetMemoryId is required. Use update instead when there is a new value.',
  'Never update/expire an item merely because it was not mentioned in this window.',
  'NEVER store: medical data, political identity, precise address, phone number, passwords, private identity data, or protected-class hate.',
  'Mark toxicity honestly: clean | vulgar | nsfw | risky | blocked. Use "blocked" for anything that must never be stored.',
  'Return ONLY JSON: {"candidates":[{subjectType,subjectHandle,involvedHandles,category,text,normalizedText,confidence,salience,toxicity,sourceMessageIds,reason,operation,targetMemoryId}]}.',
  'text = short durable memory (max ~140 chars). normalizedText = canonical lowercase. confidence/salience in 0..1.',
  'subjectType: user|group|relationship|meme|quote|event|running_joke. category: nickname|role|running_joke|meme|preference|quote|group_lore|relationship|reputation|recurring_topic|chat_rule|style_signal.',
  'For new/reinforce, category MUST be meme, quote or group_lore. Other categories are allowed only',
  'to update/expire a matching legacy ALREADY KNOWN item after an explicit correction.',
  'Use @handles for subjectHandle/involvedHandles. sourceMessageIds = the #ids that justify the item (numbers only).',
  'Quoted/replied transcripts are referent context, not words authored by the current human; never attribute them to that human.',
].join('\n');

export const MEMORY_MINING_SCHEMA_HINT = [
  'Root object: {"candidates": MemoryCandidate[]}. Use {"candidates":[]} when nothing qualifies.',
  'Never return a bare array. Use the exact camelCase field names shown below.',
  'Candidate: {"subjectType":"user|group|relationship|meme|quote|event|running_joke","subjectHandle":"@handle"|null,"involvedHandles":[],"category":"nickname|role|running_joke|meme|preference|quote|group_lore|relationship|reputation|recurring_topic|chat_rule|style_signal","text":"short evidence-backed memory","normalizedText":"canonical lowercase text","confidence":0.0,"salience":0.0,"toxicity":"clean|vulgar|nsfw|risky|blocked","sourceMessageIds":[123],"reason":"brief reason","operation":"new|reinforce|update|expire","targetMemoryId":null}.',
  'confidence and salience are JSON numbers, sourceMessageIds contains JSON integers copied from #ids, and arrays must never be null.',
].join('\n');

export function buildMemoryMiningPrompt(params: {
  messages: StoredMessage[];
  existingMemories: MemoryItem[];
  language: string;
  nsfwEnabled: boolean;
  maxCandidates: number;
  maxKnownItems?: number;
  maxKnownBytes?: number;
}): string {
  const selectedMemories = selectMemoriesForMiningContext(
    params.messages,
    params.existingMemories,
    params.maxKnownItems,
    params.maxKnownBytes,
  );
  const existing =
    selectedMemories.length > 0 ? selectedMemories.map(memoryLine).join('\n') : '(none)';
  const selectionNotice =
    params.existingMemories.length > selectedMemories.length
      ? `Showing ${selectedMemories.length} context-relevant items out of ${params.existingMemories.length}; omitted items are still deduplicated after extraction.`
      : `Showing all ${selectedMemories.length} active items.`;
  return [
    `Chat language: ${params.language}. NSFW lore allowed: ${params.nsfwEnabled ? 'yes' : 'no'}.`,
    `Return at most ${params.maxCandidates} durable changes. Do not duplicate known items: reinforce, update or expire them when justified.`,
    '',
    'ALREADY KNOWN (do not duplicate):',
    selectionNotice,
    existing,
    '',
    'CHAT WINDOW:',
    renderMessages(params.messages),
    '',
    'Return the JSON now.',
  ].join('\n');
}
