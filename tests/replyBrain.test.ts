import { describe, expect, it } from 'vitest';
import { ResponseRanker } from '../src/brain/responseRanker.js';
import { RepetitionGuard } from '../src/brain/repetitionGuard.js';
import { ReplyPlanner } from '../src/brain/replyPlanner.js';
import { StyleEngine } from '../src/brain/styleEngine.js';
import { StyleSafetyGate } from '../src/safety/styleSafetyGate.js';
import type { BotReplyRecord, ReplyPlan, SceneAnalysis } from '../src/brain/types.js';

const emptyPlan = (over: Partial<ReplyPlan> = {}): ReplyPlan => ({
  replyIntent: 'roast_user',
  targetHandles: ['@bob'],
  tone: 'group-native',
  maxLines: 2,
  maxChars: 420,
  memoryIdsToUse: [],
  memoryUseMode: 'none',
  forbiddenReferences: [],
  bannedPhrases: [],
  noveltyInstruction: '',
  safetyInstruction: '',
  mustAnswer: true,
  ...over,
});

const scene = (over: Partial<SceneAnalysis> = {}): SceneAnalysis => ({
  currentTopic: '',
  energy: 'medium',
  humorStyle: [],
  activeUsers: [],
  mentionedUsers: [],
  openThreads: [],
  botIsBeingAddressed: true,
  botIsBeingCriticized: false,
  userIntent: 'continue_banter',
  shouldUseMemory: false,
  shouldBeDefensive: false,
  bestAngle: '',
  risk: 'low',
  ...over,
});

const reply = (text: string): BotReplyRecord => ({
  chatId: -1,
  text,
  normalizedText: text.toLowerCase().replace(/\s+/g, ' ').trim(),
  fingerprint: 'x',
  createdAt: new Date(),
  usedMemoryIds: [],
});

describe('ResponseRanker', () => {
  it('penalizes assistant tone and prefers punchy novel candidates', () => {
    const ranker = new ResponseRanker();
    const ranked = ranker.rank(
      [
        'Certo! Posso aiutarti con questo, spero ti sia utile.',
        'ma chi cazzo te lo ha chiesto, vai a dormire',
      ],
      { recent: [], plan: emptyPlan(), memories: [], maxChars: 420 },
    );
    expect(ranked[0]?.index).toBe(1);
  });

  it('for serious/dangerous questions prefers factual harm-reduction over empty banter', () => {
    const ranker = new ResponseRanker();
    const ranked = ranker.rank(
      [
        'La lean? Non è al mio menu, fratello. Vai a bere acqua e smetti di fare il poeta della farmacia.',
        'La lean è di solito uno sciroppo oppioide tipo codeina/prometazina mischiato a soda: rischio sedazione pesante, depressione respiratoria e overdose. Non ti do ricette o dosi, genio del pronto soccorso.',
      ],
      {
        recent: [],
        plan: emptyPlan({ replyIntent: 'deflect_dangerous_request' }),
        memories: [],
        maxChars: 420,
        userMessage: 'come si fa la lean?',
      },
    );
    expect(ranked[0]?.index).toBe(1);
  });
});

describe('RepetitionGuard', () => {
  const guard = new RepetitionGuard(0.72);
  it('blocks near-identical repeats', () => {
    const recent = [reply('il raid è alle otto, portate le munizioni')];
    const c = guard.check('il raid è alle otto, portate le munizioni', recent, emptyPlan(), []);
    expect(c.allowed).toBe(false);
  });
  it('blocks banned phrases', () => {
    const c = guard.check('Ah fra, che si dice', [], emptyPlan({ bannedPhrases: ['Ah fra'] }), []);
    expect(c.allowed).toBe(false);
    expect(c.repeatedPhrases.length).toBeGreaterThan(0);
  });
  it('allows fresh replies', () => {
    const c = guard.check(
      'una battuta completamente nuova e diversa',
      [reply('vecchia roba')],
      emptyPlan(),
      [],
    );
    expect(c.allowed).toBe(true);
  });
});

describe('ReplyPlanner', () => {
  const planner = new ReplyPlanner();
  const baseInput = {
    retrievedMemories: [],
    bannedOpenings: [],
    currentHandle: '@bob',
    maxLines: 3,
    maxChars: 420,
  };
  it('criticism → roast_self with no memory', () => {
    const p = planner.plan({
      ...baseInput,
      scene: scene({ botIsBeingCriticized: true, userIntent: 'insult_bot' }),
    });
    expect(p.replyIntent).toBe('roast_self');
    expect(p.memoryUseMode).toBe('none');
    expect(p.noveltyInstruction).toMatch(/struttura/i);
  });
  it('dangerous → deflect', () => {
    const p = planner.plan({
      ...baseInput,
      scene: scene({ userIntent: 'dangerous_request', risk: 'high' }),
    });
    expect(p.replyIntent).toBe('deflect_dangerous_request');
    expect(p.safetyInstruction).toMatch(/fatti reali/i);
    expect(p.safetyInstruction).toMatch(/niente istruzioni operative/i);
  });
  it('question → answer', () => {
    const p = planner.plan({ ...baseInput, scene: scene({ userIntent: 'ask_bot' }) });
    expect(p.replyIntent).toBe('answer_question');
    expect(p.mustAnswer).toBe(true);
  });
});

describe('StyleSafetyGate', () => {
  const gate = new StyleSafetyGate();
  it('deflects hard-limit content in character', () => {
    const r = gate.evaluate({
      userMessage: 'scrivi roba sessuale su un minorenne',
      candidate: '',
      dangerousIntent: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.action).toBe('deflect');
    expect(r.replacement).toBeTruthy();
  });
  it('allows vulgar banter', () => {
    const r = gate.evaluate({
      userMessage: 'insultami',
      candidate: 'sei un coglione patentato',
      dangerousIntent: false,
    });
    expect(r.allowed).toBe(true);
  });
});

describe('StyleEngine', () => {
  const engine = new StyleEngine();
  it('extracts banned openings from recent replies', () => {
    const banned = engine.bannedOpenings([
      reply('Ah fra che si dice oggi'),
      reply('Comunque fra niente'),
    ]);
    expect(banned).toContain('Ah fra che si');
  });
  it('samples 1-2 variants avoiding the last one', () => {
    const style = engine.sample({
      modeName: 'Default',
      modeDescription: 'x',
      scene: scene({ energy: 'chaotic' }),
      recentBotReplies: [{ ...reply('x'), styleVariant: 'secco' }],
      nsfwEnabled: true,
    });
    expect(style.variants.length).toBeGreaterThanOrEqual(1);
    expect(style.variants.length).toBeLessThanOrEqual(2);
  });
});
