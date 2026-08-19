import { describe, expect, it } from 'vitest';
import type { SceneAnalysis } from '../src/brain/types.js';
import {
  Cortex,
  cortexToTurnEvaluation,
  normalizeDecision,
} from '../src/brain/cortex/evaluator.js';
import type { CortexDecision } from '../src/brain/cortex/schema.js';
import { CORTEX_FEWSHOT, CORTEX_SYSTEM } from '../src/brain/cortex/prompt.js';
import {
  animeArchiveLookupFromAnswer,
  shouldUseTerminalAgentRuntime,
} from '../src/services/reply.js';
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
  anime: true,
  animeArchive: true,
  music: true,
  linkMedia: true,
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
  it('uses a per-turn model override for evaluation', async () => {
    let model: string | undefined;
    const llm = fakeLLM({ json: decision() });
    const original = llm.jsonCompletion.bind(llm);
    llm.jsonCompletion = async (req) => {
      model = req.model;
      return original(req);
    };
    const cortex = new Cortex(llm, {
      enabled: true,
      model: 'premium-model',
      temperature: 0.1,
      maxTokens: 1200,
    });
    await cortex.evaluate({
      scene,
      history: [],
      currentMessage: 'check this',
      botIsAddressed: true,
      recentNegativeFeedback: false,
      capabilities: caps,
      model: 'economy-model',
    });
    expect(model).toBe('economy-model');
  });

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

  it('assigns natural anime availability/rehost intent to the Cortex tool contract', () => {
    const prompt = `${CORTEX_SYSTEM}\n${CORTEX_FEWSHOT}`;
    expect(prompt).toContain('anime_archive');
    expect(prompt).toContain('AnimeUnity and HentaiSaturn');
    expect(prompt).toContain('availability | rehost | series');
    expect(prompt).toContain(
      'to queue the requested episode. If the user asks to download/rehost/send',
    );
    expect(prompt).toContain('ALWAYS wins even when the same sentence also says');
    expect(prompt).toContain('args.episode = "latest"');
    expect(prompt).toContain('cerca l ultimo episodio di Chainsaw Man e rehostalo');
    expect(prompt).toContain('EVERY EPISODE CURRENTLY AVAILABLE');
    expect(prompt).toContain(
      'cerca la terza serie Mushoku Tensei e rehosta gli episodi disponibili',
    );
    expect(prompt).toContain('mi accontento degli episodi usciti fino ad ora');
    expect(prompt).toContain('after YOU have classified the intent');
    expect(prompt).not.toContain('official streaming links');
  });

  it('keeps a model-selected anime_archive action and suppresses redundant web grounding', () => {
    const out = normalizeDecision(
      decision({
        intents: ['archive_anime'],
        toolCalls: [
          {
            tool: 'anime_archive',
            query: 'Tanya the Evil 2',
            args: {
              intent: 'rehost',
              title: 'Tanya the Evil 2',
              episode: '7',
              source: 'animeunity',
            },
            reason: 'explicit anime episode rehost request',
          },
          {
            tool: 'web_search',
            query: 'Tanya episode 7',
            reason: 'redundant generic grounding',
          },
        ],
        needsGrounding: true,
      }),
      ['anime_archive', 'web_search'],
      "controlla se è uscito l'episodio 7 di Tanya the Evil 2 e rehostalo",
    );
    expect(out.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'anime_archive',
        args: expect.objectContaining({ intent: 'rehost', episode: '7' }),
      }),
    ]);
    const evaluation = cortexToTurnEvaluation({ ...out, source: 'llm' }, true);
    expect(evaluation.action).toBe('archive_anime');
    expect(evaluation.providerRequests).toEqual(['anime_archive']);
    expect(shouldUseTerminalAgentRuntime({ toolCalls: out.toolCalls }, false)).toBe(true);
  });

  it('drops a model-supplied web_search when anime_knowledge already grounds the turn', () => {
    const out = normalizeDecision(
      decision({
        toolCalls: [
          {
            tool: 'web_search',
            query: 'Frieren latest episode',
            reason: 'redundant generic grounding',
          },
          {
            tool: 'anime_knowledge',
            query: 'Frieren',
            reason: 'structured live catalog',
          },
          {
            tool: 'group_rag',
            reason: 'retain unrelated context tool',
          },
        ],
        needsGrounding: true,
      }),
      ['anime_knowledge', 'web_search', 'group_rag'],
      'quando esce Frieren?',
    );
    expect(out.toolCalls.map((call) => call.tool)).toEqual(['anime_knowledge', 'group_rag']);
    expect(cortexToTurnEvaluation({ ...out, source: 'llm' }, true).providerRequests).not.toContain(
      'web_search',
    );
  });

  it('keeps the anime answer in styled reply routing and exposes its archive lookup', () => {
    const rawMixedDecision = decision({
      toolCalls: [
        {
          tool: 'anime_knowledge',
          query: 'Frieren',
          args: { intent: 'lookup' },
          reason: 'structured live catalog',
        },
        {
          tool: 'web_search',
          query: 'Frieren latest episode',
          reason: 'redundant generic grounding',
        },
      ],
    });
    expect(shouldUseTerminalAgentRuntime(rawMixedDecision, false)).toBe(false);
    expect(
      shouldUseTerminalAgentRuntime(
        {
          toolCalls: [
            ...rawMixedDecision.toolCalls,
            { tool: 'image_gen', query: 'Frieren', reason: 'requested artifact' },
          ],
        },
        false,
      ),
    ).toBe(true);

    const answer = {
      resolved: true,
      summary: 'Frieren è arrivato all’episodio 28.',
      candidates: [],
      sources: ['https://anilist.co/anime/154587'],
      series: {
        title: 'Frieren: Beyond Journey’s End',
        titleEnglish: 'Frieren: Beyond Journey’s End',
        titleRomaji: 'Sousou no Frieren',
        titleNative: '葬送のフリーレン',
        aliases: ['Frieren'],
        latestEpisode: 28,
      },
    } as never;
    expect(animeArchiveLookupFromAnswer('lookup', answer)).toEqual({
      titles: [
        'Frieren: Beyond Journey’s End',
        'Frieren: Beyond Journey’s End',
        'Sousou no Frieren',
        '葬送のフリーレン',
        'Frieren',
      ],
      episodeNumber: 28,
    });
    expect(animeArchiveLookupFromAnswer('follow', answer)).toBeUndefined();
    expect(animeArchiveLookupFromAnswer('unfollow', answer)).toBeUndefined();
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

  it('routes generic video downloads to link-media, not music', () => {
    const out = {
      ...decision({
        intents: ['download_media'],
        toolCalls: [
          {
            tool: 'link_media',
            query: 'first downloadable video about GTAV',
            reason: 'download and rehost a video',
          },
        ],
        needsGrounding: true,
      }),
      source: 'llm' as const,
    };
    const evaluation = cortexToTurnEvaluation(out, true);
    expect(evaluation.action).toBe('download_media');
    expect(evaluation.providerRequests).toContain('link_media');
    expect(evaluation.providerRequests).not.toContain('music');
    expect(evaluation.mediaQuery).toBe('first downloadable video about GTAV');
  });

  it('keeps explicit image subjects in the image generation contract', () => {
    const out = {
      ...decision({
        intents: ['draw_image'],
        toolCalls: [
          {
            tool: 'image_gen',
            query: 'adult graffiti drawing of a penis on a concrete wall',
            args: { profile: 'nsfw' },
            reason: 'preserve exact requested subject',
          },
        ],
        needsGrounding: false,
      }),
      source: 'llm' as const,
    };
    const evaluation = cortexToTurnEvaluation(out, true);
    expect(evaluation.action).toBe('draw_image');
    expect(evaluation.providerRequests).toEqual(['image_generation']);
    expect(evaluation.imagePrompt).toContain('penis');
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
      currentMessage: 'scaricami bohemian rhapsody',
      botIsAddressed: true,
      recentNegativeFeedback: false,
      capabilities: caps,
    });
    expect(out.source).toBe('fallback');
    expect(out.toolCalls.some((c) => c.tool === 'music')).toBe(true);
    expect(out.toolCalls.find((c) => c.tool === 'music')?.query).toBe('bohemian rhapsody');
  });

  it('does not turn a technical proposal into a media download when cortex falls back', async () => {
    const cortex = new Cortex(fakeLLM({}), {
      enabled: true,
      model: 'm',
      temperature: 0.1,
      maxTokens: 1200,
    });
    const out = await cortex.evaluate({
      scene,
      history: [],
      currentMessage:
        'serve un analisi tecnica lunga e completa su tutta la proposta di boop, repo e snippet',
      botIsAddressed: true,
      recentNegativeFeedback: false,
      capabilities: caps,
    });
    expect(out.source).toBe('fallback');
    expect(out.toolCalls.some((call) => call.tool === 'link_media')).toBe(false);
    expect(cortexToTurnEvaluation(out, true).action).toBe('answer');
  });

  it('keeps direct URL rehosting available when cortex falls back', async () => {
    const cortex = new Cortex(fakeLLM({}), {
      enabled: true,
      model: 'm',
      temperature: 0.1,
      maxTokens: 1200,
    });
    const out = await cortex.evaluate({
      scene,
      history: [],
      currentMessage: 'mandami questo https://example.test/video.mp4',
      botIsAddressed: true,
      recentNegativeFeedback: false,
      capabilities: caps,
    });
    expect(out.toolCalls).toContainEqual(
      expect.objectContaining({
        tool: 'link_media',
        args: { url: 'https://example.test/video.mp4' },
      }),
    );
    expect(cortexToTurnEvaluation(out, true).action).toBe('download_media');
  });
});
