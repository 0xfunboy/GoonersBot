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
  'You mine durable group lore from a Telegram chat window for a chaotic, vulgar, NSFW-capable group bot.',
  'Extract only things that truly emerged from the messages. Do NOT invent.',
  'Do NOT extract one-off insults or temporary moods unless the group clearly treats them as a recurring joke/nickname/reputation gag.',
  'A vulgar or NSFW item is fine to store IF it is group lore (recurring banter, nickname, meme, running joke, reputation).',
  'NEVER store: medical data, political identity, precise address, phone number, passwords, private identity data, or protected-class hate.',
  'Mark toxicity honestly: clean | vulgar | nsfw | risky | blocked. Use "blocked" for anything that must never be stored.',
  'Return ONLY JSON: {"candidates":[{subjectType,subjectHandle,involvedHandles,category,text,normalizedText,confidence,salience,toxicity,sourceMessageIds,reason}]}.',
  'text = short durable memory (max ~140 chars). normalizedText = canonical lowercase. confidence/salience in 0..1.',
  'subjectType: user|group|relationship|meme|quote|event|running_joke. category: nickname|role|running_joke|meme|preference|quote|group_lore|relationship|reputation|recurring_topic|chat_rule|style_signal.',
  'Use @handles for subjectHandle/involvedHandles. sourceMessageIds = the #ids that justify the item (numbers only).',
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
      ? params.existingMemories.map((m) => `- ${m.subjectHandle ?? 'group'}: ${m.text}`).join('\n')
      : '(none)';
  return [
    `Chat language: ${params.language}. NSFW lore allowed: ${params.nsfwEnabled ? 'yes' : 'no'}.`,
    `Extract at most ${params.maxCandidates} NEW durable items. Skip anything already known.`,
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
