import type { AppConfig } from '../config/index.js';
import type { ChatContext, IncomingMessage, Person, TranscribedMessage } from '../domain/types.js';
import type { LLMProvider } from '../providers/llm/types.js';
import type { MediaProcessor } from '../providers/media/index.js';
import type { MusicResult, MusicService } from '../providers/media/music.js';
import type { TtsProvider } from '../providers/voice/tts.js';
import type { ImageProfile } from '../providers/image/stableDiffusion.js';
import type { ConversationService } from './conversation.js';
import { BOT_LABEL } from './conversation.js';
import type { MemoryRetrievalInput } from '../memory/memoryRetriever.js';
import type { SceneAnalyzer } from '../brain/sceneAnalyzer.js';
import type { GroundingService } from '../search/groundingService.js';
import type { HeatService } from './heat.js';
import type { KnowledgeRetriever } from '../knowledge/knowledgeRetriever.js';
import type { ImageFinder } from '../media/imageFinder.js';
import type { NewsService } from '../news/newsService.js';
import type { AutonomousPoster } from './autonomousPoster.js';
import type { ImagePromptService } from './imagePrompt.js';
import { parseMusicRequest } from './musicIntent.js';
import type { RetrievedMemory } from '../memory/types.js';
import { StyleEngine } from '../brain/styleEngine.js';
import { ReplyPlanner } from '../brain/replyPlanner.js';
import { ResponseGenerator } from '../brain/responseGenerator.js';
import { ResponseRanker } from '../brain/responseRanker.js';
import { RepetitionGuard } from '../brain/repetitionGuard.js';
import { TurnEvaluator } from '../brain/turnEvaluator.js';
import { Cortex, cortexToTurnEvaluation } from '../brain/cortex/evaluator.js';
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

const log = childLogger('reply');

const IMAGE_REQUEST_RE =
  /\b(draw|disegna|generate (an )?image|crea (un'?|una )?(immagine|foto|meme)|make (an? )?(image|pic|picture|meme)|genera (un'?|una )?(immagine|foto))\b/i;

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

