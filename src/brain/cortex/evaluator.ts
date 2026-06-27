import type { StoredMessage } from '../../storage/repositories/messages.js';
import type { LLMProvider } from '../../providers/llm/types.js';
import { childLogger } from '../../utils/logger.js';
import type { SceneAnalysis, TurnEvaluation } from '../types.js';
import {
  cortexDecisionSchema,
  type CortexDecision,
  type CortexTool,
  type SourcedCortexDecision,
} from './schema.js';
import { fallbackCortex } from './fallback.js';
import { buildCortexPrompt, CORTEX_SYSTEM } from './prompt.js';

const log = childLogger('cortex');

export interface CortexCapabilities {
  webSearch: boolean;
  imageLookup: boolean;
  news: boolean;
  knowledge: boolean;
  music: boolean;
  linkMedia: boolean;
  imageGeneration: boolean;
  translation: boolean;
  tts: boolean;
}

export interface CortexInput {
  scene: SceneAnalysis;
  history: StoredMessage[];
  currentMessage: string;
  threadContext?: string;
  botIsAddressed: boolean;
  recentNegativeFeedback: boolean;
  capabilities: CortexCapabilities;
  /** Per-turn model policy, applied to Cortex before any provider work is selected. */
  model?: string;
}

export interface CortexConfig {
  enabled: boolean;
  model: string | undefined;
  temperature: number;
  maxTokens: number;
}

export class Cortex {
  constructor(
    private readonly llm: LLMProvider | null,
    private readonly cfg: CortexConfig,
  ) {}

  async evaluate(input: CortexInput): Promise<SourcedCortexDecision> {
    const availableTools = availableToolsFor(input.capabilities);
    const degraded = fallbackCortex({
      currentMessage: input.currentMessage,
      botIsAddressed: input.botIsAddressed,
      availableTools,
    });
    if (!this.cfg.enabled || !this.llm?.capabilities.chat) return degraded;
    try {
      const model = input.model ?? this.cfg.model;
      const parsed = await this.llm.jsonCompletion({
        system: CORTEX_SYSTEM,
        prompt: buildCortexPrompt({
          currentMessage: input.currentMessage,
          threadContext: input.threadContext,
          availableTools,
          history: input.history,
          scene: input.scene,
          botIsAddressed: input.botIsAddressed,
          recentNegativeFeedback: input.recentNegativeFeedback,
          fallback: degraded,
        }),
        schema: cortexDecisionSchema,
        temperature: this.cfg.temperature,
        ...(model ? { model } : {}),
        maxTokens: this.cfg.maxTokens,
      });
      if (!parsed) return degraded;
      return {
        ...normalizeDecision(
          { ...parsed, toolCalls: parsed.toolCalls ?? [] },
          availableTools,
          input.currentMessage,
        ),
        source: 'llm',
      };
    } catch (err) {
      log.warn({ err }, 'cortex LLM failed; using degraded fallback');
      return degraded;
    }
  }
}

export function normalizeDecision(
  decision: CortexDecision,
  availableTools: CortexTool[],
  currentMessage: string,
): CortexDecision {
  const allowed = new Set(availableTools);
  const toolCalls = decision.toolCalls.filter((call) => allowed.has(call.tool));
  if (
    decision.needsGrounding &&
    !decision.intents.includes('stay_quiet') &&
    allowed.has('web_search') &&
    !toolCalls.some((call) => call.tool === 'web_search')
  ) {
    toolCalls.push({
      tool: 'web_search',
      query: currentMessage,
      reason: 'model marked needsGrounding without web_search',
    });
  }
  return {
    ...decision,
    toolCalls,
    confidence: Math.max(0, Math.min(1, decision.confidence)),
  };
}

export function availableToolsFor(capabilities: CortexCapabilities): CortexTool[] {
  const tools: CortexTool[] = [];
  if (capabilities.webSearch) tools.push('web_search');
  if (capabilities.news) tools.push('news');
  if (capabilities.imageLookup) tools.push('image_lookup');
  if (capabilities.knowledge) tools.push('knowledge_rag');
  tools.push('group_rag');
  if (capabilities.music) tools.push('music');
  if (capabilities.linkMedia) tools.push('link_media');
  if (capabilities.imageGeneration) tools.push('image_gen');
  if (capabilities.translation) tools.push('translate');
  if (capabilities.tts) tools.push('tts');
  return tools;
}

export function cortexToTurnEvaluation(
  decision: SourcedCortexDecision,
  botIsAddressed: boolean,
): TurnEvaluation {
  const tool = (name: CortexTool) => decision.toolCalls.find((call) => call.tool === name);
  const providers = decision.toolCalls.map((call) => providerFromTool(call.tool));
  const onlyStayQuiet = decision.intents.length === 1 && decision.intents[0] === 'stay_quiet';
  const action = actionFromDecision(decision, botIsAddressed);
  return {
    shouldAct: botIsAddressed || !onlyStayQuiet,
    action,
    providerRequests: [...new Set(providers)],
    valueTarget: decision.valueTarget,
    roastBudget: decision.roastBudget,
    socialRole: decision.socialRole,
    confidence: decision.confidence,
    reason: `${decision.source}: ${decision.reason}`,
    ...(tool('web_search')?.query ? { searchQuery: tool('web_search')?.query } : {}),
    ...(tool('music')?.query ? { musicQuery: tool('music')?.query } : {}),
    ...(tool('link_media')?.query ? { mediaQuery: tool('link_media')?.query } : {}),
    ...(tool('link_media')?.args?.url ? { mediaUrl: tool('link_media')?.args?.url } : {}),
    ...(tool('image_gen')?.query ? { imagePrompt: tool('image_gen')?.query } : {}),
    ...(tool('translate')?.args?.targetLanguage
      ? { targetLanguage: tool('translate')?.args?.targetLanguage }
      : {}),
    ...(tool('translate')?.query ? { sourceText: tool('translate')?.query } : {}),
    ...(tool('tts')?.args?.voiceText
      ? { voiceText: tool('tts')?.args?.voiceText }
      : tool('tts')?.query
        ? { voiceText: tool('tts')?.query }
        : {}),
  };
}

function providerFromTool(tool: CortexTool): TurnEvaluation['providerRequests'][number] {
  if (tool === 'image_gen') return 'image_generation';
  if (tool === 'translate') return 'translation';
  return tool;
}

function actionFromDecision(
  decision: SourcedCortexDecision,
  botIsAddressed: boolean,
): TurnEvaluation['action'] {
  const has = (intent: CortexDecision['intents'][number]): boolean =>
    decision.intents.includes(intent);
  const tool = (name: CortexTool): boolean => decision.toolCalls.some((call) => call.tool === name);
  if (has('download_media') || tool('link_media')) return 'download_media';
  if (has('play_music') || tool('music')) return 'download_music';
  if (has('draw_image')) return 'draw_image';
  if (has('make_image') || tool('image_gen')) return 'generate_image';
  if (has('translate') || tool('translate')) return 'translate_text';
  if (has('voice_note') || tool('tts')) return 'make_voice';
  if (has('news_context') && tool('news') && !has('answer')) return 'post_news';
  if (has('correct_claim')) return 'challenge_claim';
  if (has('web_lookup') || tool('web_search'))
    return has('news_context') ? 'bring_news_context' : 'ground_search';
  if (has('summarize')) return 'summarize_thread';
  if (has('recall_group')) return 'use_group_lore';
  if (has('banter') && !has('answer')) return 'banter_only';
  if (has('stay_quiet') && !botIsAddressed) return 'stay_quiet';
  return 'answer';
}
