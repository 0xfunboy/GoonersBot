import { describe, expect, it } from 'vitest';
import type { SceneAnalysis } from '../src/brain/types.js';
import {
  Cortex,
  cortexToTurnEvaluation,
  normalizeDecision,
} from '../src/brain/cortex/evaluator.js';
import type { CortexDecision } from '../src/brain/cortex/schema.js';
import { fakeLLM } from './helpers.js';

const scene: SceneAnalysis = {
  currentTopic: '',
  energy: 'medium',
  humorStyle: [],
  activeUsers: [],
  mentionedUsers: [],
  openThreads: [],
  botIsBeingAddressed: true,
  botIsBeingCriticized: false,
  userIntent: 'ask_bot',
  shouldUseMemory: true,
  shouldBeDefensive: false,
  bestAngle: '',
  risk: 'low',
};

const caps = {
  webSearch: true,
  imageLookup: true,
  news: true,
  knowledge: true,
  music: true,
  imageGeneration: true,
  translation: true,
  tts: true,
};

function decision(over: Partial<CortexDecision> = {}): CortexDecision {
  return {
    intents: ['web_lookup', 'answer'],
    toolCalls: [{ tool: 'web_search', query: 'RTX 5090 price', reason: 'moving target' }],
    valueTarget: 'truth',
    roastBudget: 'light',
    socialRole: 'truth_checker',
    needsGrounding: true,
    confidence: 0.9,
    reason: 'test',
    ...over,
  };
}

describe('Cortex', () => {
  it.each([
    'quanto costa una RTX 5090 adesso?',
    'what do RTX 5090s cost now?',
    'cuanto cuesta una RTX 5090 ahora?',
  ])('routes the same meaning across languages: %s', async (message) => {
    const cortex = new Cortex(fakeLLM({ json: decision() }), {
      enabled: true,
      model: 'm',
      temperature: 0.1,
      maxTokens: 1200,
    });
    const out = await cortex.evaluate({
      scene,
      history: [],
      currentMessage: message,
      botIsAddressed: true,
      recentNegativeFeedback: false,
      capabilities: caps,
    });
    expect(out.source).toBe('llm');
    expect(out.toolCalls.map((c) => c.tool)).toEqual(['web_search']);
    expect(cortexToTurnEvaluation(out, true).providerRequests).toContain('web_search');
  });

  it('honors needsGrounding by injecting web_search without regex override', () => {
    const out = normalizeDecision(
      decision({ toolCalls: [], needsGrounding: true }),
      ['web_search'],
      'what do 5090s cost',
    );
    expect(out.toolCalls).toEqual([
      {
        tool: 'web_search',
        query: 'what do 5090s cost',
        reason: 'model marked needsGrounding without web_search',
      },
    ]);
  });

  it('does not override a successful model decision because an Italian tool word appears', async () => {
    const cortex = new Cortex(
      fakeLLM({
        json: decision({
          intents: ['banter'],
          toolCalls: [],
          valueTarget: 'joke',
          roastBudget: 'heavy',
          socialRole: 'banter',
          needsGrounding: false,
          reason: 'model chose banter',
        }),
      }),
      { enabled: true, model: 'm', temperature: 0.1, maxTokens: 1200 },
    );
    const out = await cortex.evaluate({
      scene,
      history: [],
      currentMessage: 'cerca cerca cerca ma era solo una presa per il culo',
      botIsAddressed: true,
      recentNegativeFeedback: false,
      capabilities: caps,
    });
    expect(out.intents).toEqual(['banter']);
    expect(out.toolCalls).toEqual([]);
    expect(cortexToTurnEvaluation(out, true).action).toBe('banter_only');
  });

  it('maps multi-intent web answer banter into grounded generation contract', async () => {
    const out = {
      ...decision({
        intents: ['web_lookup', 'answer', 'banter'],
        roastBudget: 'light',
      }),
      source: 'llm' as const,
    };
    const evaluation = cortexToTurnEvaluation(out, true);
    expect(evaluation.action).toBe('ground_search');
    expect(evaluation.providerRequests).toContain('web_search');
    expect(evaluation.roastBudget).toBe('light');
    expect(evaluation.shouldAct).toBe(true);
  });

  it('uses fallback source when jsonCompletion fails', async () => {
    const cortex = new Cortex(fakeLLM({}), {
      enabled: true,
      model: 'm',
      temperature: 0.1,
      maxTokens: 1200,
    });
    const out = await cortex.evaluate({
      scene,
      history: [],
      currentMessage: 'play bohemian rhapsody',
      botIsAddressed: true,
      recentNegativeFeedback: false,
      capabilities: caps,
    });
    expect(out.source).toBe('fallback');
    expect(out.toolCalls.some((c) => c.tool === 'music')).toBe(true);
  });
});
