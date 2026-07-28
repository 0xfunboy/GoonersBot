import { describe, expect, it } from 'vitest';
import { ReplyPlanner } from '../src/brain/replyPlanner.js';
import { RepetitionGuard, extractJokePremises } from '../src/brain/repetitionGuard.js';
import { ResponseRanker } from '../src/brain/responseRanker.js';
import { classifySocialSignal, isSeriousSupport } from '../src/brain/socialAwareness.js';
import { StyleEngine } from '../src/brain/styleEngine.js';
import { TurnEvaluator } from '../src/brain/turnEvaluator.js';
import type { RetrievedMemory } from '../src/memory/types.js';
import type {
  BotReplyRecord,
  ReplyPlan,
  SceneAnalysis,
  TurnEvaluation,
} from '../src/brain/types.js';

const record = (text: string, over: Partial<BotReplyRecord> = {}): BotReplyRecord => ({
  chatId: -1,
  text,
  normalizedText: text.toLowerCase(),
  fingerprint: text,
  createdAt: new Date(),
  usedMemoryIds: [],
  ...over,
});

const scene = (over: Partial<SceneAnalysis> = {}): SceneAnalysis => ({
  currentTopic: '',
  energy: 'medium',
  humorStyle: ['roast'],
  activeUsers: ['@bob'],
  mentionedUsers: [],
  openThreads: [],
  botIsBeingAddressed: true,
  botIsBeingCriticized: false,
  userIntent: 'continue_banter',
  shouldUseMemory: true,
  shouldBeDefensive: false,
  bestAngle: '',
  risk: 'low',
  ...over,
});

const evaluation = (over: Partial<TurnEvaluation> = {}): TurnEvaluation => ({
  shouldAct: true,
  action: 'banter_only',
  providerRequests: [],
  valueTarget: 'joke',
  roastBudget: 'heavy',
  socialRole: 'banter',
  confidence: 0.8,
  reason: 'test',
  ...over,
});

