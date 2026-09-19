import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Held-out companion corpus inventory, not a semantic eval', () => {
  it('covers all 24 families with six unique non-command variants, including negative cases', async () => {
    const corpus = JSON.parse(
      await readFile(
        new URL('./fixtures/companion-conversation-variants.json', import.meta.url),
        'utf8',
      ),
    ) as {
      fewShot: boolean;
      variants: Array<{ family: string; texts: string[]; negativeIndexes: number[] }>;
    };
    expect(corpus.fewShot).toBe(false);
    expect(corpus.variants.map((item) => item.family)).toEqual(
      Array.from({ length: 24 }, (_, index) => `N${String(index + 1).padStart(2, '0')}`),
    );
    for (const item of corpus.variants) {
      expect(item.texts).toHaveLength(6);
      expect(new Set(item.texts).size).toBe(6);
      expect(
        item.texts.every((text) => text.trim().length > 10 && !text.trim().startsWith('/')),
      ).toBe(true);
      expect(item.negativeIndexes.every((index) => index >= 0 && index < 6)).toBe(true);
    }
    expect(
      corpus.variants.reduce((sum, item) => sum + item.negativeIndexes.length, 0),
    ).toBeGreaterThanOrEqual(12);
  });
});
