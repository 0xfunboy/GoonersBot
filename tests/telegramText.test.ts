import { describe, expect, it } from 'vitest';
import { splitTelegramText } from '../src/telegram/handlers/message.js';

describe('Telegram long-answer splitting', () => {
  it('preserves a complete long answer in transport-safe chunks', () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, index) => `Sezione ${index + 1}: ${'contenuto utile '.repeat(55).trim()}.`,
    );
    const original = paragraphs.join('\n\n');
    const chunks = splitTelegramText(original, 900);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 900)).toBe(true);
    expect(chunks.join('\n\n').replace(/\s+/g, ' ').trim()).toBe(
      original.replace(/\s+/g, ' ').trim(),
    );
  });

  it('does not emit an empty message', () => {
    expect(splitTelegramText('   ')).toEqual([]);
  });
});
