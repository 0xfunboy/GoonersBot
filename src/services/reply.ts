import type { AppConfig } from '../config/index.js';
import type { Localizer } from '../config/i18n.js';
import type {
  ChatContext,
  IncomingMessage,
  Person,
  TranscribedMessage,
  VideoSendMeta,
} from '../domain/types.js';
import type { LLMProvider } from '../providers/llm/types.js';
import type { MediaProcessor } from '../providers/media/index.js';
import type { MusicResult, MusicService } from '../providers/media/music.js';
import { AgnesVideoGenerator, VideoRateLimitError } from '../providers/video/agnes.js';
import { prepareVideoForTelegram } from '../providers/video/prepare.js';
import type { TtsProvider } from '../providers/voice/tts.js';
import type { ImageProfile } from '../providers/image/stableDiffusion.js';
import type { ConversationService } from './conversation.js';
import { BOT_LABEL } from './conversation.js';
import type { MemoryRetrievalInput } from '../memory/memoryRetriever.js';
import type { SceneAnalyzer } from '../brain/sceneAnalyzer.js';
import type { GroundingService } from '../search/groundingService.js';
import type { HeatService } from './heat.js';
import type { KnowledgeRetriever } from '../knowledge/knowledgeRetriever.js';
import type { AnimeKnowledgeService } from '../anime/knowledgeService.js';
import type { AmbientRecallResult, AmbientRetriever } from '../ambient/retriever.js';
import type { ImageFinder } from '../media/imageFinder.js';
import type { NewsService } from '../news/newsService.js';
import type { AutonomousPoster } from './autonomousPoster.js';
import type { ImagePromptService, PreparedImagePrompt } from './imagePrompt.js';
import type { VideoPromptService } from './videoPrompt.js';
import type { GroupQuotaService } from './groupQuota.js';
import type { ConversationThreadTracker, ConversationThreadState } from './threadTracker.js';
import type { DocumentProcessor } from '../documents/documentProcessor.js';
import type { CapabilityForge } from '../capabilities/forge.js';
import { isNewCapabilityInstallation, isVerifiedCapabilityReuse } from '../capabilities/types.js';
import type { AgentRuntime } from './agentRuntime.js';
import {
  renderSocialContext,
  type SocialContext,
  type SocialProfileEngine,
} from '../social/index.js';
import { parseMusicRequest } from './musicIntent.js';
import type { RetrievedMemory } from '../memory/types.js';
import { jaccard } from '../memory/memoryDeduper.js';
import { StyleEngine } from '../brain/styleEngine.js';
import { ReplyPlanner } from '../brain/replyPlanner.js';
import { ResponseGenerator } from '../brain/responseGenerator.js';
import { rankCandidatesSafely, ResponseRanker } from '../brain/responseRanker.js';
import { RepetitionGuard } from '../brain/repetitionGuard.js';
import { decideReplyAcceptance, type AssessedReplyCandidate } from '../brain/replyAcceptance.js';
import { TurnEvaluator } from '../brain/turnEvaluator.js';
import { violatesSocialFloor } from '../brain/socialAwareness.js';
import { availableToolsFor, Cortex, cortexToTurnEvaluation } from '../brain/cortex/evaluator.js';
import { fallbackCortex } from '../brain/cortex/fallback.js';
import type { CortexTool, SourcedCortexDecision } from '../brain/cortex/schema.js';
import { isRefusal } from './modelRouter.js';
import type {
  BotReplyRecord,
  ProviderBundle,
  RankedReply,
  RepetitionCheck,
  ReplyPlan,
  SceneAnalysis,
  TurnEvaluation,
} from '../brain/types.js';
import { childLogger } from '../utils/logger.js';
import { containsMinorMediaReference, MediaSafetyError } from '../safety/mediaSafety.js';

const log = childLogger('reply');

