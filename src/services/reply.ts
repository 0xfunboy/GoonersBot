import type { AppConfig } from '../config/index.js';
import type { ChatContext, IncomingMessage, Person, TranscribedMessage } from '../domain/types.js';
import type { LLMProvider } from '../providers/llm/types.js';
import type { MediaProcessor } from '../providers/media/index.js';
import type { ConversationService } from './conversation.js';
import { BOT_LABEL } from './conversation.js';
import type { MemoryRetriever } from '../memory/memoryRetriever.js';
import type { SceneAnalyzer } from '../brain/sceneAnalyzer.js';
import type { GroundingService } from '../search/groundingService.js';
import type { HeatService } from './heat.js';
import type { KnowledgeRetriever } from '../knowledge/knowledgeRetriever.js';
import type { RetrievedMemory } from '../memory/types.js';
import { StyleEngine } from '../brain/styleEngine.js';
import { ReplyPlanner } from '../brain/replyPlanner.js';
import { ResponseGenerator } from '../brain/responseGenerator.js';
import { ResponseRanker } from '../brain/responseRanker.js';
import { RepetitionGuard } from '../brain/repetitionGuard.js';
import { isRefusal } from './modelRouter.js';
import type {
  BotReplyRecord,
  RankedReply,
  RepetitionCheck,
  ReplyPlan,
  SceneAnalysis,
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

/** Format retrieved knowledge into a compact, clearly-optional context block (or '' if none). */
function formatKnowledge(items: { topic: string; text: string }[]): string {
  if (items.length === 0) return '';
  return [
    'RELEVANT KNOWLEDGE (background you happen to know — use ONLY if it fits naturally, never force ' +
      'the topic, never info-dump, never list it):',
    ...items.map((k) => `- ${k.topic}: ${k.text}`),
  ].join('\n');
}

const FALLBACKS = [
  'almost repeated myself again. delete that thought, I am getting back on track.',
  'ok I was about to go full NPC. mental reset, give me a sec and I am back to being properly mean.',
  'wait no, I already did that joke. I deserve the ban myself.',
];

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
  private readonly generator: ResponseGenerator;
  private readonly ranker = new ResponseRanker();
  private readonly guard: RepetitionGuard;

  constructor(
    llm: LLMProvider,
    private readonly media: MediaProcessor,
    private readonly conversation: ConversationService,
    private readonly sceneAnalyzer: SceneAnalyzer,
    private readonly memoryRetriever: MemoryRetriever,
    private readonly config: AppConfig,
    private readonly grounding: GroundingService,
    private readonly heat: HeatService,
    private readonly knowledge: KnowledgeRetriever,
  ) {
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
    // Current voice is transcribed up-front (message handler); here we cover any remaining
    // current audio plus replied-to audio/video the user is asking about ("cosa ha detto").
    const audio = message.audioBuffer
      ? { buffer: message.audioBuffer, mime: message.audioMime ?? 'audio/ogg' }
      : message.repliedAudioBuffer
        ? { buffer: message.repliedAudioBuffer, mime: message.repliedAudioMime ?? 'audio/ogg' }
        : message.repliedVideoBuffer
          ? { buffer: message.repliedVideoBuffer, mime: 'video/mp4' }
          : null;
    if (audio) {
      voiceDescription = await this.media.transcribeVoice(audio.buffer, audio.mime, {
        fileName: 'media',
      });
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
  ): Promise<{ block: string; query: string; sources: string[] } | null> {
    if (!this.grounding.enabled) return null;
    const question = ctx.message.messageText || '';
    try {
      if (visual && this.grounding.wantsImageLookup(question)) {
        return await this.grounding.groundImage({
          imageBuffer: visual.buffer,
          imageMime: visual.mime,
          question,
          language: ctx.language,
        });
      }
      if (this.grounding.wantsWebSearch(question)) {
        const query = cleanQuery(question, ctx.botUsername);
        return await this.grounding.groundWeb(query, ctx.language);
      }
    } catch (err) {
      log.warn({ err }, 'grounding failed');
    }
    return null;
  }

  async generateReply(ctx: ReplyContext): Promise<ReplyOutcome> {
    // Resolve the visual once (photo or extracted video frame, current or replied) and reuse it
    // for both the image description and any reverse-image grounding.
    const visual = await this.resolveVisual(ctx.message);
    const { transcribed, visionCalls, transcriptionCalls } = await this.transcribe(
      ctx.message,
      visual,
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

    // 2. retrieve memory + (in parallel) grounding, on-demand knowledge, and update per-user heat
    const activeHandles = [...new Set(history.filter((m) => !m.isBot).map((m) => m.handle))];
    const [retrieved, grounding, knowledgeItems, heatValue] = await Promise.all([
      this.memoryRetriever.retrieve({
        chatId: ctx.context.chatId,
        currentMessage: ctx.message.messageText,
        scene,
        activeHandles,
        mentionedHandles: mentioned,
        repliedToHandle: ctx.context.repliedToUserHandle ?? null,
        nsfwEnabled: generationNsfwEnabled,
      }),
      this.ground(ctx, visual),
      this.knowledge.enabled
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
    const groundingBlock = grounding?.block;
    const hostility = this.heat.enabled ? this.heat.directive(heatValue) : null;
    const knowledgeBlock = formatKnowledge(knowledgeItems);

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
      ? `HOSTILITY toward ${addressee}: ${hostility.level} (${hostility.heat}/100) — ${hostility.instruction}`
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
      ...(groundingBlock ? { grounding: groundingBlock } : {}),
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
      log.debug({ reason: check.reason, attempt }, 'repetition block — regenerating');
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
      log.info('default model refused — backstop to NSFW model');
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
        ...(groundingBlock ? { grounding: groundingBlock } : {}),
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
    };
    if (imageUrl !== undefined) outcome.imageUrl = imageUrl;
    if (imageBuffer !== undefined) outcome.imageBuffer = imageBuffer;
    return outcome;
  }
}
