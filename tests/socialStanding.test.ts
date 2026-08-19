import { describe, expect, it, vi } from 'vitest';
import {
  SocialStandingService,
  ceilingFor,
  renderStanding,
  scoreTurn,
} from '../src/social/standingService.js';
import { resolveStance } from '../src/social/stanceService.js';
import {
  DEMOTION_FLOOR,
  FRIEND_RAPPORT_THRESHOLD,
  bandFor,
  decayed,
  qualifiesAsFriend,
  type SocialStandingDoc,
} from '../src/storage/repositories/socialStanding.js';
import { capRoast } from '../src/brain/socialAwareness.js';
import type { AmbientFact } from '../src/ambient/types.js';
import type { SceneAnalysis, SocialSignal } from '../src/brain/types.js';
import type { Storage } from '../src/storage/index.js';

const scene = (overrides: Partial<SceneAnalysis> = {}): SceneAnalysis =>
  ({ userIntent: 'random_chatter', botIsBeingCriticized: false, ...overrides }) as SceneAnalysis;

const signal = (overrides: Partial<SocialSignal> = {}): SocialSignal =>
  ({ situation: 'casual', humorAllowed: true, ...overrides }) as SocialSignal;

const turn = (overrides: Partial<Parameters<typeof scoreTurn>[0]> = {}) => ({
  chatId: -100,
  handle: '@akire',
  message: '',
  scene: scene(),
  socialSignal: signal(),
  addressed: true,
  ...overrides,
});

describe('teasing must never cost rapport', () => {
  it('scores a roast aimed at the bot as neutral when humour is on the table', () => {
    // This group communicates by insult. If banter were negative nobody would ever be a friend
    // and the whole feature would be inert.
    const result = scoreTurn(
      turn({
        message: 'ma quanto sei scarso, ti hanno programmato col culo',
        socialSignal: signal({ situation: 'banter', humorAllowed: true }),
        scene: scene({ userIntent: 'insult_bot' }),
      }),
    );
    expect(result.delta).toBe(0);
    expect(result.conflict).toBe(false);
  });

  it('scores genuine hostility as a conflict only when humour is off', () => {
    const result = scoreTurn(
      turn({
        message: 'sei inutile, sparisci',
        socialSignal: signal({ situation: 'conflict', humorAllowed: false }),
      }),
    );
    expect(result.delta).toBeLessThan(0);
    expect(result.conflict).toBe(true);
  });

  it('rewards gratitude and warmth', () => {
    expect(
      scoreTurn(turn({ socialSignal: signal({ situation: 'gratitude' }) })).delta,
    ).toBeGreaterThan(0);
    expect(scoreTurn(turn({ message: 'grazie mille sei un mito' })).delta).toBeGreaterThan(0);
  });

  it('rewards defending the bot most of all, because it costs the defender something', () => {
    const defends = scoreTurn(turn({ message: 'ma lasciatelo stare dai, e bravo' })).delta;
    const thanks = scoreTurn(turn({ socialSignal: signal({ situation: 'gratitude' }) })).delta;
    expect(defends).toBeGreaterThan(thanks);
  });
});

