import type { StoredMessage } from '../storage/repositories/messages.js';
import type { MemoryItem } from '../memory/types.js';

const fmt = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 16);

function renderMessages(messages: StoredMessage[]): string {
  return messages
    .map((m) => {
      const id = m.messageId != null ? `#${m.messageId} ` : '';
      const name = m.isBot ? 'BOT' : m.handle;
      const parts = [m.message.messageText ?? ''];
      if (m.message.imageDescription) parts.push(`[img: ${m.message.imageDescription}]`);
      if (m.message.voiceDescription) parts.push(`[voice: ${m.message.voiceDescription}]`);
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
].join('\n');

export const MEMORY_MINING_SCHEMA_HINT = [
  'Root object: {"candidates": MemoryCandidate[]}. Use {"candidates":[]} when nothing qualifies.',
  'Never return a bare array. Use the exact camelCase field names shown below.',
  'Candidate: {"subjectType":"user|group|relationship|meme|quote|event|running_joke","subjectHandle":"@handle"|null,"involvedHandles":[],"category":"meme|quote|group_lore","text":"short evidence-backed memory","normalizedText":"canonical lowercase text","confidence":0.0,"salience":0.0,"toxicity":"clean|vulgar|nsfw|risky|blocked","sourceMessageIds":[123],"reason":"brief reason","operation":"new|reinforce|update|expire","targetMemoryId":null}.',
  'confidence and salience are JSON numbers, sourceMessageIds contains JSON integers copied from #ids, and arrays must never be null.',
].join('\n');

export function buildMemoryMiningPrompt(params: {
  messages: StoredMessage[];
  existingMemories: MemoryItem[];
  language: string;
  nsfwEnabled: boolean;
  maxCandidates: number;
}): string {
  const existing =
    params.existingMemories.length > 0
      ? params.existingMemories
          .map(
            (m) =>
              `- id=${m._id ?? 'unknown'} subject=${m.subjectHandle ?? 'group'} category=${m.category} revision=${m.revision ?? 1}: ${m.text}`,
          )
          .join('\n')
      : '(none)';
  return [
    `Chat language: ${params.language}. NSFW lore allowed: ${params.nsfwEnabled ? 'yes' : 'no'}.`,
    `Return at most ${params.maxCandidates} durable changes. Do not duplicate known items: reinforce, update or expire them when justified.`,
    '',
    'ALREADY KNOWN (do not duplicate):',
    existing,
    '',
    'CHAT WINDOW:',
    renderMessages(params.messages),
    '',
    'Return the JSON now.',
  ].join('\n');
}
