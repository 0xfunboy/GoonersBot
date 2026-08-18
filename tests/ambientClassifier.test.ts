import { describe, expect, it } from 'vitest';
import { classifyMessage, isDominant, primaryDomain } from '../src/ambient/classifier.js';
import { DOMAIN_VOLATILITY } from '../src/ambient/domains.js';
import { extractSubjects } from '../src/ambient/subjects.js';

describe('domain disambiguation', () => {
  it.each([
    ['ma quindi è uscito il nuovo episodio di Frieren?', 'anime'],
    ['raga che hentai nuovi sono usciti', 'anime'],
    ['secondo Nietzsche il nichilismo è inevitabile', 'philosophy'],
    ['ho un attacco di ansia prima di ogni colloquio', 'psychology'],
    ['la dissonanza cognitiva spiega un sacco di cose', 'psychology'],
    ['sto imparando rust, il compilatore è brutale', 'technology'],
    ['il film di Villeneuve, che regista assurdo', 'film_tv'],
    ['hanno annunciato le elezioni, che casino', 'current_events'],
    ['la termodinamica e l entropia mi hanno distrutto', 'science'],
    ['il medioevo non era così buio come dicono', 'history'],
    ['ho fatto uno speedrun su steam ieri notte', 'gaming'],
    ['quel album della band è la loro discografia migliore', 'music'],
  ])('routes %j to %s', (message, expected) => {
    expect(primaryDomain(classifyMessage(message))).toBe(expected);
  });

  it('returns no domain for ordinary chatter', () => {
    for (const message of [
      'ahahah muoio',
      'ok ci sto',
      'raga che si fa stasera',
      'boh',
      'ma quindi vieni o no',
    ]) {
      expect(classifyMessage(message).domains).toEqual([]);
    }
  });

  it('keeps both domains for a genuinely cross-domain question', () => {
    // "Can an AI be conscious" is technology and philosophy at once; answering it well needs both.
    const result = classifyMessage(
      'ma secondo voi una intelligenza artificiale può avere coscienza? è una domanda filosofica',
    );
    const domains = result.domains.map((signal) => signal.domain);
    expect(domains).toContain('technology');
    expect(domains).toContain('philosophy');
    expect(isDominant(result)).toBe(false);
  });

  it('scores a multi-word phrase above a bare word', () => {
    const phrase = classifyMessage('parliamo di guerra fredda');
    const word = classifyMessage('parliamo di guerra');
    expect(phrase.domains[0]?.score).toBeGreaterThan(word.domains[0]?.score ?? 0);
  });
});

describe('volatility', () => {
  it('treats releases and news as live, reference knowledge as stable', () => {
    expect(DOMAIN_VOLATILITY.anime).toBe('live');
    expect(DOMAIN_VOLATILITY.current_events).toBe('live');
    expect(DOMAIN_VOLATILITY.philosophy).toBe('stable');
    expect(DOMAIN_VOLATILITY.psychology).toBe('stable');
  });

  it('raises a slow domain to live when the message asks for what is current', () => {
    const background = classifyMessage('mi consigli un film di fantascienza');
    const current = classifyMessage('che film esce questa settimana al cinema');
    expect(background.domains[0]?.volatility).toBe('slow');
    expect(current.wantsCurrent).toBe(true);
    expect(current.domains[0]?.volatility).toBe('live');
  });

  it('never makes a stable domain volatile', () => {
    // "L'ultimo Kant" is still philosophy; a recency word cannot make Kant a moving target.
    const result = classifyMessage("l'ultimo libro di Kant sulla metafisica");
    expect(result.wantsCurrent).toBe(true);
    expect(result.domains[0]?.domain).toBe('philosophy');
    expect(result.domains[0]?.volatility).toBe('stable');
  });
});

describe('isDominant', () => {
  it('is false with no signal and true for a single clear one', () => {
    expect(isDominant(classifyMessage('ahahah'))).toBe(false);
    expect(isDominant(classifyMessage('che episodio assurdo di questo anime'))).toBe(true);
  });
});

describe('subject extraction', () => {
  it('pulls a capitalised name out of a sentence', () => {
    expect(extractSubjects('ieri sera ho visto Frieren e mi sono addormentato')).toContain(
      'Frieren',
    );
  });

  it('pulls a multi-word title after a preposition', () => {
    const subjects = extractSubjects("è uscito l'ultimo episodio di Tanya the Evil?");
    expect(subjects.some((s) => s.toLowerCase().includes('tanya the evil'))).toBe(true);
  });

  it('pulls a lowercase concept after a preposition', () => {
    const subjects = extractSubjects('parlami di dissonanza cognitiva');
    expect(subjects.some((s) => s.toLowerCase().includes('dissonanza cognitiva'))).toBe(true);
  });

  it('honours explicit quotation', () => {
    expect(extractSubjects('ho visto "La Haine" ieri')).toContain('La Haine');
  });

  it('does not treat a sentence-initial capital as a subject', () => {
    expect(extractSubjects('Grazie mille davvero')).not.toContain('Grazie');
  });

  it('drops trailing filler from a prepositional phrase', () => {
    const subjects = extractSubjects('stavo parlando di Frieren che è bellissimo');
    expect(subjects.some((s) => s === 'Frieren' || s.startsWith('Frieren'))).toBe(true);
  });

  it('returns nothing for an empty or trivial message', () => {
    expect(extractSubjects('')).toEqual([]);
    expect(extractSubjects('ok')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(
      extractSubjects('ho visto Frieren, Naruto, Bleach e One Piece', { limit: 2 }),
    ).toHaveLength(2);
  });
});
