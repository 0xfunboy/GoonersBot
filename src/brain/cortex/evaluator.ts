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
import {
  cortexCapabilitiesFromSnapshot,
  legacyProviderFor,
  operationIdForInvocation,
  runtimeCapabilityManifest,
  type RuntimeCapabilitySnapshotItem,
} from '../../companion/capabilities/catalog.js';
import type { TurnContext } from '../../companion/context/contracts.js';

const log = childLogger('cortex');

export interface CortexCapabilities {
  webSearch: boolean;
  pageScan?: boolean;
  imageLookup: boolean;
  news: boolean;
  knowledge: boolean;
  /** Anime release catalog (AniList) + per-chat follows. */
  anime: boolean;
  /** AnimeUnity/HentaiSaturn availability + rehost action tool. */
  animeArchive?: boolean;
  music: boolean;
  linkMedia: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  translation: boolean;
  documentCreation?: boolean;
  dataAnalysis?: boolean;
  workflows?: boolean;
  tts: boolean;
  capabilityForge?: boolean;
}

export interface CortexInput {
  scene: SceneAnalysis;
  history: StoredMessage[];
  currentMessage: string;
  threadContext?: string;
  botIsAddressed: boolean;
  recentNegativeFeedback: boolean;
  capabilities: CortexCapabilities;
  /** Authoritative per-turn readiness, shared with planner and self-knowledge when available. */
  capabilitySnapshot?: readonly RuntimeCapabilitySnapshotItem[];
  /** Manifest/recipe summaries; descriptive only, authority still comes from the snapshot. */
  capabilityDetails?: readonly string[];
  /** Host-resolved scope and visible work; content is context, never an authority grant. */
  turnContext?: TurnContext;
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
    const availableTools = input.capabilitySnapshot
      ? cortexCapabilitiesFromSnapshot(input.capabilitySnapshot)
      : availableToolsFor(input.capabilities);
    const degraded = fallbackCortex({
      currentMessage: input.currentMessage,
      botIsAddressed: input.botIsAddressed,
      availableTools,
      visibleWorkCount: input.turnContext?.visibleWork.length,
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
          availableCapabilityDetails: input.capabilityDetails,
          visibleWork: input.turnContext?.visibleWork,
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
  const allowedToolCalls = decision.toolCalls.filter((call) => allowed.has(call.tool));
  const hasAnimeKnowledge = allowedToolCalls.some((call) => call.tool === 'anime_knowledge');
  const hasAnimeArchive = allowedToolCalls.some((call) => call.tool === 'anime_archive');
  const hasAnimeGrounding = hasAnimeKnowledge || hasAnimeArchive;
  // Both anime tools are structured sources for their own domains: catalog metadata/follows and
  // archive availability/rehost. A generic web search on top only adds a conflicting gateway path.
  const toolCalls = hasAnimeGrounding
    ? allowedToolCalls.filter((call) => call.tool !== 'web_search')
    : allowedToolCalls;
  // Grounding is evidence acquisition, not synonymous with generic web search. Respect the
  // model's selected reader and its operation contract (a memory write is not a reader).
  const hasGroundingRead = toolCalls.some((call) => {
    const operationId = operationIdForInvocation(call.tool, call.args ?? {});
    const manifest = runtimeCapabilityManifest(call.tool);
    return (
      manifest.groundsClaims &&
      manifest.operations.some(
        (operation) => operation.id === operationId && operation.effect === 'read',
      )
    );
  });
  if (
    decision.needsGrounding &&
    !decision.intents.includes('stay_quiet') &&
    allowed.has('web_search') &&
    // Anime metadata and archive availability each have a structured authoritative tool. Do not
    // synthesize a generic web-search action on top of either one.
    !hasAnimeGrounding &&
    !hasGroundingRead
  ) {
    toolCalls.push({
      tool: 'web_search',
      query: currentMessage,
      reason: 'model marked needsGrounding without web_search',
    });
  }

  const isExplicitImageReq =
    /\b(genera|generami|generate|crea|creami|create|disegna|disegni|disegnami|draw|render|illustra|ritrai)\b/i.test(
      currentMessage,
    ) ||
    /\b(fai|fammi|fammene|fanne|faresti|facessi|mostrami|vediamo)\b[^.!?]{0,25}\b(un['\s]?(?:immagine|disegno|foto|ritratto|vignetta|meme)|immagini|foto)\b/i.test(
      currentMessage,
    ) ||
    /\b(immagine|immagini|foto|picture|meme|disegno|disegni|ritratto)\b/i.test(currentMessage);
  const isVideoReq =
    /\b(video|videoclip|clip|animazione|animation|filmato|cortometraggio)\b/i.test(currentMessage);
  const isMusicReq =
    /\b(canzone|musica|audio|song|brano|suonami|cantami)\b/i.test(currentMessage);
  const isOtherNonImageReq =
    /\b(testo|storia|poesia|codice|script|file|pdf|doc|documento)\b/i.test(currentMessage);

  const intents = [...decision.intents];
  if (
    allowed.has('image_gen') &&
    isExplicitImageReq &&
    !isVideoReq &&
    !isMusicReq &&
    !isOtherNonImageReq &&
    !toolCalls.some((c) => c.tool === 'image_gen' || c.tool === 'video_gen')
  ) {
    toolCalls.push({
      tool: 'image_gen',
      query: currentMessage,
      reason: 'explicit image generation request detected in message',
    });
    const imgIntent = /\b(disegna|disegni|disegnami|draw)\b/i.test(currentMessage)
      ? 'draw_image'
      : 'make_image';
    if (!intents.includes(imgIntent)) {
      intents.push(imgIntent);
    }
  }

  return {
    ...decision,
    intents,
    toolCalls,
    confidence: Math.max(0, Math.min(1, decision.confidence)),
  };
}

export function availableToolsFor(capabilities: CortexCapabilities): CortexTool[] {
  const tools: CortexTool[] = [];
  if (capabilities.webSearch) tools.push('web_search');
  if (capabilities.pageScan ?? capabilities.webSearch) tools.push('page_scan');
  if (capabilities.news) tools.push('news');
  if (capabilities.imageLookup) tools.push('image_lookup');
  if (capabilities.knowledge) tools.push('knowledge_rag');
  if (capabilities.anime) tools.push('anime_knowledge');
  if (capabilities.animeArchive) tools.push('anime_archive');
  tools.push('group_rag');
  if (capabilities.music) tools.push('music');
  if (capabilities.linkMedia) tools.push('link_media');
  if (capabilities.imageGeneration) tools.push('image_gen');
  if (capabilities.videoGeneration) tools.push('video_gen');
  if (capabilities.translation) tools.push('translate');
  if (capabilities.documentCreation ?? capabilities.translation) tools.push('document_create');
  if (capabilities.dataAnalysis) tools.push('data_analysis');
  if (capabilities.workflows) tools.push('workflow');
  if (capabilities.tts) tools.push('tts');
  if (capabilities.capabilityForge) tools.push('capability_forge');
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
    ...(tool('video_gen')?.query ? { videoPrompt: tool('video_gen')?.query } : {}),
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
  return legacyProviderFor(tool) as TurnEvaluation['providerRequests'][number];
}

function actionFromDecision(
  decision: SourcedCortexDecision,
  botIsAddressed: boolean,
): TurnEvaluation['action'] {
  const has = (intent: CortexDecision['intents'][number]): boolean =>
    decision.intents.includes(intent);
  const tool = (name: CortexTool): boolean => decision.toolCalls.some((call) => call.tool === name);
  if (has('make_video') || tool('video_gen')) return 'generate_video';
  if (has('archive_anime') || tool('anime_archive')) return 'archive_anime';
  if (has('download_media') || tool('link_media')) return 'download_media';
  if (has('play_music') || tool('music')) return 'download_music';
  if (has('draw_image')) return 'draw_image';
  if (has('make_image') || tool('image_gen')) return 'generate_image';
  if (has('translate') || tool('translate')) return 'translate_text';
  if (has('voice_note') || tool('tts')) return 'make_voice';
  if (has('extend_capability') || tool('capability_forge')) return 'acquire_capability';
  if (has('news_context') && tool('news') && !has('answer')) return 'post_news';
  if (has('correct_claim')) return 'challenge_claim';
  if (has('web_lookup') || tool('web_search') || tool('page_scan'))
    return has('news_context') ? 'bring_news_context' : 'ground_search';
  if (has('summarize')) return 'summarize_thread';
  if (has('recall_group')) return 'use_group_lore';
  if (has('acknowledge')) return 'acknowledge';
  if (has('react_short')) return 'react_short';
  if (has('disagree')) return 'disagree_briefly';
  if (has('banter') && !has('answer')) return 'banter_only';
  if (has('stay_quiet') && !botIsAddressed) return 'stay_quiet';
  return 'answer';
}