/** True when the conversation is about anime/waifu (message text or matched knowledge topics). */
function isAnimeTopic(message: string, knowledge: { topic: string }[]): boolean {
  if (ANIME_TOPIC_RE.test(message)) return true;
  return knowledge.some((k) => /waifu|anime|manga|otaku/i.test(k.topic));
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

const FALLBACKS = [
  'almost repeated myself again. delete that thought, I am getting back on track.',
  'ok I was about to go full NPC. mental reset, give me a sec and I am back to being properly mean.',
  'wait no, I already did that joke. I deserve the ban myself.',
];

const BAD_MUSIC_QUERY_RE =
  /\b(una canzone|qualche canzone|canzone da youtube|comando\s*\/|\/suona|\/play|il tuo comando)\b/i;

function usableMusicQuery(query: string | undefined, message: string, botUsername: string): string {
  const q = (query || parseMusicRequest(message, botUsername) || '').trim();
  if (!q || BAD_MUSIC_QUERY_RE.test(q)) return '';
  return q;
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
  /** model from the NSFW router for this turn */
  model?: string | undefined;
  /** when the default model refuses, retry with the uncensored model */
  allowRefusalFallback?: boolean | undefined;
  nsfwModel?: string | undefined;
  recentBotReplies: BotReplyRecord[];
}

export interface ReplyOutcome {
  text: string;
  suppressed?: boolean;
  music?: MusicResult;
  audioBuffer?: Buffer;
  imageUrl?: string;
  imageBuffer?: Buffer;
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
  ): Promise<{
    transcribed: TranscribedMessage;
    visionCalls: number;
    transcriptionCalls: number;
  }> {
    let imageDescription: string | null = null;
    let voiceDescription: string | null = null;
    let visionCalls = 0;
    let transcriptionCalls = 0;
    if (visual) {
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
        return await this.grounding.groundImage({
          imageBuffer: visual.buffer,
          imageMime: visual.mime,
          question,
          language: ctx.language,
        });
      }
      if (force === 'web' || this.grounding.wantsWebSearch(question)) {
        const query = queryOverride?.trim() || cleanQuery(question, ctx.botUsername);
        return await this.grounding.groundWeb(query, ctx.language);
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
    );
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

    // 1. scene
    const scene = await this.sceneAnalyzer.analyze({
      history,
      currentMessage: ctx.message.messageText,
      currentHandle: ctx.person.userHandle,
      mentionedHandles: mentioned,
      botIsAddressed: ctx.context.isBotMentioned || ctx.context.isReplyToBot,
      botLabel: BOT_LABEL,
    });
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
      imageLookup: this.grounding.enabled && Boolean(visual),
      news: this.news.enabled,
      knowledge: this.knowledge.enabled,
      music: this.music.enabled,
      imageGeneration: this.media.canGenerateImage,
      translation: this.llm.capabilities.chat,
      tts: this.tts.enabled,
    };
    let cortexDecision: SourcedCortexDecision | undefined;
    const evaluation = this.config.brain.cortex.enabled
      ? await (async () => {
          cortexDecision = await this.cortex.evaluate({
            scene,
            history,
            currentMessage: ctx.message.messageText,
            botIsAddressed: addressed,
            recentNegativeFeedback,
            capabilities,
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
              visual && this.grounding.wantsImageLookup(ctx.message.messageText || ''),
            ),
          },
        });
    const callFor = (tool: CortexTool) =>
      cortexDecision?.toolCalls.find((call) => call.tool === tool);
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
      audioBuffer?: Buffer;
      imageCalls?: number;
      usage?: { inputTokens: number; outputTokens: number; estimated: boolean };
      model?: string | null;
    }): ReplyOutcome => {
      const out: ReplyOutcome = {
        text: params.text ?? '',
        transcribedUserMessage: transcribed,
        usage: params.usage ?? { inputTokens: 0, outputTokens: 0, estimated: true },
        model: params.model ?? null,
        visionCalls,
        transcriptionCalls,
        imageCalls: params.imageCalls ?? 0,
        scene,
        plan: makeImmediatePlan(),
        styleVariant: params.styleVariant,
        retrieved: [],
        usedMemoryIds: [],
        candidates: [],
        ranked: [],
        repetitionChecks: [],
        evaluation,
        ...(cortexDecision ? { cortex: cortexDecision } : {}),
        providerBundle: params.providerBundle ?? { sources: [] },
      };
      if (params.imageBuffer) out.imageBuffer = params.imageBuffer;
      if (params.audioBuffer) out.audioBuffer = params.audioBuffer;
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
        providerBundle: { sources: [] },
      };
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
          text: 'Vorrei pure, ma il tool musica non è disponibile adesso. Non fare quella faccia, è proprio il pezzo meccanico che manca.',
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
          text: 'Sì, posso. Dimmi titolo o artista però: “scaricami Bohemian Rhapsody”, non “una canzone” come se leggessi il tuo algoritmo marcio.',
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
          text: `Non ho trovato "${query}" su YouTube o yt-dlp ha sputato sangue. Riprova con titolo/artista più preciso.`,
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
          text: 'Generatore immagini non disponibile adesso. Non ti sto ghostando, è proprio il forno spento.',
          styleVariant: 'image_unavailable',
        });
      }
      if (!prompt) {
        return immediateOutcome({
          text: 'Dimmi cosa devo generare, artista. “Fammi un’immagine” senza soggetto è nebbia con le notifiche.',
          styleVariant: 'image_needs_prompt',
        });
      }
      const profile: ImageProfile | undefined =
        evaluation.action === 'draw_image' || callFor('image_gen')?.args?.profile === 'manga'
          ? 'manga'
          : undefined;
      const prepared = await this.imagePrompts.prepare(prompt, profile ? { profile } : {});
      const poseReference = prepared.poseReferenceQuery
        ? await this.imageFinder.findPoseReference(prepared.poseReferenceQuery)
        : null;
      const image = await this.media.generateImage(prepared.prompt, {
        ...(profile ? { profile } : {}),
        ...(poseReference ? { poseReference: poseReference.buffer } : {}),
      });
      if (!image?.buffer) {
        return immediateOutcome({
          text: 'Generatore immagini non disponibile adesso. Riprova tra poco.',
          styleVariant: 'image_failed',
        });
      }
      return immediateOutcome({
        text: `Fatto: ${prompt.slice(0, 180)}`,
        imageBuffer: image.buffer,
        imageCalls: 1,
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
          text: 'Sì, traduco. Però rispondi al messaggio da tradurre o scrivimi il testo, non farmi fare spiritismo linguistico.',
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
          text: 'Traduzione fallita. Il traduttore ha fatto la fine del cervello dopo il terzo spritz.',
          styleVariant: 'translate_failed',
        });
      }
    }

    if (wants('tts', 'tts') || evaluation.action === 'make_voice') {
      if (!this.tts.enabled) {
        return immediateOutcome({
          text: 'Voice tool non disponibile adesso. La mia ugola sintetica è in sciopero.',
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
          text: 'Mandami o rispondi a un testo da vocalizzare, non posso leggere il vuoto cosmico.',
          styleVariant: 'voice_needs_source',
        });
      }
      const ogg = await this.tts.synth(source, ctx.language);
      if (!ogg) {
        return immediateOutcome({
          text: 'Sintesi vocale fallita. Ho provato a parlare e mi è uscito systemd.',
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
          text: 'News tool non disponibile adesso.',
          styleVariant: 'news_unavailable',
        });
      }
      const post = await this.autonomousPoster.compose(ctx.language, 'news', {
        chatId: ctx.context.chatId,
        chatName: ctx.context.chatName,
      });
      if (!post) {
        return immediateOutcome({
          text: 'Non ho trovato news fresche decenti adesso. Meglio zero che una minestra riscaldata.',
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
    const activeHandles = [...new Set(history.filter((m) => !m.isBot).map((m) => m.handle))];
    const wantsGroupRag = wants('group_rag', 'group_rag');
    const wantsKnowledgeRag = wants('knowledge_rag', 'knowledge_rag');
    const wantsGrounding =
      wants('web_search', 'web_search') || wants('image_lookup', 'image_lookup');
    const groundForce = wants('image_lookup', 'image_lookup')
      ? 'image'
      : wants('web_search', 'web_search')
        ? 'web'
        : null;
    const [retrieved, grounding, knowledgeItems, heatValue] = await Promise.all([
      wantsGroupRag
        ? this.memoryRetriever.retrieve({
            chatId: ctx.context.chatId,
            currentMessage: ctx.message.messageText,
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
    ]);
    const news = wants('news', 'news')
      ? await this.newsContext(ctx, history, retrieved, scene)
      : { sources: [] };
    const sources = [...new Set([...(grounding?.sources ?? []), ...news.sources])];
    const providerBundle: ProviderBundle = { sources };
    const groupContext = formatGroupContext(retrieved);
    const knowledgeBlock = formatKnowledge(knowledgeItems);
    const claimCheck = formatClaimCheck(evaluation, sources);
    if (groupContext) providerBundle.groupContext = groupContext;
    if (knowledgeBlock) providerBundle.knowledgeContext = knowledgeBlock;
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
    const hostility = this.heat.enabled ? this.heat.directive(heatValue) : null;

    // 3. style + plan
    const style = this.styleEngine.sample({
      modeName: ctx.modeName,
      modeDescription: ctx.modeDescription,
      scene,
      recentBotReplies: ctx.recentBotReplies,
      nsfwEnabled: generationNsfwEnabled,
    });
    // per-user heat raises the aggression floor for THIS user
    if (hostility) style.aggression = Math.max(style.aggression, hostility.aggression);
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
    const hostilityLine = hostility
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
      ...(hostilityLine ? { hostility: hostilityLine } : {}),
      ...(knowledgeBlock ? { knowledge: knowledgeBlock } : {}),
    });

    let candidates = gen.candidates;
    let usage = gen.usage;
    const allCandidates = [...candidates];
    const repetitionChecks: RepetitionCheck[] = [];

    // 5. rank + repetition guard (+ regenerate)
    let best = '';
    let ranked: RankedReply[] = [];
    const maxRegen = this.config.brain.replyMaxRegenerations;
    for (let attempt = 0; attempt <= maxRegen; attempt += 1) {
      if (candidates.length === 0) break;
      ranked = this.ranker.rank(candidates, {
        recent: ctx.recentBotReplies,
        plan,
        memories: retrieved,
        maxChars: this.config.env.MAX_REPLY_CHARS,
        userMessage: transcribed.messageText ?? '',
      });
      const topIdx = ranked[0]?.index ?? 0;
      best = candidates[topIdx] ?? '';
      const check = this.guard.check(best, ctx.recentBotReplies, plan, retrieved);
      repetitionChecks.push(check);
      if (check.allowed || attempt === maxRegen) break;

      const overusedTexts = retrieved
        .filter((m) => m.item._id && check.overusedMemoryIds.includes(m.item._id))
        .map((m) => m.item.text);
      log.debug({ reason: check.reason, attempt }, 'repetition block - regenerating');
      const regen = await this.generator.regenerate({
        system: gen.system,
        userPrompt: gen.userPrompt,
        model: generationModel,
        bannedPhrases: [...plan.bannedPhrases, best.split(/\s+/).slice(0, 4).join(' ')],
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
        ...(hostilityLine ? { hostility: hostilityLine } : {}),
        ...(knowledgeBlock ? { knowledge: knowledgeBlock } : {}),
      });
      if (ns.candidates.length > 0) {
        const r = this.ranker.rank(ns.candidates, {
          recent: ctx.recentBotReplies,
          plan,
          memories: retrieved,
          maxChars: this.config.env.MAX_REPLY_CHARS,
          userMessage: transcribed.messageText ?? '',
        });
        best = ns.candidates[r[0]?.index ?? 0] ?? best;
        allCandidates.push(...ns.candidates);
        model = ns.model;
        usage = {
          inputTokens: usage.inputTokens + ns.usage.inputTokens,
          outputTokens: usage.outputTokens + ns.usage.outputTokens,
          estimated: usage.estimated || ns.usage.estimated,
        };
      }
    }

    if (!best.trim()) best = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)] as string;

    // 6. optional image output (explicit request + capability)
    let imageUrl: string | undefined;
    let imageBuffer: Buffer | undefined;
    let imageCalls = 0;
    if (IMAGE_REQUEST_RE.test(ctx.message.messageText || '') && this.media.canGenerateImage) {
      const img = await this.media.generateImage(ctx.message.messageText);
      if (img) {
        imageCalls = 1;
        if (img.url) imageUrl = img.url;
        if (img.buffer) imageBuffer = img.buffer;
      }
    }

    // 6b. send a verified waifu/anime image when the user asked for one, when the reply PROMISED one
    // (a promise must be honored), or ambiently when the topic is anime/waifu (the bot's taste).
    const userMsg = ctx.message.messageText || '';
    const wantsImage = IMAGE_WANT_RE.test(userMsg);
    const promisedImage = IMAGE_PROMISE_RE.test(best);
    const ambient =
      isAnimeTopic(userMsg, knowledgeItems) &&
      Math.random() < this.config.auto.imageSendProbability;
    if (
      !imageBuffer &&
      !imageUrl &&
      this.config.auto.imageSendEnabled &&
      this.imageFinder.enabled &&
      (wantsImage || promisedImage || ambient)
    ) {
      const subject = wantsImage || promisedImage ? imageQueryFromMessage(userMsg) : undefined;
      let found = await this.imageFinder.find(subject);
      // if a specific subject found nothing, fall back to a generic waifu so the promise is kept
      if (!found && subject && (wantsImage || promisedImage)) found = await this.imageFinder.find();
      if (found) imageBuffer = found.buffer;
    }

    const usedMemoryIds =
      plan.memoryUseMode === 'none'
        ? []
        : retrieved.map((m) => m.item._id).filter((id): id is string => Boolean(id));

    const outcome: ReplyOutcome = {
      text: best,
      transcribedUserMessage: transcribed,
      usage,
      model,
      visionCalls,
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
    };
    if (imageUrl !== undefined) outcome.imageUrl = imageUrl;
    if (imageBuffer !== undefined) outcome.imageBuffer = imageBuffer;
    return outcome;
  }
}
