import { describe, expect, it } from 'vitest';
import { parseMusicRequest } from '../src/services/musicIntent.js';

describe('parseMusicRequest', () => {
  it('accepts YouTube download language with an explicit title', () => {
    expect(parseMusicRequest('scaricami bohemian rhapsody da youtube')).toBe('bohemian rhapsody');
    expect(parseMusicRequest('download never gonna give you up from youtube')).toBe(
      'never gonna give you up',
    );
  });

  it('does not treat a generic music capability question as a song query', () => {
    expect(parseMusicRequest('puoi scaricarmi una canzone da youtube?')).toBeNull();
  });
});
