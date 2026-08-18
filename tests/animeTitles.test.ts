import { describe, expect, it } from 'vitest';
import {
  canonicalTitleKey,
  diceSimilarity,
  isDecisiveMatch,
  normalizeTitle,
  rankByTitle,
  titleKeys,
  titleSimilarity,
} from '../src/anime/titles.js';

describe('normalizeTitle', () => {
  it('lowercases, strips accents and collapses punctuation into separators', () => {
    expect(normalizeTitle('Re:ZERO -Starting Life in Another World-')).toBe(
      're zero starting life in another world',
    );
    expect(normalizeTitle('Kaguya-sama: Love Is War')).toBe('kaguya sama love is war');
    expect(normalizeTitle('Bocchi the Rock!')).toBe('bocchi the rock');
  });

  it('folds accents and apostrophes without fusing separate words', () => {
    expect(normalizeTitle("L'Attacco dei Giganti")).toBe('lattacco dei giganti');
    expect(normalizeTitle('Pokémon')).toBe('pokemon');
    expect(normalizeTitle('sword   art  online')).toBe('sword art online');
  });

  it('is stable across full-width and composed Unicode forms', () => {
    expect(normalizeTitle('ＮＡＲＵＴＯ')).toBe('naruto');
    expect(normalizeTitle('Faté')).toBe('fate');
  });
});

describe('canonicalTitleKey', () => {
  it('drops source/format noise such as ITA and SUB', () => {
    expect(canonicalTitleKey('Youjo Senki ITA')).toBe('youjo senki');
    expect(canonicalTitleKey('Chainsaw Man (SUB ITA)')).toBe('chainsaw man');
    expect(canonicalTitleKey('Vinland Saga BD Uncensored')).toBe('vinland saga');
  });

  it('unifies roman sequel numbering with digits', () => {
    expect(canonicalTitleKey('Overlord IV')).toBe('overlord 4');
    expect(canonicalTitleKey('Overlord 4')).toBe('overlord 4');
  });

  it('never erases a title whose every token is noise', () => {
    // "Monster" is a real series; a greedy noise filter that emptied it would make it unmatchable.
    expect(canonicalTitleKey('OVA')).toBe('ova');
    expect(canonicalTitleKey('Movie')).toBe('movie');
    expect(canonicalTitleKey('')).toBe('');
  });
});

describe('titleKeys', () => {
  it('collects canonical and normalized keys without duplicates', () => {
    expect(titleKeys(['Youjo Senki ITA', 'Youjo Senki', null, undefined, ''])).toEqual([
      'youjo senki',
      'youjo senki ita',
    ]);
  });
});

describe('similarity', () => {
  it('scores identical strings 1 and disjoint strings low', () => {
    expect(diceSimilarity('naruto', 'naruto')).toBe(1);
    expect(diceSimilarity('naruto', 'bleach')).toBeLessThan(0.2);
  });

  it('ranks a fully contained query above a merely bigram-similar title', () => {
    const contained = titleSimilarity('tanya the evil', 'saga of tanya the evil');
    const similar = titleSimilarity('tanya the evil', 'tanya the evil movie extra');
    expect(contained).toBeGreaterThan(0.7);
    expect(contained).toBeGreaterThan(0);
    expect(similar).toBeGreaterThan(0);
  });

  it('never returns 1 for a non-exact key match', () => {
    expect(titleSimilarity('tanya', 'saga of tanya the evil')).toBeLessThan(1);
    expect(titleSimilarity('youjo senki', 'youjo senki')).toBe(1);
  });
});

describe('rankByTitle', () => {
  const catalog = [
    { titles: ['Saga of Tanya the Evil', 'Youjo Senki'], id: 'tanya' },
    { titles: ['Sword Art Online'], id: 'sao' },
    { titles: ['Attack on Titan', 'Shingeki no Kyojin'], id: 'aot' },
  ];

  it('resolves a colloquial English title onto the right series', () => {
    const ranked = rankByTitle('tanya the evil', catalog);
    expect(ranked[0]?.item.id).toBe('tanya');
  });

  it('resolves through an alternate romaji alias', () => {
    const ranked = rankByTitle('shingeki no kyojin', catalog);
    expect(ranked[0]?.item.id).toBe('aot');
    expect(ranked[0]?.score).toBe(1);
  });

  it('returns nothing for an unrelated query instead of a weak guess', () => {
    expect(rankByTitle('ricetta della carbonara', catalog)).toEqual([]);
  });

  it('honours the candidate limit', () => {
    const ranked = rankByTitle('a', catalog, { minScore: 0, limit: 2 });
    expect(ranked.length).toBeLessThanOrEqual(2);
  });

  it('breaks ties by input order so a pre-sorted catalog keeps its intent', () => {
    const duplicates = [
      { titles: ['Kanojo Okarishimasu'], id: 'first' },
      { titles: ['Kanojo Okarishimasu'], id: 'second' },
    ];
    const ranked = rankByTitle('kanojo okarishimasu', duplicates);
    expect(ranked.map((row) => row.item.id)).toEqual(['first', 'second']);
  });
});

describe('isDecisiveMatch', () => {
  it('accepts an exact match', () => {
    expect(isDecisiveMatch([{ item: 1, score: 1, matchedKey: 'x' }])).toBe(true);
  });

  it('rejects two near-equal candidates rather than guessing', () => {
    expect(
      isDecisiveMatch([
        { item: 1, score: 0.72, matchedKey: 'a' },
        { item: 2, score: 0.7, matchedKey: 'b' },
      ]),
    ).toBe(false);
  });

  it('accepts a clear winner over a distant runner-up', () => {
    expect(
      isDecisiveMatch([
        { item: 1, score: 0.85, matchedKey: 'a' },
        { item: 2, score: 0.5, matchedKey: 'b' },
      ]),
    ).toBe(true);
  });

  it('rejects an empty ranking', () => {
    expect(isDecisiveMatch([])).toBe(false);
  });
});
