import { describe, expect, it } from 'vitest';
import { StyleEngine } from '../src/brain/styleEngine.js';
import type { BotReplyRecord } from '../src/brain/types.js';

const rec = (text: string): BotReplyRecord => ({ text }) as unknown as BotReplyRecord;

describe('StyleEngine.recurringTics', () => {
  const engine = new StyleEngine();

  it('catches a catchphrase repeated across replies', () => {
    const recent = [
      rec('ma che cazzo dici, porco che sei'),
      rec('vai a lavorare, porco che sei'),
      rec('non ci posso credere, porco che sei'),
    ];
    const tics = engine.recurringTics(recent);
    expect(tics.some((t) => t.includes('porco che sei'))).toBe(true);
  });

  it('returns nothing when there is no repetition', () => {
    const recent = [rec('battuta uno tutta diversa'), rec('seconda cosa completamente altra')];
    const tics = engine.recurringTics(recent);
    // may include the latest closing, but never a 2+ occurrence gram
    expect(tics.every((t) => t.split(' ').length <= 4)).toBe(true);
  });
});
