import type { StoredMessage } from '../storage/repositories/messages.js';

export const MINING_MESSAGE_TEXT_CHARS = 6_000;
export const MINING_MEDIA_DESCRIPTION_CHARS = 2_000;
export const DEFAULT_MINING_WINDOW_BYTES = 12_000;

/**
 * Bound untrusted chat/media text without hiding both ends of a long item. Ordinary Telegram text
 * (maximum 4096 characters) is preserved in full; oversized extracted descriptions remain useful
 * without being able to consume an entire Gemma request.
 */
export function compactMiningText(value: string | null | undefined, maxChars: number): string {
  const text = value?.trim() ?? '';
  if (text.length <= maxChars) return text;
  const marker = '\n[…contenuto intermedio omesso dal prompt di mining…]\n';
  const available = Math.max(2, maxChars - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

/** Keep complete high-priority lines until the UTF-8 budget is exhausted. */
export function compactMiningLines(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = '[…contesto sociale meno rilevante omesso…]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const lines: string[] = [];
  let usedBytes = 0;
  for (const line of value.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0);
    if (usedBytes + lineBytes + markerBytes + 1 > maxBytes) break;
    lines.push(line);
    usedBytes += lineBytes;
  }
  if (lines.length > 0) return [...lines, marker].join('\n');

  const available = Math.max(0, maxBytes - markerBytes - 1);
  const prefix = Buffer.from(value, 'utf8')
    .subarray(0, available)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  return prefix ? `${prefix}\n${marker}` : marker.slice(0, maxBytes);
}

/** Approximate the exact bounded UTF-8 representation used by lore/social mining prompts. */
export function miningMessagePromptBytes(message: StoredMessage): number {
  return (
    96 +
    Buffer.byteLength(
      compactMiningText(message.message.messageText, MINING_MESSAGE_TEXT_CHARS),
      'utf8',
    ) +
    Buffer.byteLength(
      compactMiningText(message.message.imageDescription, MINING_MEDIA_DESCRIPTION_CHARS),
      'utf8',
    ) +
    Buffer.byteLength(
      compactMiningText(message.message.voiceDescription, MINING_MEDIA_DESCRIPTION_CHARS),
      'utf8',
    )
  );
}