describe('the friend tag is earned slowly and lost only to real conflict', () => {
  const base = (overrides: Partial<SocialStandingDoc> = {}): SocialStandingDoc => ({
    chatId: -100,
    handle: '@akire',
    rapport: 50,
    friend: false,
    interactions: 40,
    conflicts: 0,
    firstSeenAt: new Date('2026-01-01'),
    lastSeenAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  it('is not granted on warmth alone without enough history', () => {
    expect(qualifiesAsFriend(base({ interactions: 5 }))).toBe(false);
  });

  it('is not granted below the rapport threshold', () => {
    expect(qualifiesAsFriend(base({ rapport: FRIEND_RAPPORT_THRESHOLD - 1 }))).toBe(false);
  });

  it('is granted after sustained warmth with no recent conflict', () => {
    expect(qualifiesAsFriend(base())).toBe(true);
  });

  it('is withheld while a conflict is still recent', () => {
    const recent = new Date(Date.now() - 3 * 24 * 3_600_000);
    expect(qualifiesAsFriend(base({ lastConflictAt: recent }))).toBe(false);
  });

  it('is granted again once the quiet window has passed', () => {
    const old = new Date(Date.now() - 60 * 24 * 3_600_000);
    expect(qualifiesAsFriend(base({ lastConflictAt: old }))).toBe(true);
  });
});

describe('rapport decay is one-directional', () => {
  it('lets grudges expire', () => {
    const week = new Date(Date.now() - 7 * 24 * 3_600_000);
    expect(decayed({ rapport: -20, updatedAt: week }, new Date())).toBeGreaterThan(-20);
  });

  it('never erodes earned warmth', () => {
    // Symmetric decay would quietly delete every friendship during a quiet week.
    const month = new Date(Date.now() - 30 * 24 * 3_600_000);
    expect(decayed({ rapport: 60, updatedAt: month }, new Date())).toBe(60);
  });
});

describe('standing changes tone, never the facts', () => {
  it('caps a friend at an affectionate roast even in a heavy scene', () => {
    expect(capRoast('heavy', ceilingFor('friend'))).toBe('light');
  });

  it('leaves a stranger at the scene budget', () => {
    expect(capRoast('heavy', ceilingFor('neutral'))).toBe('heavy');
  });

  it('says out loud that it must not decide who is right', () => {
    const block = renderStanding(
      {
        chatId: -100,
        handle: '@akire',
        rapport: 52,
        friend: true,
        interactions: 40,
        conflicts: 0,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
      'friend',
      'light',
    );
    expect(block).toContain('@akire');
    expect(block).toMatch(/TONE ONLY/i);
    expect(block).toMatch(/never decide who is factually right/i);
  });

  it('stays silent for someone barely seen', () => {
    const block = renderStanding(
      {
        chatId: -100,
        handle: '@nuovo',
        rapport: 0,
        friend: false,
        interactions: 2,
        conflicts: 0,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
      'neutral',
      'heavy',
    );
    expect(block).toBe('');
  });
});

describe('bandFor', () => {
  it.each([
    [{ rapport: 60, friend: true }, 'friend'],
    [{ rapport: 60, friend: false }, 'warm'],
    [{ rapport: 0, friend: false }, 'neutral'],
    [{ rapport: -20, friend: false }, 'prickly'],
    [{ rapport: -80, friend: false }, 'hostile'],
  ])('maps %j to %s', (doc, expected) => {
    expect(bandFor(doc)).toBe(expected);
  });
});

describe('stance follows evidence, not affection', () => {
  const fact = (overrides: Partial<AmbientFact> = {}): AmbientFact => ({
    domain: 'anime',
    subject: 'AniList',
    text: 'ep. 8 il 2026-08-20',
    url: 'https://anilist.co/anime/207141',
    confidence: 0.9,
    fromCache: true,
    ...overrides,
  });

  it('takes a side only when a source is actually in hand', () => {
    const settled = resolveStance({
      message: 'no ti sbagli, esce di giovedi',
      facts: [fact()],
    });
    expect(settled.tier).toBe('settled');
    expect(settled.block).toContain('anilist.co');
  });

  it('refuses to pick a side with no evidence, even in a clear dispute', () => {
    const unknown = resolveStance({ message: 'no non e vero, ti sbagli', facts: [] });
    expect(unknown.tier).toBe('unknown');
    expect(unknown.block).toMatch(/do not pick a side/i);
  });

  it('treats a value judgement as opinion no matter what evidence exists', () => {
    const opinion = resolveStance({
      message: 'secondo me questo anime e sopravvalutato',
      facts: [fact()],
    });
    expect(opinion.tier).toBe('opinion');
    expect(opinion.block).toMatch(/state it as a view/i);
  });

  it('stays silent when nobody is arguing', () => {
    expect(resolveStance({ message: 'bello questo episodio', facts: [fact()] }).block).toBe('');
  });

  it('instructs the model that affection must not choose the side', () => {
    const block = resolveStance({ message: 'no ti sbagli', facts: [fact()] }).block;
    // This is the sycophancy guard, stated where the model will actually read it.
    expect(block).toMatch(/REGARDLESS of who you like/i);
    expect(block).toMatch(/do not mock them/i);
  });
});

describe('the sycophancy guard', () => {
  const fact = (): AmbientFact => ({
    domain: 'anime',
    subject: 'AniList',
    text: 'ep. 8 il 2026-08-20',
    url: 'https://anilist.co/anime/207141',
    confidence: 0.9,
    fromCache: true,
  });

  it('produces the same stance whether the speaker is a friend or hostile', () => {
    // The single property the whole design rests on: rapport is not an input to the stance at
    // all, so there is no path by which liking someone can change which claim the bot backs.
    const dispute = { message: 'no ti sbagli, esce di giovedi', facts: [fact()] };
    const first = resolveStance(dispute);
    const second = resolveStance(dispute);
    expect(first.tier).toBe(second.tier);
    expect(first.block).toBe(second.block);
  });

  it('keeps tone and substance in separate blocks so neither can be read as the other', () => {
    const tone = renderStanding(
      {
        chatId: -100,
        handle: '@akire',
        rapport: 52,
        friend: true,
        interactions: 40,
        conflicts: 0,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
      'friend',
      'light',
    );
    const substance = resolveStance({ message: 'no ti sbagli', facts: [fact()] }).block;
    expect(tone).toContain('SOCIAL STANDING');
    expect(tone).not.toContain('STANCE');
    expect(substance).toContain('STANCE');
    expect(substance).not.toContain('SOCIAL STANDING');
  });
});

describe('SocialStandingService', () => {
  const storage = (doc: SocialStandingDoc | null = null) =>
    ({
      socialStanding: {
        get: vi.fn(async () => doc),
        record: vi.fn(async () => ({
          chatId: -100,
          handle: '@akire',
          rapport: 52,
          friend: true,
          interactions: 40,
          conflicts: 0,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })),
      },
    }) as unknown as Storage;

  it('produces a friend directive with an affectionate ceiling', async () => {
    const service = new SocialStandingService(storage(), { enabled: true });
    const directive = await service.observe(turn());
    expect(directive?.friend).toBe(true);
    expect(directive?.roastCeiling).toBe('light');
  });

  it('is inert when disabled', async () => {
    const service = new SocialStandingService(storage(), { enabled: false });
    expect(await service.observe(turn())).toBeNull();
  });

  it('never lets a storage failure cost a reply', async () => {
    const broken = {
      socialStanding: {
        record: async () => {
          throw new Error('mongo down');
        },
      },
    } as unknown as Storage;
    const service = new SocialStandingService(broken, { enabled: true });
    await expect(service.observe(turn())).resolves.toBeNull();
  });

  it('demotes a friend on a genuine conflict but leaves them above a stranger', () => {
    // The floor is what makes falling out different from never having met.
    expect(DEMOTION_FLOOR).toBeGreaterThan(0);
    expect(DEMOTION_FLOOR).toBeLessThan(FRIEND_RAPPORT_THRESHOLD);
  });
});