/** Strip the bot @mention and collapse whitespace to make a clean web-search query. */
function cleanQuery(text: string, botUsername: string): string {
  const tag = botUsername.replace(/^@/, '');
  return text
    .replace(new RegExp(`@${tag}`, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const ANIME_TOPIC_RE =
  /\b(waifu|anime|manga|otaku|weeb|hentai|cosplay|asian girl|ragazza anime|kawaii|senpai|ahegao)\b/i;

/**
 * True when the conversation is about anime/waifu.
 *
 * Ambient recall is the strongest of the three signals: a resolved catalog subject means the bot
 * genuinely identified a series, where the regex only means the word "anime" appeared somewhere.
 */
function isAnimeTopic(
  message: string,
  knowledge: { topic: string }[],
  ambient?: AmbientRecallResult,
): boolean {
  if (ambient?.facts.some((fact) => fact.domain === 'anime')) return true;
  if (ANIME_TOPIC_RE.test(message)) return true;
  return knowledge.some((k) => /waifu|anime|manga|otaku/i.test(k.topic));
}

/**
 * Image subject for an *unprompted* ambient image.
 *
 * Without this the ambient path searched for a generic waifu while the group was visibly talking
 * about one specific series - the bot had the answer in hand and posted something unrelated.
 * The explicit-request path is untouched: an image the user actually asked for still comes from
 * their own words.
 */
function ambientImageSubject(ambient: AmbientRecallResult | undefined): string | undefined {
  const subject = ambient?.facts.find((fact) => fact.domain === 'anime')?.subject?.trim();
  if (!subject || subject.length < 2) return undefined;
  return ANIME_TOPIC_RE.test(subject) ? subject : `${subject} anime`;
}

// Strong NSFW/visual cue words: in this bot's context they almost always mean "show me art of X".
const NSFW_WANT_RE = /\b(nud[aoei]|nude|naked|hentai|ecchi|lewd|topless|in lingerie)\b/i;
// The user is asking the bot to send/find/show an image (broad: verbs, possession, or NSFW cues).
const IMAGE_WANT_RE = new RegExp(
  '(' +
    '\\b(mandami|manda|inviami|invia|trovami|trova|cerca(mi)?|dammi|fammi vedere|fammi|postami|posta|voglio(\\s+vedere)?|mostrami|fai vedere|send( me)?|show( me)?|find( me)?|gimme|drop)\\b[^.?!]*\\b(immagin\\w*|foto|fote|pic|picture|image|img|wallpaper|meme|waifu|gotic\\w*|nud\\w*)\\b' +
    ')|(' +
    "\\b(ce l'?hai|ce le hai|ce ne hai|ne hai|hai|got (any|a))\\b[^.?!]*\\b(foto|img|immagin\\w*|pic|picture|nud\\w*|waifu)\\b" +
    ')|(' +
    NSFW_WANT_RE.source +
    ')',
  'i',
);
// The bot's own reply announced/promised/has an image (must be honored with a real image).
const IMAGE_PROMISE_RE =
  /\b(ti (mando|invio|giro|passo|mostro|creo|cerco|genero|preparo)|te (la|le|ne) (mando|giro|passo)|eccoti|ecco (qui|qua|una|un'|la|il)|guarda (questa|qui|qua)|mando (qualche|un'?|una|dei|delle)|ho (qualche|delle|un'?|una)|here('?s| is| you go)|i'?ll (send|show|find|make)|sending you|check this)\b[^.]*\b(immagin\w*|foto|fote|pic|picture|image|img|wallpaper|meme|link|waifu)\b/i;

const IMG_STOP_RE =
  /\b(ce l'?hai|ce le hai|ce ne hai|ne hai|hai|mandami|manda|inviami|invia|trovami|trova|cerca(?:mi)?|dammi|mostrami|fammi vedere|fammi|voglio|vedere|postami|posta|fai vedere|send|show|find|me|gimme|drop|per piacere|per favore|grazie|please|thanks|dai|su|qualche|una|delle|dei|un'|un|il|lo|la|le|gli|of|the)\b/gi;

/**
 * Extract the subject the user wants an image of (e.g. "gotica culona", "rei ayanami nuda") and bias
 * it to the bot's anime/waifu taste. Tries "image of X", then "verb ... X", then a cleanup fallback
 * that strips request/question filler. Returns undefined when nothing usable remains.
 */
function imageQueryFromMessage(message: string): string | undefined {
  let subject =
    message.match(
      /\b(?:immagin\w*|foto|fote|pic|picture|image|img|wallpaper|meme)\s+(?:di|del|della|dei|delle|d'|of|su)\s+([^.?!\n]{2,60})/i,
    )?.[1] ??
    message.match(
      /\b(?:mandami|manda|inviami|trovami|trova|cerca(?:mi)?|dammi|mostrami|fammi vedere|send me|show me|find me|gimme|drop)\s+(?:una?\s+|un'|qualche\s+|dei\s+|delle\s+)?(?:immagin\w*|foto|fote|pic|picture|image|img|wallpaper|meme)?\s*(?:di|of|su)?\s*([^.?!\n]{2,60})/i,
    )?.[1];
  // Fallback: strip the request/question filler and keep whatever is left (the actual subject).
  if (!subject) {
    const cleaned = message
      .replace(/@\w+/g, ' ')
      .replace(IMG_STOP_RE, ' ')
      .replace(/[?!.,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.split(' ').length <= 6) subject = cleaned;
  }
  subject = (subject ?? '').replace(/\s+/g, ' ').trim();
  if (subject.length < 2) return undefined;
  return ANIME_TOPIC_RE.test(subject) || NSFW_WANT_RE.test(subject) ? subject : `${subject} anime`;
}

/** Format retrieved knowledge into a compact, clearly-optional context block (or '' if none). */
function formatKnowledge(items: { topic: string; text: string }[]): string {
  if (items.length === 0) return '';
  return [
    'RELEVANT KNOWLEDGE (background you happen to know - use ONLY if it fits naturally, never force ' +
      'the topic, never info-dump, never list it):',
    ...items.map((k) => `- ${k.topic}: ${k.text}`),
  ].join('\n');
}

function formatGroupContext(items: RetrievedMemory[]): string | undefined {
  if (items.length === 0) return undefined;
  return [
    'GROUP RAG (who these people are / group lore; use as social context, not as the default insult):',
    ...items.map((m) => {
      const subject = m.item.subjectHandle ?? 'group';
      return `- ${subject}: ${m.item.text} (${m.reason}, rel ${m.relevance.toFixed(2)})`;
    }),
  ].join('\n');
}

/**
 * Only cool down memories that visibly influenced the final answer. The old implementation marked
 * every retrieved item as "used", even when the model ignored it, which both corrupted analytics
 * and kept the same handful of high-salience stereotypes circulating forever.
 */
function actuallyUsedMemoryIds(
  text: string,
  retrieved: RetrievedMemory[],
  plan: ReplyPlan,
): string[] {
  if (plan.memoryUseMode === 'none' || !text.trim()) return [];
  const normalized = text.toLowerCase();
  return retrieved
    .filter((memory) => {
      const handle = memory.item.subjectHandle?.toLowerCase().replace(/^@/, '');
      const namesSubject =
        Boolean(handle && handle.length >= 3) &&
        (normalized.includes(`@${handle}`) || normalized.includes(handle as string));
      const overlap = jaccard(text, memory.item.text);
      return namesSubject || overlap >= (memory.allowedToUseExplicitly ? 0.16 : 0.24);
    })
    .map((memory) => memory.item._id)
    .filter((id): id is string => Boolean(id));
}

function formatNewsContext(
  items: Array<{ title: string; source: string; summary: string; matchedTopics: string[] }>,
): string | undefined {
  if (items.length === 0) return undefined;
  return [
    'CURRENT NEWS CONTEXT (fresh RSS items that may match the live topic; use only if relevant, do not infodump):',
    ...items.map((n) => {
      const topics = n.matchedTopics.length ? ` topics=${n.matchedTopics.join(',')}` : '';
      return `- ${n.title} [${n.source}${topics}]: ${n.summary}`;
    }),
  ].join('\n');
}

function formatClaimCheck(evaluation: TurnEvaluation, sources: string[]): string | undefined {
  if (evaluation.action !== 'challenge_claim') return undefined;
  const sourceLine = sources.length
    ? `Fresh/context sources available: ${sources.slice(0, 5).join(', ')}`
    : 'No fresh source confirmed this turn; be blunt about uncertainty and avoid fake precision.';
  return [
    'CLAIM CHECK MODE:',
    'The reply should correct or pressure-test the claim before making fun of anyone.',
    sourceLine,
  ].join('\n');
}

const BAD_MUSIC_QUERY_RE =
  /\b(una canzone|qualche canzone|canzone da youtube|comando\s*\/|\/suona|\/play|il tuo comando)\b/i;

function usableMusicQuery(query: string | undefined, message: string, botUsername: string): string {
  const q = (query || parseMusicRequest(message, botUsername) || '').trim();
  if (!q || BAD_MUSIC_QUERY_RE.test(q)) return '';
  return q;
}

function firstUrl(text: string | undefined): string | undefined {
  return text?.match(/https?:\/\/[^\s<>"']+/i)?.[0];
}

function imageProfileFromTool(value: string | undefined): ImageProfile | undefined {
  if (value === 'manga' || value === 'anime' || value === 'realistic' || value === 'nsfw') {
    return value;
  }
  return undefined;
}

function imageAspectRatioFromTool(value: string | undefined): '16:9' | '9:16' | '1:1' | undefined {
  const normalized = value?.replace(/\s+/g, '');
  return normalized === '16:9' || normalized === '9:16' || normalized === '1:1'
    ? normalized
    : undefined;
}

function hardFloorFallback(plan: ReplyPlan, language: string, topic: string): string {
  const italian = /^it(?:alian)?$/i.test(language);
  if (plan.socialSignal?.situation === 'gratitude') {
    return italian
      ? 'Ricevuto. Quando serve davvero, ci sono.'
      : "Got it. When you actually need me, I'm here.";
  }
  if (plan.socialSignal?.supportNeed === 'high' || plan.socialSignal?.supportNeed === 'urgent') {
    return italian
      ? 'Ci sono. Dimmi la cosa più urgente e la affrontiamo un passo alla volta.'
      : "I'm here. Tell me the most urgent thing and we'll take it one step at a time.";
  }
  const subject = topic.trim().slice(0, 90);
  if (plan.mustBringValue) {
    return italian
      ? `Su ${subject || 'questo'} non ho ancora elementi abbastanza solidi per risponderti senza inventare. Dammi il riferimento che manca e lo chiudo sul merito.`
      : `I do not yet have solid enough evidence about ${subject || 'this'} to answer without making things up. Give me the missing reference and I will resolve it directly.`;
  }
  return italian
    ? 'Qui mi manca il contesto per dire qualcosa di sensato. Dammi il bersaglio preciso e ci vado dritto.'
    : 'I am missing the context needed to say something useful here. Give me the exact target and I will address it directly.';
}

function usedRunningJoke(
  text: string,
  jokes: SocialContext['runningJokes'],
): { id: string; variant: string | null } | null {
  let best: { id: string; variant: string | null; score: number } | null = null;
  for (const joke of jokes) {
    const candidates = [
      { text: joke.label, variant: null },
      ...joke.variants.map((variant) => ({ text: variant, variant })),
    ];
    for (const candidate of candidates) {
      const score = jaccard(text, candidate.text);
      if (score >= 0.16 && (!best || score > best.score)) {
        best = { id: joke.id, variant: candidate.variant, score };
      }
    }
  }
  return best ? { id: best.id, variant: best.variant } : null;
}

/** A resolved still image to react to: a photo or a frame from a video, current or replied-to. */
interface Visual {
  buffer: Buffer;
  mime: string;
  kind: 'photo' | 'video';
  /** true when it came from the replied-to message (so its poster is the replied-to user) */
  fromReply: boolean;
}

export interface ReplyContext {
  person: Person;
  context: ChatContext;
  message: IncomingMessage;
  botUsername: string;
  language: string;
  modeName: string;
  modeDescription: string;
  nsfwEnabled: boolean;
  /** Free groups do not invoke a separate vision model; their economy model handles text only. */
  allowVision: boolean;
  /** model from the NSFW router for this turn */
  model?: string | undefined;
  /** Economy model enforced for Free groups; paid plans use the configured fast brain models. */
  internalModel?: string | undefined;
  /** when the default model refuses, retry with the uncensored model */
  allowRefusalFallback?: boolean | undefined;
  nsfwModel?: string | undefined;
  recentBotReplies: BotReplyRecord[];
  /** Operator/private-admin turn: do not spend or block on secondary group quotas. */
  quotaBypass?: boolean | undefined;
  /** Passive autoengage turn: the LLM gate already approved participation. */
  passive?: boolean | undefined;
  /** Per-chat link-media toggle resolved by the Telegram handler for this turn. */
  allowLinkMedia?: boolean | undefined;
  /** Only a bot operator may persist a new global capability. */
  allowCapabilityInstall?: boolean | undefined;
}

export interface ReplyOutcome {
  text: string;
  suppressed?: boolean;
  music?: MusicResult;
  linkMediaUrl?: string;
  audioBuffer?: Buffer;
  imageUrl?: string;
  imageBuffer?: Buffer;
  imageSpoiler?: boolean;
  videoBuffer?: Buffer;
  videoSpoiler?: boolean;
  videoMeta?: VideoSendMeta;
  transcribedUserMessage: TranscribedMessage;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
  model: string | null;
  visionCalls: number;
  transcriptionCalls: number;
  imageCalls: number;
  // brain trace (for persistence + debug + feedback)
  scene: SceneAnalysis;
  plan: ReplyPlan;
  styleVariant: string;
  retrieved: RetrievedMemory[];
  usedMemoryIds: string[];
  candidates: string[];
  ranked: RankedReply[];
  repetitionChecks: RepetitionCheck[];
  evaluation: TurnEvaluation;
  cortex?: SourcedCortexDecision;
  providerBundle: ProviderBundle;
  threadState?: ConversationThreadState;
}

/**
 * ReplyService: the brain pipeline.
 *   transcribe → scene → retrieve memory → plan → style → generate candidates → rank →
 *   repetition guard (regenerate) → final reply (+ optional image).
 * Memory is never dumped; it flows through the retriever and is used implicitly.
 */
export class ReplyService {
  private readonly styleEngine = new StyleEngine();
  private readonly planner = new ReplyPlanner();
  private readonly evaluator: TurnEvaluator;
  private readonly cortex: Cortex;
  private readonly generator: ResponseGenerator;
  private readonly ranker = new ResponseRanker();
  private readonly guard: RepetitionGuard;

  constructor(
    private readonly llm: LLMProvider,
    private readonly media: MediaProcessor,
    private readonly music: MusicService,
    private readonly video: AgnesVideoGenerator,
    private readonly tts: TtsProvider,
    private readonly conversation: ConversationService,
    private readonly sceneAnalyzer: SceneAnalyzer,
    private readonly memoryRetriever: {
      retrieve(input: MemoryRetrievalInput): Promise<RetrievedMemory[]>;
    },
    private readonly config: AppConfig,
    private readonly grounding: GroundingService,
    private readonly heat: HeatService,
    private readonly knowledge: KnowledgeRetriever,
    private readonly imageFinder: ImageFinder,
    private readonly news: NewsService,
    private readonly autonomousPoster: AutonomousPoster,
    private readonly imagePrompts: ImagePromptService,
    private readonly quota: GroupQuotaService,
    private readonly localizer: Localizer,
    private readonly threadTracker: ConversationThreadTracker,
    private readonly documents: DocumentProcessor,
    private readonly capabilities: CapabilityForge,
    private readonly videoPrompts: VideoPromptService,
    private readonly agentRuntime: AgentRuntime,
    private readonly social: SocialProfileEngine,
    private readonly anime: AnimeKnowledgeService,
    private readonly ambient: AmbientRetriever,
  ) {
    this.evaluator = new TurnEvaluator(llm, {
      enabled: config.brain.evaluatorEnabled,
      model: config.brain.evaluatorModel,
      temperature: config.brain.evaluatorTemperature,
    });
    this.cortex = new Cortex(llm, {
      enabled: config.brain.cortex.enabled,
      model: config.brain.cortex.model,
      temperature: config.brain.cortex.temperature,
      maxTokens: config.brain.cortex.maxTokens,
    });
    this.generator = new ResponseGenerator(llm, this.styleEngine, {
      model: config.brain.replyModel,
      temperature: config.brain.replyTemperature,
      topP: config.brain.replyTopP,
      frequencyPenalty: config.brain.replyFrequencyPenalty,
      presencePenalty: config.brain.replyPresencePenalty,
      candidateCount: config.brain.replyCandidateCount,
      maxReplyChars: config.brain.maxReplyChars,
    });
    this.guard = new RepetitionGuard(config.env.REPETITION_SIMILARITY_THRESHOLD);
  }

  /**
   * Resolve a single still image to "look at" for this turn: a photo or a frame extracted from a
   * video, taking the current message first, then the replied-to message. Videos are turned into a
   * representative frame via ffmpeg. Returns null when there is nothing visual.
   */
  private async resolveVisual(message: IncomingMessage): Promise<Visual | null> {
    if (message.imageBuffer) {
      return {
        buffer: message.imageBuffer,
        mime: message.imageMime ?? 'image/jpeg',
        kind: 'photo',
        fromReply: false,
      };
    }
    if (message.videoBuffer) {
      const frame = await this.media.frameFromVideo(message.videoBuffer);
      if (frame) return { buffer: frame, mime: 'image/jpeg', kind: 'video', fromReply: false };
    }
    if (message.repliedImageBuffer) {
      return {
        buffer: message.repliedImageBuffer,
        mime: message.repliedImageMime ?? 'image/jpeg',
        kind: 'photo',
        fromReply: true,
      };
    }
    if (message.repliedVideoBuffer) {
      const frame = await this.media.frameFromVideo(message.repliedVideoBuffer);
      if (frame) return { buffer: frame, mime: 'image/jpeg', kind: 'video', fromReply: true };
    }
    return null;
  }

  async transcribe(
    message: IncomingMessage,
    visual: { buffer: Buffer; mime: string } | null,
    allowVision: boolean,
  ): Promise<{
    transcribed: TranscribedMessage;
    visionCalls: number;
    transcriptionCalls: number;
  }> {
    let imageDescription: string | null = null;
    let voiceDescription: string | null = null;
    let visionCalls = 0;
    let transcriptionCalls = 0;
    if (visual && allowVision) {
      imageDescription = await this.media.describeImage(visual.buffer, visual.mime);
      if (imageDescription !== null) visionCalls = 1;
    }
    // Audio/video transcription (current + replied) is done up-front in the message handler and
    // injected into the message text; here we only cover any leftover current audio as a safety net.
    if (message.audioBuffer) {
      voiceDescription = await this.media.transcribeVoice(
        message.audioBuffer,
        message.audioMime ?? 'audio/ogg',
        { fileName: 'media' },
      );
      if (voiceDescription !== null) transcriptionCalls = 1;
    }
    return {
      transcribed: {
        messageText: message.messageText || null,
        timestamp: message.timestamp,
        imageDescription,
        voiceDescription,
      },
      visionCalls,
      transcriptionCalls,
    };
  }

  /**
   * Decide whether this turn needs grounding and fetch it. Image lookup (reverse-image "who/what
   * is this") wins when the message asks an identity/product question and a visual is present
   * (photo or video frame, current or replied); otherwise a web search for recency/factual
   * questions. Returns null when grounding is disabled or not warranted.
   */
  private async ground(
    ctx: ReplyContext,
    visual: { buffer: Buffer; mime: string } | null,
    force: 'web' | 'image' | null = null,
    queryOverride?: string | undefined,
  ): Promise<{ block: string; query: string; sources: string[] } | null> {
    if (!this.grounding.enabled) return null;
    const question = ctx.message.messageText || '';
    try {
      if (visual && (force === 'image' || this.grounding.wantsImageLookup(question))) {
        return await this.grounding.groundImage(
          {
            imageBuffer: visual.buffer,
            imageMime: visual.mime,
            question,
            language: ctx.language,
          },
          ctx.quotaBypass ? undefined : ctx.context.chatId,
        );
      }
      if (force === 'web' || this.grounding.wantsWebSearch(question)) {
        const query = queryOverride?.trim() || cleanQuery(question, ctx.botUsername);
        return await this.grounding.groundWeb(
          query,
          ctx.language,
          ctx.quotaBypass ? undefined : ctx.context.chatId,
        );
      }
    } catch (err) {
      log.warn({ err }, 'grounding failed');
    }
    return null;
  }

  private async newsContext(
    ctx: ReplyContext,
    history: { message: { messageText: string | null } }[],
    retrieved: RetrievedMemory[],
    scene: SceneAnalysis,
  ): Promise<{ block?: string; sources: string[] }> {
    if (!this.news.enabled) return { sources: [] };
    if (!ctx.quotaBypass && !(await this.quota.reserve(ctx.context.chatId, 'news')).allowed) {
      return { sources: [] };
    }
    try {
      const dynamicTerms = [
        scene.currentTopic,
        ctx.message.messageText,
        ...history.slice(-8).map((h) => h.message.messageText ?? ''),
      ]
        .join(' ')
        .split(/[^a-zA-Z0-9À-ÿ+#.]+/)
        .filter((t) => t.length >= 4)
        .slice(0, 24);
      const lore = retrieved.map((m) => m.item.text).slice(0, 6);
      const ranked = await this.news.ranked(
        {
          chatName: ctx.context.chatName,
          dynamicTerms,
          lore,
        },
        8,
      );
      const picked = ranked.filter((n) => n.score > 0).slice(0, 3);
      return {
        block: formatNewsContext(picked),
        sources: picked.map((n) => n.link).filter(Boolean),
      };
    } catch (err) {
      log.warn({ err }, 'news context failed');
      return { sources: [] };
    }
  }

  async generateReply(ctx: ReplyContext): Promise<ReplyOutcome> {
    // Resolve the visual once (photo or extracted video frame, current or replied) and reuse it
    // for both the image description and any reverse-image grounding.
    const visual = await this.resolveVisual(ctx.message);
    const { transcribed, visionCalls, transcriptionCalls } = await this.transcribe(
      ctx.message,
      visual,
      ctx.allowVision,
    );
    const extractedDocuments = await this.documents.extractAll(ctx.message.attachments ?? []);
    const documentContext =
      this.documents.formatForPrompt(extractedDocuments) ??
      ((ctx.message.attachments?.length ?? 0) > 0
        ? [
            'ATTACHED DOCUMENTS DETECTED, but no configured extractor supports their format:',
            ...(ctx.message.attachments ?? []).map(
              (file) =>
                `- name=${JSON.stringify(file.fileName)} source=${file.source} type=${file.mime} bytes=${file.size}`,
            ),
            'Do not say there is no attachment. State that this specific format could not be read.',
          ].join('\n')
        : null);
    if (documentContext) transcribed.attachmentDescription = documentContext;
    log.info(
      {
        chatId: ctx.context.chatId,
        visual: visual ? `${visual.kind}${visual.fromReply ? '/replied' : ''}` : 'none',
        described: Boolean(transcribed.imageDescription),
      },
      'visual resolved',
    );
    const history = await this.conversation.getRecent(ctx.context.chatId);
    const mentioned = ctx.context.mentionedHandles ?? [];
    const threadState = await this.threadTracker.track({
      person: ctx.person,
      context: ctx.context,
      message: ctx.message,
      history,
    });
    const socialSnapshot = await this.social.getContext(ctx.context.chatId, {
      focusHandles: [
        ctx.person.userHandle,
        ...mentioned,
        ...(ctx.context.repliedToUserHandle ? [ctx.context.repliedToUserHandle] : []),
      ],
      maxMembers: 14,
      maxFacetsPerFocusedMember: 8,
      maxFacetsPerOtherMember: 3,
      maxRelationships: 12,
      maxJokes: 3,
      maxNorms: 6,
    });
    const socialContext = renderSocialContext(socialSnapshot);
    const cognitiveContext = [threadState.promptBlock, socialContext].filter(Boolean).join('\n\n');

    // 1. scene
    const attachmentSummary = extractedDocuments.length
      ? extractedDocuments
          .map(
            (doc) =>
              `${doc.source === 'reply' ? 'replied' : 'attached'} file ${JSON.stringify(doc.fileName)} (${doc.mime}, ${doc.originalChars} extracted chars)`,
          )
          .join('; ')
      : '';
    const semanticMessage = [ctx.message.messageText, attachmentSummary && `[${attachmentSummary}]`]
      .filter(Boolean)
      .join('\n');
    const sceneInput = {
      history,
      currentMessage: semanticMessage,
      currentHandle: ctx.person.userHandle,
      mentionedHandles: mentioned,
      botIsAddressed: ctx.context.isBotMentioned || ctx.context.isReplyToBot,
      botLabel: BOT_LABEL,
      ...(threadState.promptBlock ? { threadContext: threadState.promptBlock } : {}),
      model: ctx.internalModel,
    };
    // Autoengage already spent one focused model call deciding that a passive intervention is
    // worthwhile. Repeating scene + cortex inference serially adds latency without changing that
    // decision, so passive turns use their deterministic counterparts and retain the full
    // memory/style/generation pipeline below.
    const passiveFastPath = Boolean(ctx.passive);
    const scene = passiveFastPath
      ? this.sceneAnalyzer.heuristic(sceneInput)
      : await this.sceneAnalyzer.analyze(sceneInput);
    const sceneForcesNsfw = Boolean(
      scene.userIntent === 'dangerous_request' && ctx.allowRefusalFallback && ctx.nsfwModel,
    );
    const generationModel = sceneForcesNsfw ? ctx.nsfwModel : ctx.model;
    const generationNsfwEnabled = ctx.nsfwEnabled || sceneForcesNsfw;
    const addressed =
      !ctx.context.isGroup || ctx.context.isBotMentioned || ctx.context.isReplyToBot;
    const recentNegativeFeedback = ctx.recentBotReplies.some((r) => (r.feedbackScore ?? 0) < 0);
    const capabilities = {
      webSearch: this.grounding.enabled,
      imageLookup: this.grounding.enabled && ctx.allowVision && Boolean(visual),
      news: this.news.enabled,
      knowledge: this.knowledge.enabled,
      anime: this.anime.enabled,
      music: this.music.enabled,
      linkMedia: this.config.linkMedia.enabled && ctx.allowLinkMedia !== false,
      imageGeneration: this.media.canGenerateImage,
      videoGeneration: this.video.enabled,
      translation: this.llm.capabilities.chat,
      tts: this.tts.enabled,
      capabilityForge: this.capabilities.enabled,
    };
    let cortexDecision: SourcedCortexDecision | undefined;
    const evaluation = passiveFastPath
      ? (() => {
          cortexDecision = fallbackCortex({
            currentMessage: semanticMessage,
            // The autoengage gate is the addressing signal for this internal deterministic pass.
            botIsAddressed: true,
            availableTools: availableToolsFor(capabilities),
          });
          cortexDecision = {
            ...cortexDecision,
            reason: 'passive autoengage gate approved; skipped redundant scene/cortex inference',
          };
          return cortexToTurnEvaluation(cortexDecision, false);
        })()
      : this.config.brain.cortex.enabled
        ? await (async () => {
            cortexDecision = await this.cortex.evaluate({
              scene,
              history,
              currentMessage: semanticMessage,
              botIsAddressed: addressed,
              recentNegativeFeedback,
              capabilities,
              ...(cognitiveContext ? { threadContext: cognitiveContext } : {}),
              model: ctx.internalModel,
            });
            return cortexToTurnEvaluation(cortexDecision, addressed);
          })()
        : await this.evaluator.evaluate({
            scene,
            history,
            currentMessage: ctx.message.messageText,
            botIsAddressed: addressed,
            recentBotReplies: ctx.recentBotReplies,
            recentNegativeFeedback,
            capabilities,
            groundingHints: {
              wantsWebSearch: this.grounding.wantsWebSearch(ctx.message.messageText || ''),
              wantsImageLookup: Boolean(
                visual &&
                ctx.allowVision &&
                this.grounding.wantsImageLookup(ctx.message.messageText || ''),
              ),
            },
            model: ctx.internalModel,
          });
    const callFor = (tool: CortexTool) =>
      cortexDecision?.toolCalls.find((call) => call.tool === tool);
    const t = (key: string, vars: Record<string, string | number> = {}): string =>
      this.localizer.tPlain(key, vars, ctx.language) ?? key;
    const wants = (tool: CortexTool, legacy: TurnEvaluation['providerRequests'][number]) =>
      cortexDecision ? Boolean(callFor(tool)) : evaluation.providerRequests.includes(legacy);
    const makeImmediatePlan = (retrievedMemories: RetrievedMemory[] = []): ReplyPlan => {
      const bannedOpenings = [
        ...this.styleEngine.bannedOpenings(ctx.recentBotReplies),
        ...this.styleEngine.recurringTics(ctx.recentBotReplies),
      ];
      return this.planner.plan({
        scene,
        evaluation,
        retrievedMemories,
        bannedOpenings,
        currentHandle: ctx.person.userHandle,
        maxLines: this.config.env.MAX_REPLY_LINES,
        maxChars: this.config.env.MAX_REPLY_CHARS,
      });
    };
    const immediateOutcome = (params: {
      text?: string;
      styleVariant: string;
      providerBundle?: ProviderBundle;
      imageBuffer?: Buffer;
      imageSpoiler?: boolean;
      videoBuffer?: Buffer;
      videoSpoiler?: boolean;
      videoMeta?: VideoSendMeta;
      linkMediaUrl?: string;
      audioBuffer?: Buffer;
      music?: MusicResult;
      imageCalls?: number;
      visionCalls?: number;
      usage?: { inputTokens: number; outputTokens: number; estimated: boolean };
      model?: string | null;
      plan?: ReplyPlan;
    }): ReplyOutcome => {
      const out: ReplyOutcome = {
        text: params.text ?? '',
        transcribedUserMessage: transcribed,
        usage: params.usage ?? { inputTokens: 0, outputTokens: 0, estimated: true },
        model: params.model ?? null,
        visionCalls: params.visionCalls ?? visionCalls,
        transcriptionCalls,
        imageCalls: params.imageCalls ?? 0,
        scene,
        plan: params.plan ?? makeImmediatePlan(),
        styleVariant: params.styleVariant,
        retrieved: [],
        usedMemoryIds: [],
        candidates: [],
        ranked: [],
        repetitionChecks: [],
        evaluation,
        ...(cortexDecision ? { cortex: cortexDecision } : {}),
        providerBundle: {
          ...(threadState.promptBlock ? { threadContext: threadState.promptBlock } : {}),
          ...(params.providerBundle ?? { sources: [] }),
        },
        threadState,
      };
      if (params.imageBuffer) out.imageBuffer = params.imageBuffer;
      if (params.imageSpoiler) out.imageSpoiler = true;
      if (params.videoBuffer) out.videoBuffer = params.videoBuffer;
      if (params.videoSpoiler) out.videoSpoiler = true;
      if (params.videoMeta) out.videoMeta = params.videoMeta;
      if (params.linkMediaUrl) out.linkMediaUrl = params.linkMediaUrl;
      if (params.audioBuffer) out.audioBuffer = params.audioBuffer;
      if (params.music) out.music = params.music;
      return out;
    };
    if (!evaluation.shouldAct) {
      const bannedOpenings = [
        ...this.styleEngine.bannedOpenings(ctx.recentBotReplies),
        ...this.styleEngine.recurringTics(ctx.recentBotReplies),
      ];
      const plan = this.planner.plan({
        scene,
        evaluation,
        retrievedMemories: [],
        bannedOpenings,
        currentHandle: ctx.person.userHandle,
        maxLines: this.config.env.MAX_REPLY_LINES,
        maxChars: this.config.env.MAX_REPLY_CHARS,
      });
      return {
        text: '',
        suppressed: true,
        transcribedUserMessage: transcribed,
        usage: { inputTokens: 0, outputTokens: 0, estimated: true },
        model: null,
        visionCalls,
        transcriptionCalls,
        imageCalls: 0,
        scene,
        plan,
        styleVariant: 'suppressed',
        retrieved: [],
        usedMemoryIds: [],
        candidates: [],
        ranked: [],
        repetitionChecks: [],
        evaluation,
        ...(cortexDecision ? { cortex: cortexDecision } : {}),
        providerBundle: {
          ...(threadState.promptBlock ? { threadContext: threadState.promptBlock } : {}),
          sources: [],
        },
        threadState,
      };
    }

    const terminalAgentTools = new Set<CortexTool>([
      'web_search',
      'anime_knowledge',
      'image_lookup',
      'music',
      'link_media',
      'image_gen',
      'video_gen',
      'translate',
      'tts',
      'capability_forge',
    ]);
    const shouldUseAgentRuntime =
      Boolean(documentContext) ||
      Boolean(cortexDecision?.toolCalls.some((call) => terminalAgentTools.has(call.tool)));
    if (shouldUseAgentRuntime && semanticMessage.trim()) {
      try {
        const agentPlan = makeImmediatePlan();
        const requestedActions = [
          ...(documentContext
            ? [
                {
                  tool: 'document_read' as const,
                  query: semanticMessage,
                  reason: 'read and answer from the attached or replied document',
                },
              ]
            : []),
          ...(cortexDecision?.toolCalls ?? []).map((call) => ({
            tool: call.tool,
            ...(call.query ? { query: call.query } : {}),
            ...(call.args ? { args: call.args } : {}),
            reason: call.reason,
          })),
        ];
        const coordinated = await this.agentRuntime.run({
          request: semanticMessage,
          language: ctx.language,
          person: ctx.person,
          context: ctx.context,
          ...(generationModel ? { model: generationModel } : {}),
          recentMessages: history
            .filter((message) => Boolean(message.message.messageText?.trim()))
            .slice(-12)
            .map((message) => ({
              handle: message.isBot ? BOT_LABEL : message.handle,
              text: message.message.messageText ?? '',
            })),
          ...(socialContext ? { socialContext } : {}),
          ...(documentContext ? { documentContext } : {}),
          requestedActions,
          socialSignal: evaluation.socialSignal ?? scene.socialSignal,
          replyPlan: agentPlan,
          recentBotReplies: ctx.recentBotReplies,
          visual,
          quotaBypass: ctx.quotaBypass,
          allowCapabilityInstall: ctx.allowCapabilityInstall,
        });
        if (coordinated) {
          const jokeUse = usedRunningJoke(coordinated.text, socialSnapshot.runningJokes);
          if (jokeUse) {
            await this.social.recordJokeUse(ctx.context.chatId, jokeUse.id, jokeUse.variant);
          }
          return immediateOutcome({
            text: coordinated.text,
            styleVariant: coordinated.styleVariant,
            plan: agentPlan,
            providerBundle: {
              sources: coordinated.sources,
              ...(socialContext ? { socialContext } : {}),
            },
            imageCalls: coordinated.imageCalls,
            visionCalls: visionCalls + coordinated.visionCalls,
            ...(coordinated.imageBuffer ? { imageBuffer: coordinated.imageBuffer } : {}),
            ...(coordinated.imageSpoiler ? { imageSpoiler: true } : {}),
            ...(coordinated.videoBuffer ? { videoBuffer: coordinated.videoBuffer } : {}),
            ...(coordinated.videoSpoiler ? { videoSpoiler: true } : {}),
            ...(coordinated.videoMeta ? { videoMeta: coordinated.videoMeta } : {}),
            ...(coordinated.audioBuffer ? { audioBuffer: coordinated.audioBuffer } : {}),
            ...(coordinated.music ? { music: coordinated.music } : {}),
            ...(coordinated.linkMediaUrl ? { linkMediaUrl: coordinated.linkMediaUrl } : {}),
          });
        }
      } catch (err) {
        log.warn({ err }, 'multi-action runtime failed; continuing with legacy tool path');
      }
    }

    if (
      wants('capability_forge', 'capability_forge') ||
      evaluation.action === 'acquire_capability'
    ) {
      const request = callFor('capability_forge')?.query?.trim() || ctx.message.messageText.trim();
      const acquired = await this.capabilities.acquire({
        request,
        language: ctx.language,
        allowInstall: Boolean(ctx.allowCapabilityInstall),
        ...(ctx.quotaBypass ? {} : { chatId: ctx.context.chatId }),
        ...(generationModel ? { model: generationModel } : {}),
      });
      const newlyInstalled = isNewCapabilityInstallation(acquired);
      const reused = isVerifiedCapabilityReuse(acquired);
      const learned = newlyInstalled
        ? ctx.language === 'italian'
          ? `\n\nNuova capacità permanente: /${acquired.command}`
          : `\n\nNew permanent capability: /${acquired.command}`
        : reused
          ? ctx.language === 'italian'
            ? `\n\nCapacità esistente eseguita: /${acquired.command}`
            : `\n\nExisting capability executed: /${acquired.command}`
          : '';
      return immediateOutcome({
        text: `${acquired.text}${learned}`.trim(),
        styleVariant:
          newlyInstalled || reused
            ? 'capability_installed'
            : acquired.status === 'proposal_saved' || acquired.status === 'awaiting_approval'
              ? 'capability_proposal'
              : 'capability_failed',
        providerBundle: { sources: acquired.sources },
        usage: acquired.usage,
        model: acquired.model,
      });
    }

    const wantsLinkMedia =
      wants('link_media', 'link_media') || evaluation.action === 'download_media';
    if (wantsLinkMedia) {
      if (!this.config.linkMedia.enabled || ctx.allowLinkMedia === false) {
        return immediateOutcome({
          text: t('media_tool_unavailable'),
          styleVariant: 'media_unavailable',
        });
      }
      const mediaCall = callFor('link_media');
      const directUrl =
        mediaCall?.args?.url ||
        evaluation.mediaUrl ||
        firstUrl(mediaCall?.query) ||
        firstUrl(ctx.message.messageText);
      const query = (
        directUrl
          ? ''
          : mediaCall?.query ||
            evaluation.mediaQuery ||
            cleanQuery(ctx.message.messageText, ctx.botUsername)
      ).trim();
      const url =
        directUrl ||
        (await this.grounding.findMediaUrl(
          query,
          ctx.language,
          ctx.quotaBypass ? undefined : ctx.context.chatId,
        ));
      if (!url) {
        return immediateOutcome({
          text: query ? t('media_not_found', { query }) : t('media_needs_query'),
          styleVariant: 'media_not_found',
        });
      }
      // The downloader reserves media quota at the point of execution. Reserving here as well made
      // a single addressed link consume the allowance twice (or three times after auto-rehosting).
      return immediateOutcome({
        linkMediaUrl: url,
        providerBundle: { sources: [url] },
        styleVariant: 'download_media',
      });
    }

    const wantsMusic = wants('music', 'music') || evaluation.action === 'download_music';
    if (wantsMusic) {
      const bannedOpenings = [
        ...this.styleEngine.bannedOpenings(ctx.recentBotReplies),
        ...this.styleEngine.recurringTics(ctx.recentBotReplies),
      ];
      const plan = this.planner.plan({
        scene,
        evaluation,
        retrievedMemories: [],
        bannedOpenings,
        currentHandle: ctx.person.userHandle,
        maxLines: this.config.env.MAX_REPLY_LINES,
        maxChars: this.config.env.MAX_REPLY_CHARS,
      });
      const query = cortexDecision
        ? (callFor('music')?.query ?? '').trim()
        : usableMusicQuery(evaluation.musicQuery, ctx.message.messageText, ctx.botUsername);
      const providerBundle: ProviderBundle = { sources: [] };
      if (!this.music.enabled) {
        return {
          text: t('music_unavailable'),
          transcribedUserMessage: transcribed,
          usage: { inputTokens: 0, outputTokens: 0, estimated: true },
          model: null,
          visionCalls,
          transcriptionCalls,
          imageCalls: 0,
          scene,
          plan,
          styleVariant: 'music_unavailable',
          retrieved: [],
          usedMemoryIds: [],
          candidates: [],
          ranked: [],
          repetitionChecks: [],
          evaluation,
          ...(cortexDecision ? { cortex: cortexDecision } : {}),
          providerBundle,
        };
      }
      if (!query) {
        return {
          text: t('music_none'),
          transcribedUserMessage: transcribed,
          usage: { inputTokens: 0, outputTokens: 0, estimated: true },
          model: null,
          visionCalls,
          transcriptionCalls,
          imageCalls: 0,
          scene,
          plan,
          styleVariant: 'music_needs_query',
          retrieved: [],
          usedMemoryIds: [],
          candidates: [],
          ranked: [],
          repetitionChecks: [],
          evaluation,
          ...(cortexDecision ? { cortex: cortexDecision } : {}),
          providerBundle,
        };
      }
      const music = await this.music.fetch(query);
      if (!music) {
        return {
          text: t('music_not_found', { query }),
          transcribedUserMessage: transcribed,
          usage: { inputTokens: 0, outputTokens: 0, estimated: true },
          model: null,
          visionCalls,
          transcriptionCalls,
          imageCalls: 0,
          scene,
          plan,
          styleVariant: 'music_not_found',
          retrieved: [],
          usedMemoryIds: [],
          candidates: [],
          ranked: [],
          repetitionChecks: [],
          evaluation,
          ...(cortexDecision ? { cortex: cortexDecision } : {}),
          providerBundle,
        };
      }
      return {
        text: '',
        music,
        transcribedUserMessage: transcribed,
        usage: { inputTokens: 0, outputTokens: 0, estimated: true },
        model: null,
        visionCalls,
        transcriptionCalls,
        imageCalls: 0,
        scene,
        plan,
        styleVariant: 'music_download',
        retrieved: [],
        usedMemoryIds: [],
        candidates: [],
        ranked: [],
        repetitionChecks: [],
        evaluation,
        ...(cortexDecision ? { cortex: cortexDecision } : {}),
        providerBundle,
      };
    }

    if (wants('video_gen', 'video_generation') || evaluation.action === 'generate_video') {
      const prompt = (
        callFor('video_gen')?.query ||
        evaluation.videoPrompt ||
        ctx.message.messageText ||
        ''
      ).trim();
      if (!prompt) {
        return immediateOutcome({
          text: t('video_needs_prompt'),
          styleVariant: 'video_needs_prompt',
        });
      }
      if (!this.video.enabled) {
        return immediateOutcome({ text: t('video_unavailable'), styleVariant: 'video_failed' });
      }
      if (!ctx.quotaBypass && !(await this.quota.reserve(ctx.context.chatId, 'image')).allowed) {
        return immediateOutcome({
          text: t('image_quota_exhausted'),
          styleVariant: 'image_quota_exhausted',
        });
      }
      try {
        const preparedPrompt = await this.videoPrompts.prepare(prompt, {
          ...(ctx.model ? { model: ctx.model } : {}),
          context: {
            creatorHandle: ctx.person.userHandle,
            intent: prompt,
            relevantLore: socialContext ? [socialContext.slice(0, 1_200)] : [],
            recentMessages: history.slice(-6).map((message) => ({
              handle: message.isBot ? BOT_LABEL : message.handle,
              text: message.message.messageText ?? '',
            })),
          },
        });
        const clip = await this.video.generate(preparedPrompt.prompt);
        const prepared = await prepareVideoForTelegram(
          clip.buffer,
          this.config.linkMedia.ffmpegBin,
        );
        return immediateOutcome({
          text: t('video_done', { prompt: prompt.slice(0, 180) }),
          styleVariant: 'video_done',
          videoBuffer: prepared.buffer,
          videoSpoiler: preparedPrompt.profile === 'nsfw',
          videoMeta: {
            ...(prepared.width !== undefined ? { width: prepared.width } : {}),
            ...(prepared.height !== undefined ? { height: prepared.height } : {}),
            duration: prepared.duration ?? clip.seconds,
            ...(prepared.thumbnail ? { thumbnail: prepared.thumbnail } : {}),
          },
        });
      } catch (err) {
        if (err instanceof VideoRateLimitError) {
          return immediateOutcome({
            text: t('video_rate_limited', { seconds: Math.ceil(err.retryAfterMs / 1000) }),
            styleVariant: 'video_rate_limited',
          });
        }
        log.warn({ err }, 'cortex video generation failed');
        return immediateOutcome({ text: t('video_failed'), styleVariant: 'video_failed' });
      }
    }

    if (
      wants('image_gen', 'image_generation') ||
      evaluation.action === 'generate_image' ||
      evaluation.action === 'draw_image'
    ) {
      const prompt = (
        callFor('image_gen')?.query ||
        evaluation.imagePrompt ||
        (cortexDecision
          ? ctx.message.messageText
          : cleanQuery(ctx.message.messageText, ctx.botUsername))
      ).trim();
      if (!this.media.canGenerateImage) {
        return immediateOutcome({
          text: t('image_unavailable'),
          styleVariant: 'image_unavailable',
        });
      }
      if (!prompt) {
        return immediateOutcome({
          text: t('image_needs_prompt'),
          styleVariant: 'image_needs_prompt',
        });
      }
      if (containsMinorMediaReference(prompt)) {
        return immediateOutcome({
          text: t('image_minor_refused'),
          styleVariant: 'image_minor_refused',
        });
      }
      if (!ctx.quotaBypass && !(await this.quota.reserve(ctx.context.chatId, 'image')).allowed) {
        return immediateOutcome({
          text: t('image_quota_exhausted'),
          styleVariant: 'image_quota_exhausted',
        });
      }
      const imageCall = callFor('image_gen');
      const requestedProfile = imageProfileFromTool(imageCall?.args?.profile);
      const requestedAspectRatio = imageAspectRatioFromTool(
        imageCall?.args?.aspectRatio ?? imageCall?.args?.aspect_ratio ?? imageCall?.args?.ratio,
      );
      const profile: ImageProfile | undefined =
        requestedProfile ?? (evaluation.action === 'draw_image' ? 'manga' : undefined);
      let prepared: PreparedImagePrompt;
      try {
        prepared = await this.imagePrompts.prepare(prompt, {
          ...(profile ? { profile } : {}),
          ...(requestedAspectRatio ? { aspectRatio: requestedAspectRatio } : {}),
          ...(ctx.model ? { model: ctx.model } : {}),
          context: {
            creatorHandle: ctx.person.userHandle,
            intent: prompt,
            relevantLore: socialContext ? [socialContext.slice(0, 1_200)] : [],
            recentMessages: history.slice(-6).map((message) => ({
              handle: message.isBot ? BOT_LABEL : message.handle,
              text: message.message.messageText ?? '',
            })),
          },
        });
      } catch (error) {
        if (error instanceof MediaSafetyError) {
          return immediateOutcome({
            text: t('image_minor_refused'),
            styleVariant: 'image_minor_refused',
          });
        }
        throw error;
      }
      const poseLookup = prepared.poseReferenceQuery
        ? await this.imageFinder.findPoseReferenceWithUsage(prepared.poseReferenceQuery)
        : { image: null, visionCalls: 0 };
      const poseReference = poseLookup.image;
      const image = await this.media.generateImage(prepared.prompt, {
        profile: profile ?? prepared.profile,
        medium: prepared.medium,
        rating: prepared.rating,
        negativePrompt: prepared.negativePrompt,
        providerPrompts: prepared.providerPrompts,
        qualityBrief: prepared.qualityBrief,
        expectsPeople: prepared.expectsPeople,
        preferredProvider: prepared.preferredProvider,
        aspectRatio: prepared.aspectRatio,
        ...(poseReference ? { poseReference: poseReference.buffer } : {}),
      });
      if (!image?.buffer) {
        return immediateOutcome({
          text: t('image_unavailable'),
          styleVariant: 'image_failed',
        });
      }
      return immediateOutcome({
        text: t('image_done', { prompt: prompt.slice(0, 180) }),
        imageBuffer: image.buffer,
        imageSpoiler: prepared.rating !== 'safe',
        imageCalls: image.generationAttempts ?? 1,
        visionCalls: visionCalls + poseLookup.visionCalls + (image.qaVisionCalls ?? 0),
        styleVariant: evaluation.action,
      });
    }

    if (wants('translate', 'translation') || evaluation.action === 'translate_text') {
      const translateCall = callFor('translate');
      const target =
        translateCall?.args?.targetLanguage?.trim() ||
        evaluation.targetLanguage?.trim() ||
        'English';
      const source = (
        translateCall?.args?.sourceText ||
        translateCall?.query ||
        evaluation.sourceText ||
        ctx.context.repliedToText ||
        ''
      ).trim();
      if (!source) {
        return immediateOutcome({
          text: t('translate_usage'),
          styleVariant: 'translate_needs_source',
        });
      }
      try {
        const result = await this.llm.chatCompletion({
          system:
            `You are a precise translator. Translate the user's message into ${target}. ` +
            'Auto-detect the source language. Preserve tone, register, slang and vulgarity. ' +
            'Output ONLY the translation - no quotes, no notes, no language labels.',
          messages: [{ role: 'user', content: source }],
          ...(ctx.model ? { model: ctx.model } : {}),
          temperature: 0.2,
          maxTokens: 700,
        });
        const text = result.text.trim();
        if (!text) throw new Error('empty translation');
        return immediateOutcome({
          text,
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            estimated: result.usage.estimated,
          },
          model: result.model,
          styleVariant: 'translate_text',
        });
      } catch {
        return immediateOutcome({
          text: t('translate_failed'),
          styleVariant: 'translate_failed',
        });
      }
    }

    if (wants('tts', 'tts') || evaluation.action === 'make_voice') {
      if (!this.tts.enabled) {
        return immediateOutcome({
          text: t('voice_unavailable'),
          styleVariant: 'voice_unavailable',
        });
      }
      const source =
        callFor('tts')?.args?.voiceText?.trim() ||
        callFor('tts')?.query?.trim() ||
        evaluation.voiceText?.trim() ||
        ctx.context.repliedToText?.trim() ||
        history
          .slice()
          .reverse()
          .find((m) => !m.isBot && m.message.messageText?.trim())
          ?.message.messageText?.trim() ||
        '';
      if (!source) {
        return immediateOutcome({
          text: t('voice_none'),
          styleVariant: 'voice_needs_source',
        });
      }
      const ogg = await this.tts.synth(source, ctx.language);
      if (!ogg) {
        return immediateOutcome({
          text: t('voice_failed'),
          styleVariant: 'voice_failed',
        });
      }
      return immediateOutcome({
        audioBuffer: ogg,
        styleVariant: 'make_voice',
      });
    }

    if (evaluation.action === 'post_news') {
      if (!this.autonomousPoster.enabled) {
        return immediateOutcome({
          text: t('news_unavailable'),
          styleVariant: 'news_unavailable',
        });
      }
      const post = await this.autonomousPoster.compose(ctx.language, 'news', {
        chatId: ctx.context.chatId,
        chatName: ctx.context.chatName,
      });
      if (!post) {
        return immediateOutcome({
          text: t('news_unavailable'),
          styleVariant: 'news_empty',
        });
      }
      return immediateOutcome({
        text: post.text,
        ...(post.imageBuffer ? { imageBuffer: post.imageBuffer } : {}),
        styleVariant: 'post_news',
      });
    }

    // 2. retrieve memory + (in parallel) grounding, on-demand knowledge, and update per-user heat
    const activeHandles = [
      ...new Set(
        (threadState.memoryHandles.length
          ? threadState.memoryHandles
          : history.filter((m) => !m.isBot).map((m) => m.handle)
        ).filter(Boolean),
      ),
    ];
    // Direct interactions always get a relevance-filtered personal-memory lookup. Retrieval is not
    // the same as forcing a callback: the planner can still choose memoryUseMode=none.
    const wantsGroupRag = addressed || wants('group_rag', 'group_rag');
    const wantsKnowledgeRag = wants('knowledge_rag', 'knowledge_rag');
    const wantsGrounding =
      wants('web_search', 'web_search') || wants('image_lookup', 'image_lookup');
    const groundForce = wants('image_lookup', 'image_lookup')
      ? 'image'
      : wants('web_search', 'web_search')
        ? 'web'
        : null;
    const [retrieved, grounding, knowledgeItems, heatValue, ambientRecall] = await Promise.all([
      wantsGroupRag
        ? this.memoryRetriever.retrieve({
            chatId: ctx.context.chatId,
            currentMessage: ctx.message.messageText,
            currentHandle: ctx.person.userHandle,
            scene,
            activeHandles,
            mentionedHandles: mentioned,
            repliedToHandle: ctx.context.repliedToUserHandle ?? null,
            nsfwEnabled: generationNsfwEnabled,
            recentMessages: history.slice(-3).map((m) => m.message.messageText ?? ''),
          })
        : Promise.resolve([]),
      wantsGrounding
        ? this.ground(
            ctx,
            visual,
            groundForce,
            callFor('web_search')?.query ?? evaluation.searchQuery,
          )
        : Promise.resolve(null),
      wantsKnowledgeRag && this.knowledge.enabled
        ? this.knowledge.retrieve(ctx.message.messageText, scene.currentTopic)
        : Promise.resolve([]),
      this.heat.enabled
        ? this.heat.bump(
            ctx.context.chatId,
            ctx.person.userHandle,
            this.heat.deltaFromScene(scene, ctx.message.messageText),
          )
        : Promise.resolve(0),
      // Ambient recall is unconditional: unlike every other provider here it is not gated on a
      // classified intent, because its whole purpose is knowing things nobody thought to ask for.
      this.ambient.recall({
        message: ctx.message.messageText ?? '',
        chatId: ctx.context.chatId,
        nsfwAllowed: generationNsfwEnabled,
        userHandle: ctx.person.userHandle,
        ...(threadState.currentThread?.threadId
          ? { threadId: threadState.currentThread.threadId }
          : {}),
        ...(ctx.context.messageId === undefined ? {} : { messageId: ctx.context.messageId }),
      }),
    ]);
    const news = wants('news', 'news')
      ? await this.newsContext(ctx, history, retrieved, scene)
      : { sources: [] };
    const sources = [
      ...new Set([...(grounding?.sources ?? []), ...news.sources, ...ambientRecall.sources]),
    ];
    const providerBundle: ProviderBundle = { sources };
    if (threadState.promptBlock) providerBundle.threadContext = threadState.promptBlock;
    if (socialContext) providerBundle.socialContext = socialContext;
    const groupContext = formatGroupContext(retrieved);
    // Curated culture and ambient facts share one prompt slot on purpose: its framing already
    // says "background you happen to know, use only if it fits", which is exactly the contract
    // that keeps recall from dragging every conversation onto the same subject.
    const knowledgeBlock = [formatKnowledge(knowledgeItems), ambientRecall.block]
      .filter(Boolean)
      .join('\n\n');
    const claimCheck = formatClaimCheck(evaluation, sources);
    if (groupContext) providerBundle.groupContext = groupContext;
    if (knowledgeBlock) providerBundle.knowledgeContext = knowledgeBlock;
    if (ambientRecall.block) providerBundle.ambientContext = ambientRecall.block;
    if (grounding?.block) providerBundle.webContext = grounding.block;
    if (news.block) providerBundle.newsContext = news.block;
    if (claimCheck) providerBundle.claimCheck = claimCheck;
    const providerContextBlock = [
      providerBundle.webContext,
      providerBundle.newsContext,
      providerBundle.claimCheck,
    ]
      .filter(Boolean)
      .join('\n\n');
    // Baseline is friendship, not permanent hostility. Inject an escalation directive only after
    // this specific person has actually built up heat; gratitude/de-escalation must feel accepted.
    const hostility = this.heat.enabled && heatValue >= 20 ? this.heat.directive(heatValue) : null;

    // 3. style + plan
    const style = this.styleEngine.sample({
      modeName: ctx.modeName,
      modeDescription: ctx.modeDescription,
      scene,
      recentBotReplies: ctx.recentBotReplies,
      nsfwEnabled: generationNsfwEnabled,
      valueTarget: evaluation.valueTarget,
      socialRole: evaluation.socialRole,
    });
    // per-user heat raises the aggression floor for THIS user
    if (
      hostility &&
      scene.socialSignal?.humorAllowed !== false &&
      evaluation.socialSignal?.humorAllowed !== false
    ) {
      style.aggression = Math.max(style.aggression, hostility.aggression);
    }
    // banned phrases include overused openings AND recurring tics/sign-offs (kills catchphrases)
    const bannedOpenings = [
      ...this.styleEngine.bannedOpenings(ctx.recentBotReplies),
      ...this.styleEngine.recurringTics(ctx.recentBotReplies),
    ];
    const plan = this.planner.plan({
      scene,
      evaluation,
      retrievedMemories: retrieved,
      bannedOpenings,
      currentHandle: ctx.person.userHandle,
      maxLines: this.config.env.MAX_REPLY_LINES,
      maxChars: this.config.env.MAX_REPLY_CHARS,
      comedyStrategy: style.comedyStrategies?.[0],
    });

    // Address the current speaker; media is attributed to its poster (replied-to user, or the
    // speaker if they sent it) so the roast target is unambiguous.
    const addressee = ctx.person.userHandle;
    const media =
      visual && transcribed.imageDescription
        ? {
            kind: visual.kind,
            description: transcribed.imageDescription,
            poster: visual.fromReply
              ? (ctx.context.repliedToUserHandle ?? 'whoever posted it')
              : ctx.person.userHandle,
          }
        : undefined;
    const humorAllowed =
      scene.socialSignal?.humorAllowed !== false && evaluation.socialSignal?.humorAllowed !== false;
    const hostilityLine =
      hostility && humorAllowed
        ? `HOSTILITY toward ${addressee}: ${hostility.level} (${hostility.heat}/100) - ${hostility.instruction}`
        : undefined;

    // 4. generate candidates
    const gen = await this.generator.generate({
      botUsername: ctx.botUsername,
      chatName: ctx.context.chatName,
      language: ctx.language,
      modeName: ctx.modeName,
      modeDescription: ctx.modeDescription,
      nsfwEnabled: generationNsfwEnabled,
      scene,
      plan,
      style,
      history,
      currentUser: ctx.person,
      currentMessage: transcribed,
      retrievedMemories: retrieved,
      botLabel: BOT_LABEL,
      model: generationModel,
      addressee,
      ...(providerContextBlock ? { grounding: providerContextBlock } : {}),
      ...(media ? { media } : {}),
      ...(threadState.promptBlock ? { threadContext: threadState.promptBlock } : {}),
      ...(socialContext ? { socialContext } : {}),
      ...(hostilityLine ? { hostility: hostilityLine } : {}),
      ...(knowledgeBlock ? { knowledge: knowledgeBlock } : {}),
      ...(documentContext ? { documents: documentContext } : {}),
    });

    let candidates = gen.candidates;
    let usage = gen.usage;
    const allCandidates = [...candidates];
    const repetitionChecks: RepetitionCheck[] = [];

    // 5. rank + repetition guard (+ regenerate)
    let best = '';
    let ranked: RankedReply[] = [];
    let recoveryCandidate: AssessedReplyCandidate | null = null;
    const maxRegen = this.config.brain.replyMaxRegenerations;
    for (let attempt = 0; attempt <= maxRegen; attempt += 1) {
      if (candidates.length === 0) break;
      ranked = rankCandidatesSafely(
        this.ranker,
        candidates,
        {
          recent: ctx.recentBotReplies,
          plan,
          memories: retrieved,
          maxChars: this.config.env.MAX_REPLY_CHARS,
          userMessage: transcribed.messageText ?? '',
        },
        (err) =>
          log.warn(
            { err, chatId: ctx.context.chatId },
            'reply ranker failed; preserving generation order',
          ),
      );
      let blockedCandidate = candidates[ranked[0]?.index ?? 0] ?? '';
      let blockingCheck: RepetitionCheck | undefined;
      const assessed: AssessedReplyCandidate[] = [];
      for (const candidateRank of ranked) {
        const candidate = candidates[candidateRank.index] ?? '';
        const check = this.guard.check(candidate, ctx.recentBotReplies, plan, retrieved);
        repetitionChecks.push(check);
        const socialFloorViolation = violatesSocialFloor(candidate, plan.socialSignal);
        assessed.push({
          text: candidate,
          rank: candidateRank,
          repetition: check,
          violatesSocialFloor: socialFloorViolation,
        });
        if (!blockingCheck) {
          blockedCandidate = candidate;
          blockingCheck = check;
        }
      }
      const decision = decideReplyAcceptance(assessed);
      if (
        decision.recovery &&
        (!recoveryCandidate || decision.recovery.rank.score > recoveryCandidate.rank.score)
      ) {
        recoveryCandidate = decision.recovery;
      }
      if (decision.accepted) {
        best = decision.accepted.text;
        break;
      }
      if (attempt === maxRegen) {
        best = recoveryCandidate?.text ?? hardFloorFallback(plan, ctx.language, scene.currentTopic);
        log.warn(
          {
            chatId: ctx.context.chatId,
            reason: blockingCheck?.reason,
            recoveredGeneratedCandidate: Boolean(recoveryCandidate),
          },
          recoveryCandidate
            ? 'hard filters exhausted; using best substantive generated candidate'
            : 'all generated candidates violated hard floors; using deterministic fallback',
        );
        break;
      }

      // This is intentionally the only path that spends another generation call: all candidates
      // hit a hard repetition/canned/social floor. Advisory novelty warnings never arrive here.
      const overusedTexts = retrieved
        .filter((m) => m.item._id && (blockingCheck?.overusedMemoryIds ?? []).includes(m.item._id))
        .map((m) => m.item.text);
      log.debug(
        { reason: blockingCheck?.reason, attempt },
        'all ranked candidates failed repetition guard - regenerating',
      );
      const regen = await this.generator.regenerate({
        system: gen.system,
        userPrompt: gen.userPrompt,
        model: generationModel,
        bannedPhrases: [...plan.bannedPhrases, blockedCandidate.split(/\s+/).slice(0, 4).join(' ')],
        overusedMemory: overusedTexts,
      });
      candidates = regen.candidates;
      allCandidates.push(...regen.candidates);
      usage = {
        inputTokens: usage.inputTokens + regen.usage.inputTokens,
        outputTokens: usage.outputTokens + regen.usage.outputTokens,
        estimated: usage.estimated || regen.usage.estimated,
      };
    }

    // A failed/empty regeneration must not erase a usable answer from the first batch.
    if (!best.trim() && recoveryCandidate) {
      best = recoveryCandidate.text;
      log.warn(
        { chatId: ctx.context.chatId },
        'regeneration yielded no candidate; recovering best substantive generated reply',
      );
    }

    // 5b. NSFW refusal backstop: if the default model refused and the chat allows NSFW, retry on
    // the uncensored model (the user never sees the refusal).
    let model = gen.model;
    if (ctx.allowRefusalFallback && ctx.nsfwModel && best.trim() && isRefusal(best)) {
      log.info('default model refused - backstop to NSFW model');
      const ns = await this.generator.generate({
        botUsername: ctx.botUsername,
        chatName: ctx.context.chatName,
        language: ctx.language,
        modeName: ctx.modeName,
        modeDescription: ctx.modeDescription,
        nsfwEnabled: true,
        scene,
        plan,
        style,
        history,
        currentUser: ctx.person,
        currentMessage: transcribed,
        retrievedMemories: retrieved,
        botLabel: BOT_LABEL,
        model: ctx.nsfwModel,
        addressee,
        ...(providerContextBlock ? { grounding: providerContextBlock } : {}),
        ...(media ? { media } : {}),
        ...(threadState.promptBlock ? { threadContext: threadState.promptBlock } : {}),
        ...(socialContext ? { socialContext } : {}),
        ...(hostilityLine ? { hostility: hostilityLine } : {}),
        ...(knowledgeBlock ? { knowledge: knowledgeBlock } : {}),
        ...(documentContext ? { documents: documentContext } : {}),
      });
      if (ns.candidates.length > 0) {
        const r = rankCandidatesSafely(
          this.ranker,
          ns.candidates,
          {
            recent: ctx.recentBotReplies,
            plan,
            memories: retrieved,
            maxChars: this.config.env.MAX_REPLY_CHARS,
            userMessage: transcribed.messageText ?? '',
          },
          (err) =>
            log.warn(
              { err, chatId: ctx.context.chatId },
              'NSFW reply ranker failed; preserving generation order',
            ),
        );
        const assessed: AssessedReplyCandidate[] = [];
        for (const candidateRank of r) {
          const candidate = ns.candidates[candidateRank.index] ?? '';
          const check = this.guard.check(candidate, ctx.recentBotReplies, plan, retrieved);
          repetitionChecks.push(check);
          assessed.push({
            text: candidate,
            rank: candidateRank,
            repetition: check,
            violatesSocialFloor: violatesSocialFloor(candidate, plan.socialSignal),
          });
        }
        const decision = decideReplyAcceptance(assessed);
        best = decision.accepted?.text ?? decision.recovery?.text ?? best;
        allCandidates.push(...ns.candidates);
        model = ns.model;
        usage = {
          inputTokens: usage.inputTokens + ns.usage.inputTokens,
          outputTokens: usage.outputTokens + ns.usage.outputTokens,
          estimated: usage.estimated || ns.usage.estimated,
        };
      }
    }

    if (!best.trim()) {
      log.error(
        {
          chatId: ctx.context.chatId,
          userHandle: ctx.person.userHandle,
          model: gen.model,
          usage,
          candidateCount: allCandidates.length,
          evaluationAction: evaluation.action,
          evaluationReason: evaluation.reason,
          sceneTopic: scene.currentTopic,
          userText: (transcribed.messageText ?? '').slice(0, 500),
        },
        'reply generation produced no usable candidates',
      );
      throw new Error('reply generation produced no usable candidates');
    }

    // 6. optional ambient/verified image output. Explicit generation is handled earlier by image_gen.
    let imageUrl: string | undefined;
    let imageBuffer: Buffer | undefined;
    const imageCalls = 0;
    let ambientVisionCalls = 0;
    // 6b. send a verified waifu/anime image when the user asked for one, when the reply PROMISED one
    // (a promise must be honored), or ambiently when the topic is anime/waifu (the bot's taste).
    const userMsg = ctx.message.messageText || '';
    const wantsImage = IMAGE_WANT_RE.test(userMsg);
    const promisedImage = IMAGE_PROMISE_RE.test(best);
    const ambient =
      isAnimeTopic(userMsg, knowledgeItems, ambientRecall) &&
      Math.random() < this.config.auto.imageSendProbability;
    if (
      !imageBuffer &&
      !imageUrl &&
      this.config.auto.imageSendEnabled &&
      this.imageFinder.enabled &&
      (wantsImage || promisedImage || ambient)
    ) {
      const subject =
        wantsImage || promisedImage
          ? imageQueryFromMessage(userMsg)
          : // Unprompted: search for what the chat is actually discussing, when recall knows.
            ambientImageSubject(ambientRecall);
      let lookup = await this.imageFinder.findWithUsage(subject);
      ambientVisionCalls += lookup.visionCalls;
      let found = lookup.image;
      // A specific subject that found nothing falls back to the bot's generic taste: an explicit
      // request must be honoured, and an ambient post is worth keeping rather than dropping.
      if (!found && subject) {
        lookup = await this.imageFinder.findWithUsage();
        ambientVisionCalls += lookup.visionCalls;
        found = lookup.image;
      }
      if (found) {
        imageBuffer = found.buffer;
      }
    }

    const usedMemoryIds = actuallyUsedMemoryIds(best, retrieved, plan);
    const jokeUse = usedRunningJoke(best, socialSnapshot.runningJokes);
    if (jokeUse) {
      await this.social.recordJokeUse(ctx.context.chatId, jokeUse.id, jokeUse.variant);
    }

    const outcome: ReplyOutcome = {
      text: best,
      transcribedUserMessage: transcribed,
      usage,
      model,
      visionCalls: visionCalls + ambientVisionCalls,
      transcriptionCalls,
      imageCalls,
      scene,
      plan,
      styleVariant: style.variants.join('+'),
      retrieved,
      usedMemoryIds,
      candidates: allCandidates,
      ranked,
      repetitionChecks,
      evaluation,
      ...(cortexDecision ? { cortex: cortexDecision } : {}),
      providerBundle,
      threadState,
    };
    if (imageUrl !== undefined) outcome.imageUrl = imageUrl;
    if (imageBuffer !== undefined) outcome.imageBuffer = imageBuffer;
    return outcome;
  }
}
