import { describe, expect, it } from 'vitest';
import { ResponseRanker } from '../src/brain/responseRanker.js';
import { RepetitionGuard } from '../src/brain/repetitionGuard.js';
import { ReplyPlanner } from '../src/brain/replyPlanner.js';
import { StyleEngine } from '../src/brain/styleEngine.js';
import type {
  BotReplyRecord,
  ReplyPlan,
  SceneAnalysis,
  TurnEvaluation,
} from '../src/brain/types.js';
import { TurnEvaluator } from '../src/brain/turnEvaluator.js';
import { fakeLLM } from './helpers.js';

const emptyPlan = (over: Partial<ReplyPlan> = {}): ReplyPlan => ({
  replyIntent: 'roast_user',
  action: 'banter_only',
  valueTarget: 'joke',
  roastBudget: 'heavy',
  socialRole: 'banter',
  mustBringValue: false,
  targetHandles: ['@bob'],
  tone: 'group-native',
  maxLines: 2,
  maxChars: 420,
  memoryIdsToUse: [],
  memoryUseMode: 'none',
  forbiddenReferences: [],
  bannedPhrases: [],
  noveltyInstruction: '',
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

const evaluation = (over: Partial<TurnEvaluation> = {}): TurnEvaluation => ({
  shouldAct: true,
  action: 'answer',
  providerRequests: ['group_rag', 'knowledge_rag'],
  valueTarget: 'truth',
  roastBudget: 'light',
  socialRole: 'friend',
  confidence: 0.8,
  reason: 'test',
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

  it('prefers useful factual content over roast-only when the turn must bring value', () => {
    const ranker = new ResponseRanker();
    const ranked = ranker.rank(
      [
        'sei un coglione, fine analisi',
        'In realtà è falso: la RTX 5090 non costa sempre uguale, dipende da modello e disponibilità. Poi sì, comprarla a caso è da criminale del portafoglio.',
      ],
      {
        recent: [],
        plan: emptyPlan({
          replyIntent: 'answer_question',
          action: 'challenge_claim',
          valueTarget: 'truth',
          roastBudget: 'light',
          socialRole: 'truth_checker',
          mustBringValue: true,
        }),
        memories: [],
        maxChars: 420,
        userMessage: 'la rtx 5090 costa sempre 1000 euro',
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
    evaluation: evaluation(),
    retrievedMemories: [],
    bannedOpenings: [],
    currentHandle: '@bob',
    maxLines: 3,
    maxChars: 420,
  };
  it('criticism → roast_self with no memory', () => {
    const p = planner.plan({
      ...baseInput,
      evaluation: evaluation({ action: 'banter_only', valueTarget: 'social_glue' }),
      scene: scene({ botIsBeingCriticized: true, userIntent: 'insult_bot' }),
    });
    expect(p.replyIntent).toBe('roast_self');
    expect(p.memoryUseMode).toBe('none');
    expect(p.noveltyInstruction).toMatch(/structure/i);
  });
  it('dangerous → answer', () => {
    const p = planner.plan({
      ...baseInput,
      evaluation: evaluation({ action: 'answer', valueTarget: 'truth' }),
      scene: scene({ userIntent: 'dangerous_request', risk: 'high' }),
    });
    expect(p.replyIntent).toBe('answer_question');
    expect(p.mustAnswer).toBe(true);
  });
  it('question → answer', () => {
    const p = planner.plan({
      ...baseInput,
      evaluation: evaluation({ action: 'answer', valueTarget: 'truth' }),
      scene: scene({ userIntent: 'ask_bot' }),
    });
    expect(p.replyIntent).toBe('answer_question');
    expect(p.mustAnswer).toBe(true);
  });

  it('challenge claim plans must bring value and avoid explicit lore callbacks', () => {
    const p = planner.plan({
      ...baseInput,
      evaluation: evaluation({ action: 'challenge_claim', valueTarget: 'truth' }),
      scene: scene({ userIntent: 'random_chatter' }),
    });
    expect(p.replyIntent).toBe('answer_question');
    expect(p.mustBringValue).toBe(true);
    expect(p.roastBudget).toBe('light');
  });
});

describe('TurnEvaluator', () => {
  const evaluator = new TurnEvaluator();
  const base = {
    history: [],
    recentBotReplies: [],
    recentNegativeFeedback: false,
    capabilities: {
      webSearch: true,
      imageLookup: true,
      news: true,
      knowledge: true,
      music: true,
      imageGeneration: true,
      translation: true,
      tts: true,
    },
    groundingHints: { wantsWebSearch: false, wantsImageLookup: false },
  };

  it('routes current factual questions to grounded search', async () => {
    const e = await evaluator.evaluate({
      ...base,
      scene: scene({ userIntent: 'ask_bot' }),
      currentMessage: 'quanto costa bitcoin oggi?',
      botIsAddressed: true,
      groundingHints: { wantsWebSearch: true, wantsImageLookup: false },
    });
    expect(e.action).toBe('bring_news_context');
    expect(e.providerRequests).toContain('web_search');
  });

  it('routes challenged claims to claim checking', async () => {
    const e = await evaluator.evaluate({
      ...base,
      scene: scene({ userIntent: 'random_chatter' }),
      currentMessage: 'non è vero, questa è una cazzata: node non supporta typescript',
      botIsAddressed: true,
    });
    expect(e.action).toBe('challenge_claim');
    expect(e.valueTarget).toBe('truth');
  });

  it('stays quiet on passive low-value chatter', async () => {
    const e = await evaluator.evaluate({
      ...base,
      scene: scene({ userIntent: 'random_chatter' }),
      currentMessage: 'lol',
      botIsAddressed: false,
    });
    expect(e.shouldAct).toBe(false);
    expect(e.action).toBe('stay_quiet');
  });

  it('uses LLM JSON to force explicit online search with a precise query', async () => {
    const llmEvaluator = new TurnEvaluator(
      fakeLLM({
        json: {
          shouldAct: true,
          action: 'ground_search',
          providerRequests: ['web_search'],
          valueTarget: 'truth',
          roastBudget: 'light',
          socialRole: 'truth_checker',
          confidence: 0.96,
          reason: 'explicit online search request',
          searchQuery: 'escort Cecina',
        },
      }),
      { enabled: true, model: 'm', temperature: 0.1 },
    );
    const e = await llmEvaluator.evaluate({
      ...base,
      scene: scene({ userIntent: 'ask_bot' }),
      currentMessage: 'puoi cercare online escort su cecina?',
      botIsAddressed: true,
    });
    expect(e.action).toBe('ground_search');
    expect(e.providerRequests).toContain('web_search');
    expect(e.searchQuery).toBe('escort Cecina');
  });

  it('uses LLM JSON to route YouTube music through the music provider', async () => {
    const llmEvaluator = new TurnEvaluator(
      fakeLLM({
        json: {
          shouldAct: true,
          action: 'download_music',
          providerRequests: ['music'],
          valueTarget: 'support',
          roastBudget: 'light',
          socialRole: 'friend',
          confidence: 0.95,
          reason: 'explicit music request',
          musicQuery: 'bohemian rhapsody queen',
        },
      }),
      { enabled: true, model: 'm', temperature: 0.1 },
    );
    const e = await llmEvaluator.evaluate({
      ...base,
      scene: scene({ userIntent: 'ask_bot' }),
      currentMessage: 'scaricami bohemian rhapsody da youtube',
      botIsAddressed: true,
    });
    expect(e.action).toBe('download_music');
    expect(e.providerRequests).toContain('music');
    expect(e.musicQuery).toBe('bohemian rhapsody queen');
  });

  it.each([
    ['mi cerchi una escort su cecina?', 'ground_search', 'web_search'],
    [
      'cercami una RTX5090 allora, i prezzi dal più basso al più alto',
      'ground_search',
      'web_search',
    ],
    ['cercami online delle schede video', 'ground_search', 'web_search'],
    ['mi disegni un cazzo?', 'draw_image', 'image_generation'],
  ] as const)('hard-routes "%s" to %s', async (message, action, provider) => {
    const e = await evaluator.evaluate({
      ...base,
      scene: scene({ userIntent: 'ask_bot' }),
      currentMessage: message,
      botIsAddressed: true,
    });
    expect(e.action).toBe(action);
    expect(e.providerRequests).toContain(provider);
  });

  it('does not let a bad LLM JSON downgrade an explicit search to banter', async () => {
    const llmEvaluator = new TurnEvaluator(
      fakeLLM({
        json: {
          shouldAct: true,
          action: 'banter_only',
          providerRequests: [],
          valueTarget: 'joke',
          roastBudget: 'heavy',
          socialRole: 'banter',
          confidence: 0.9,
          reason: 'bad model choice',
        },
      }),
      { enabled: true, model: 'm', temperature: 0.1 },
    );
    const e = await llmEvaluator.evaluate({
      ...base,
      scene: scene({ userIntent: 'ask_bot' }),
      currentMessage: 'cercami online delle schede video',
      botIsAddressed: true,
    });
    expect(e.action).toBe('ground_search');
    expect(e.providerRequests).toContain('web_search');
  });

  it.each([
    {
      action: 'generate_image',
      provider: 'image_generation',
      field: 'imagePrompt',
      value: 'meme su funboy',
      message: 'generami un meme su funboy',
    },
    {
      action: 'translate_text',
      provider: 'translation',
      field: 'targetLanguage',
      value: 'English',
      message: 'traduci questo in inglese',
    },
    {
      action: 'make_voice',
      provider: 'tts',
      field: 'voiceText',
      value: 'ciao stronzi',
      message: 'mandalo vocale: ciao stronzi',
    },
    {
      action: 'post_news',
      provider: 'news',
      field: undefined,
      value: undefined,
      message: 'dammi una news di oggi',
    },
  ] as const)('uses LLM JSON to route $action through $provider', async (row) => {
    const json: Record<string, unknown> = {
      shouldAct: true,
      action: row.action,
      providerRequests: [row.provider],
      valueTarget: row.action === 'post_news' ? 'context' : 'support',
      roastBudget: 'light',
      socialRole: 'friend',
      confidence: 0.95,
      reason: 'tool request',
    };
    if (row.field) json[row.field] = row.value;
    const llmEvaluator = new TurnEvaluator(fakeLLM({ json }), {
      enabled: true,
      model: 'm',
      temperature: 0.1,
    });
    const e = await llmEvaluator.evaluate({
      ...base,
      scene: scene({ userIntent: 'ask_bot' }),
      currentMessage: row.message,
      botIsAddressed: true,
    });
    expect(e.action).toBe(row.action);
    expect(e.providerRequests).toContain(row.provider);
    if (row.field) expect(e[row.field]).toBe(row.value);
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