const plan = (over: Partial<ReplyPlan> = {}): ReplyPlan => ({
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

describe('social awareness floor', () => {
  it('treats a profane plea for help as vulnerability, not banter', () => {
    const signal = classifySocialSignal({
      currentMessage: 'sono a pezzi e non ce la faccio, aiutami coglione',
      botIsAddressed: true,
    });
    expect(signal.situation).toBe('vulnerability');
    expect(signal.supportNeed).toBe('high');
    expect(signal.humorAllowed).toBe(false);
    expect(signal.roastCeiling).toBe('none');
  });

  it('detects urgent distress but ignores a common laughing idiom', () => {
    const urgent = classifySocialSignal({
      currentMessage: 'voglio farla finita, non voglio più vivere',
    });
    const joke = classifySocialSignal({
      currentMessage: 'mi ammazzo dal ridere, che coglione',
    });
    expect(urgent.situation).toBe('urgent_distress');
    expect(urgent.supportNeed).toBe('urgent');
    expect(isSeriousSupport(urgent)).toBe(true);
    expect(joke.supportNeed).toBe('none');
    expect(joke.situation).toBe('banter');
  });

  it('carries a severe event across a short conversational continuation', () => {
    const signal = classifySocialSignal({
      currentMessage: 'non so proprio che fare',
      history: [
        {
          isBot: false,
          message: { messageText: 'è morto mio padre ieri' },
        },
      ],
    });
    expect(signal.situation).toBe('vulnerability');
    expect(signal.memoryPolicy).toBe('avoid_callbacks');
  });

  it('does not mistake a dead server or an insulting question for vulnerability/factual help', () => {
    const server = classifySocialSignal({
      currentMessage: 'il server è morto, come lo riavvio?',
    });
    const sparring = classifySocialSignal({
      currentMessage: 'ma sei completamente scemo?',
      botIsAddressed: true,
    });
    expect(server.situation).toBe('factual_help');
    expect(server.supportNeed).toBe('none');
    expect(sparring.situation).toBe('banter');
    expect(sparring.roastCeiling).toBe('heavy');
  });

  it('accepts gratitude without converting it into another stale roast', () => {
    const gratitude = classifySocialSignal({
      currentMessage: 'grazie, molto gentile',
      botIsAddressed: true,
    });
    expect(gratitude.situation).toBe('gratitude');
    expect(gratitude.roastCeiling).toBe('none');
    expect(gratitude.humorAllowed).toBe(false);

    const planned = new ReplyPlanner().plan({
      scene: scene({ socialSignal: gratitude }),
      evaluation: evaluation({ socialSignal: gratitude }),
      retrievedMemories: [],
      bannedOpenings: [],
      currentHandle: '@bob',
      maxLines: 3,
      maxChars: 420,
      comedyStrategy: 'absurd_analogy',
    });
    expect(planned.replyIntent).toBe('acknowledge_gratitude');
    expect(planned.roastBudget).toBe('none');
    expect(planned.memoryUseMode).toBe('none');
    expect(planned.comedyStrategy).toBe('none');
  });

  it('does not misclassify thanks containing "aiuto" as a new roastable help request', () => {
    const gratitude = classifySocialSignal({
      currentMessage: "grazie dell'aiuto, sei stato utile",
      botIsAddressed: true,
    });
    expect(gratitude.situation).toBe('gratitude');
    expect(gratitude.humorAllowed).toBe(false);

    const style = new StyleEngine().sample({
      modeName: 'Degenerate',
      modeDescription: 'chaos',
      scene: scene({ energy: 'chaotic', socialSignal: gratitude }),
      recentBotReplies: [],
      nsfwEnabled: true,
      valueTarget: 'social_glue',
      socialRole: 'friend',
    });
    expect(style.aggression).toBe(0);
    expect(style.absurdity).toBe(0);
    expect(style.chaos).toBe(0);
    expect(style.degen).toBe(0);
  });

  it('hard-demotes a backhanded gratitude roast', () => {
    const gratitude = classifySocialSignal({
      currentMessage: "grazie dell'aiuto",
      botIsAddressed: true,
    });
    const ranked = new ResponseRanker().rank(
      ['Grazie un cazzo, molto gentile sarai tu.', 'Figurati. Quando serve, ci sono.'],
      {
        recent: [],
        plan: plan({
          replyIntent: 'acknowledge_gratitude',
          action: 'answer',
          valueTarget: 'social_glue',
          roastBudget: 'none',
          socialRole: 'friend',
          mustBringValue: false,
          socialSignal: gratitude,
        }),
        memories: [],
        maxChars: 420,
        userMessage: "grazie dell'aiuto",
      },
    );
    expect(ranked[0]?.index).toBe(1);
    expect(ranked.find((candidate) => candidate.index === 0)?.problems).toContain(
      'violates social floor',
    );
  });
});

describe('support routing and style', () => {
  const support = classifySocialSignal({
    currentMessage: 'sto davvero male e ho bisogno di aiuto, stronzo',
    botIsAddressed: true,
  });

  it('forces reliable support even when banter markers are present', async () => {
    const evaluator = new TurnEvaluator();
    const result = await evaluator.evaluate({
      scene: scene({ socialSignal: support }),
      history: [],
      currentMessage: 'sto davvero male e ho bisogno di aiuto, stronzo',
      botIsAddressed: true,
      recentBotReplies: [],
      recentNegativeFeedback: false,
      capabilities: {
        webSearch: true,
        imageLookup: true,
        news: true,
        knowledge: true,
        music: true,
        imageGeneration: true,
        videoGeneration: true,
        translation: true,
        tts: true,
      },
      groundingHints: { wantsWebSearch: false, wantsImageLookup: false },
    });
    expect(result.action).toBe('answer');
    expect(result.valueTarget).toBe('support');
    expect(result.roastBudget).toBe('none');
    expect(result.socialRole).toBe('friend');
  });

  it('suppresses lore callbacks and makes the useful answer mandatory', () => {
    const result = new ReplyPlanner().plan({
      scene: scene({ socialSignal: support }),
      evaluation: evaluation({ socialSignal: support }),
      retrievedMemories: [],
      bannedOpenings: [],
      currentHandle: '@bob',
      maxLines: 3,
      maxChars: 420,
      comedyStrategy: 'absurd_analogy',
    });
    expect(result.replyIntent).toBe('answer_question');
    expect(result.memoryUseMode).toBe('none');
    expect(result.roastBudget).toBe('none');
    expect(result.mustBringValue).toBe(true);
    expect(result.comedyStrategy).toBe('none');
    expect(result.forbiddenReferences).toContain("the person's vulnerability as a punchline");
  });

  it('uses a calm supportive voice regardless of NSFW/chaos settings', () => {
    const style = new StyleEngine().sample({
      modeName: 'Degenerate',
      modeDescription: 'chaos',
      scene: scene({ energy: 'chaotic', socialSignal: support }),
      recentBotReplies: [],
      nsfwEnabled: true,
      valueTarget: 'support',
      socialRole: 'friend',
    });
    expect(style.aggression).toBe(0);
    expect(style.nsfw).toBe(0);
    expect(style.chaos).toBeLessThan(0.1);
    expect(style.comedyStrategies).toEqual(['none']);
    expect(style.humorAllowed).toBe(false);
  });

  it('ranks acknowledgement plus an action above a dismissive roast', () => {
    const ranked = new ResponseRanker().rank(
      [
        'Smettila di frignare, coglione.',
        'Mi dispiace, ti credo. Respira e chiama subito qualcuno che può stare con te.',
      ],
      {
        recent: [],
        plan: plan({
          replyIntent: 'answer_question',
          action: 'answer',
          valueTarget: 'support',
          roastBudget: 'none',
          socialRole: 'friend',
          mustBringValue: true,
          socialSignal: support,
        }),
        memories: [],
        maxChars: 420,
        userMessage: 'sto male e non so che fare',
      },
    );
    expect(ranked[0]?.index).toBe(1);
    expect(ranked.find((candidate) => candidate.index === 0)?.problems).toContain(
      'hostile during support',
    );
  });
});

describe('semantic anti-repetition', () => {
  const guard = new RepetitionGuard(0.72);

  it('recognizes a reused premise without discarding an otherwise fresh reply', () => {
    const recent = [record('Hai trasformato il portafoglio in un cratere col trading, fenomeno.')];
    const result = guard.check(
      'Il bancomat chiede protezione testimoni quando ti vede investire.',
      recent,
      plan(),
      [],
    );
    expect(extractJokePremises(recent[0]!.text)).toContain('money_trading');
    expect(result.allowed).toBe(true);
    expect(result.hardBlocked).toBe(false);
    expect(result.repeatedPremises).toContain('money_trading');
    expect(result.advisoryReasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/stale premise/)]),
    );
  });

  it('allows a genuinely different comic premise', () => {
    const result = guard.check(
      'Il tuo frigorifero ha più iniziativa politica di te.',
      [record('Hai trasformato il portafoglio in un cratere col trading.')],
      plan(),
      [],
    );
    expect(result.allowed).toBe(true);
    expect(result.repeatedPremises).toEqual([]);
  });

  it('blocks an explicit lore callback that was just used', () => {
    const memory: RetrievedMemory = {
      item: {
        _id: 'doom',
        chatId: -1,
        subjectType: 'user',
        subjectHandle: '@bob',
        involvedHandles: ['@bob'],
        text: 'Bob organizza sempre raid doom metal alle otto',
        normalizedText: 'bob organizza sempre raid doom metal alle otto',
        category: 'running_joke',
        source: 'auto',
        sourceMessageIds: [],
        confidence: 0.9,
        salience: 0.8,
        toxicity: 'clean',
        status: 'active',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        useCount: 2,
        positiveFeedbackCount: 0,
        negativeFeedbackCount: 0,
        tags: [],
      },
      relevance: 0.9,
      reason: 'subject mentioned',
      allowedToUseExplicitly: true,
    };
    const result = guard.check(
      'Bob organizza ancora il suo raid doom metal alle otto.',
      [record('Ieri era già raid time.', { usedMemoryIds: ['doom'] })],
      plan({
        replyIntent: 'lore_callback',
        action: 'use_group_lore',
        memoryUseMode: 'explicit_callback',
        memoryIdsToUse: ['doom'],
      }),
      [memory],
    );
    expect(result.allowed).toBe(false);
    expect(result.callbackSaturation).toBe(true);
    expect(result.overusedMemoryIds).toContain('doom');
  });
});
