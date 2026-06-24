import type { AppConfig } from '../config/index.js';
import { Localizer } from '../config/index.js';
import type { ChatContext, Person } from '../domain/types.js';
import type { LLMProvider } from '../providers/llm/types.js';
import { MediaProcessor } from '../providers/media/index.js';
import { MusicService } from '../providers/media/music.js';
import { LinkMediaService } from './linkMedia.js';
import { TtsProvider } from '../providers/voice/tts.js';
import { SttProvider } from '../providers/voice/stt.js';
import { StableDiffusionGenerator } from '../providers/image/stableDiffusion.js';
import type { Storage } from '../storage/index.js';
import { Cooldown } from '../utils/rateLimit.js';
import { MemoryMiner } from '../memory/memoryMiner.js';
import { LoreEngine } from '../memory/loreEngine.js';
import { MemoryRetriever } from '../memory/memoryRetriever.js';
import { VectorMemoryRetriever } from '../memory/vectorRetriever.js';
import { createEmbedder, type Embedder } from '../rag/embedder.js';
import { SceneAnalyzer } from '../brain/sceneAnalyzer.js';
import { SearxngProvider } from '../search/searxng.js';
import { GroundingService } from '../search/groundingService.js';
import { PageScanner } from '../search/pageScanner.js';
import { HeatService } from './heat.js';
import { KnowledgeRetriever } from '../knowledge/knowledgeRetriever.js';
import { ImageFinder } from '../media/imageFinder.js';
import { NewsService } from '../news/newsService.js';
import { AutonomousPoster } from './autonomousPoster.js';
import { GeneratedImagePoster } from './generatedImagePoster.js';
import { ImagePromptService } from './imagePrompt.js';
import { AutoEngageScorer } from './autoengage.js';
import { BanService } from './bans.js';
import { ModelRouter } from './modelRouter.js';
import { ConversationService } from './conversation.js';
import { FactService } from './facts.js';
import { ModeService } from './modes.js';
import { PermissionService } from './permissions.js';
import { AccessService } from './access.js';
import { ReplyService } from './reply.js';
import { TermsService } from './terms.js';
import { UsageService } from './usage.js';
import { GroupQuotaService } from './groupQuota.js';
import type { QuotaPlan, QuotaPlanId } from '../quota/plans.js';

export * from './permissions.js';
export * from './terms.js';
export * from './bans.js';
export * from './modes.js';
export * from './facts.js';
export * from './usage.js';
export * from './conversation.js';
export * from './autoengage.js';
export * from './reply.js';
export * from './modelRouter.js';
export * from './groupQuota.js';

/**
 * Service container. Built once at boot and shared by all handlers. Holds every domain service
 * plus the localizer and the LLM/media providers. `initializeContext` mirrors the original
 * per-request bootstrap (create chat, seed modes, upsert user, ensure usage).
 */
export class Services {
  readonly localizer: Localizer;
  readonly permissions: PermissionService;
  readonly access: AccessService;
  readonly terms: TermsService;
  readonly bans: BanService;
  readonly modes: ModeService;
  readonly facts: FactService;
  readonly usage: UsageService;
  readonly quota: GroupQuotaService;
  readonly conversation: ConversationService;
  readonly autoengage: AutoEngageScorer;
  readonly reply: ReplyService;
  readonly media: MediaProcessor;
  readonly music: MusicService;
  readonly linkMedia: LinkMediaService;
  readonly tts: TtsProvider;
  readonly stt: SttProvider;
  readonly modelRouter: ModelRouter;
  readonly lore: LoreEngine;
  readonly scene: SceneAnalyzer;
  readonly embedder: Embedder;
  readonly memoryRetriever: MemoryRetriever | VectorMemoryRetriever;
  readonly grounding: GroundingService;
  readonly heat: HeatService;
  readonly knowledge: KnowledgeRetriever;
  readonly imageFinder: ImageFinder;
  readonly news: NewsService;
  readonly autonomousPoster: AutonomousPoster;
  readonly generatedImagePoster: GeneratedImagePoster;
  readonly imagePrompts: ImagePromptService;
  /** per-user, per-chat anti-spam cooldown for command invocations */
  readonly commandRateLimit: Cooldown;

  constructor(
    readonly config: AppConfig,
    readonly storage: Storage,
    readonly llm: LLMProvider,
  ) {
    const env = config.env;
    this.localizer = new Localizer(env.DEFAULT_LANGUAGE);
    this.tts = new TtsProvider(config.voice.tts);
    this.stt = new SttProvider(config.voice.stt);
    const imageGenerator = new StableDiffusionGenerator(config.stableDiffusion);
    this.media = new MediaProcessor(
      llm,
      this.stt,
      {
        bin: config.voice.stt.ffmpegBin,
        available: config.voice.tts.ffmpegAvailable,
        timeoutMs: config.voice.stt.timeoutMs,
      },
      imageGenerator,
    );
    this.music = new MusicService(config.music);
    this.quota = new GroupQuotaService(storage);
    this.linkMedia = new LinkMediaService(config.linkMedia, storage, this.media, this.quota);
    this.permissions = new PermissionService(storage, env.ALLOWED_HANDLES, env.ADMIN_HANDLES);
    this.access = new AccessService(
      env.APPROVED_STORE_PATH,
      env.APPROVED_CHATS,
      env.APPROVED_USERS,
    );
    this.terms = new TermsService(storage);
    this.bans = new BanService(storage, env.DEFAULT_BAN_SECONDS);
    this.modes = new ModeService(storage);
    this.facts = new FactService(storage);
    this.usage = new UsageService(storage);
    this.conversation = new ConversationService(storage, env.MAX_CONTEXT_MESSAGES);
    this.autoengage = new AutoEngageScorer(llm, {
      maxRepliesPerChatPerHour: env.MAX_REPLIES_PER_CHAT_PER_HOUR,
      chatCooldownSeconds: env.AUTOENGAGE_MIN_COOLDOWN_SECONDS,
      userCooldownSeconds: env.AUTOENGAGE_USER_COOLDOWN_SECONDS,
      minConfidence: env.AUTOENGAGE_MIN_CONFIDENCE,
    });
    this.modelRouter = new ModelRouter({
      defaultModel: config.llm.model,
      nsfwModel: config.llm.nsfwModel,
      extraLexicon: env.LLM_NSFW_LEXICON,
      refusalFallback: env.LLM_REFUSAL_FALLBACK,
      refusalBufferChars: env.LLM_REFUSAL_BUFFER_CHARS,
    });
    this.commandRateLimit = new Cooldown(env.COMMAND_RATE_LIMIT_SECONDS * 1000);
    this.embedder = createEmbedder(llm, config.embeddings);
    const miner = new MemoryMiner(llm, {
      model: config.brain.memoryModel,
      temperature: env.MEMORY_TEMPERATURE,
      maxCandidates: env.MEMORY_MAX_CANDIDATES_PER_RUN,
      minSalience: env.MEMORY_MIN_SALIENCE,
    });
    this.lore = new LoreEngine(storage, miner);
    this.scene = new SceneAnalyzer(llm, {
      model: config.brain.sceneModel,
      temperature: env.SCENE_TEMPERATURE,
    });
    const memoryRetrieverConfig = {
      maxItems: env.MEMORY_MAX_ITEMS_PER_REPLY,
      maxExplicitCallbacks: env.MEMORY_MAX_EXPLICIT_CALLBACKS_PER_REPLY,
      itemCooldownMinutes: env.MEMORY_ITEM_COOLDOWN_MINUTES,
      subjectCooldownMinutes: env.MEMORY_SUBJECT_COOLDOWN_MINUTES,
    };
    this.memoryRetriever = this.embedder.enabled
      ? new VectorMemoryRetriever(storage, this.embedder, {
          ...memoryRetrieverConfig,
          embeddingDim: config.embeddings.dim,
          minScore: config.embeddings.minScore,
        })
      : new MemoryRetriever(storage, memoryRetrieverConfig);
    const searxng = new SearxngProvider({
      enabled: config.search.webEnabled,
      baseUrl: config.search.searxngUrl,
      timeoutMs: config.search.timeoutMs,
      maxResults: config.search.maxResults,
    });
    const pageScanner = new PageScanner({
      timeoutMs: Math.min(10_000, Math.max(3_000, config.search.timeoutMs)),
      maxBytes: 512_000,
      userAgent: config.linkMedia.userAgent,
    });
    this.grounding = new GroundingService(
      searxng,
      this.media,
      {
        webEnabled: config.search.webEnabled,
        imageEnabled: config.search.imageEnabled,
        maxResults: config.search.maxResults,
      },
      pageScanner,
      this.quota,
    );
    this.imageFinder = new ImageFinder(searxng, this.media, config.auto.imageQueryPool);
    this.news = new NewsService(
      config.auto.rssFeeds,
      config.search.timeoutMs,
      config.auto.newsMaxAgeHours,
      this.embedder,
      { topK: config.embeddings.newsTopK, minScore: config.embeddings.minScore },
    );
    this.autonomousPoster = new AutonomousPoster(
      llm,
      this.news,
      this.imageFinder,
      config,
      storage,
      this.lore,
      this.quota,
    );
    this.generatedImagePoster = new GeneratedImagePoster(
      this.media,
      config,
      storage,
      this.quota,
      this.localizer,
    );
    this.imagePrompts = new ImagePromptService(llm, config);
    this.heat = new HeatService(storage.userHeat, {
      enabled: env.HEAT_ENABLED,
      baseline: env.HEAT_BASELINE,
      max: env.HEAT_MAX,
      decayPerMinute: env.HEAT_DECAY_PER_MINUTE,
    });
    this.knowledge = new KnowledgeRetriever(
      storage,
      {
        enabled: env.KNOWLEDGE_ENABLED,
        maxItems: config.embeddings.knowledgeTopK || env.KNOWLEDGE_MAX_ITEMS,
        embeddingDim: config.embeddings.dim,
        minScore: config.embeddings.minScore,
      },
      this.embedder,
    );
    this.reply = new ReplyService(
      llm,
      this.media,
      this.music,
      this.tts,
      this.conversation,
      this.scene,
      this.memoryRetriever,
      config,
      this.grounding,
      this.heat,
      this.knowledge,
      this.imageFinder,
      this.news,
      this.autonomousPoster,
      this.imagePrompts,
      this.quota,
      this.localizer,
    );
  }

  /** Ensure baseline records exist for this person/chat. Idempotent; runs before each handler. */
  async initializeContext(person: Person, context: ChatContext): Promise<void> {
    const env = this.config.env;
    await this.storage.chats.createIfNotExists(context.chatId, context.chatName, {
      language: env.DEFAULT_LANGUAGE,
      conversationTracker: env.CONVERSATION_TRACKER_DEFAULT_ENABLED,
      autoFact: env.AUTOFACT_DEFAULT_ENABLED,
      autoengage: env.AUTOENGAGE_DEFAULT_ENABLED,
      autopost: env.AUTOPOST_DEFAULT_ENABLED,
      nsfwMode: env.LLM_NSFW_DEFAULT_MODE,
    });
    await Promise.all([
      this.modes.seedDefaults(context.chatId),
      this.storage.users.upsertFromPerson(person),
      this.storage.chatMembers.touch(context.chatId, person),
      this.usage.ensure(person.userHandle),
    ]);
  }

  getLanguage(chatId: number): Promise<string> {
    return this.storage.chats.getLanguage(chatId, this.config.env.DEFAULT_LANGUAGE);
  }

  /** Free groups are always pinned to the economy model, including internal brain stages. */
  modelForPlan(plan: Pick<QuotaPlan, 'id'>, requestedModel?: string): string | undefined {
    return plan.id === 'free' ? this.config.env.FREE_LLM_MODEL : requestedModel;
  }

  async planForChat(chatId: number): Promise<QuotaPlan> {
    return (await this.quota.getReport(chatId)).plan;
  }

  async modelForChat(chatId: number, requestedModel?: string): Promise<string | undefined> {
    return this.modelForPlan(await this.planForChat(chatId), requestedModel);
  }

  isFreePlan(plan: Pick<QuotaPlan, 'id'> | QuotaPlanId): boolean {
    return (typeof plan === 'string' ? plan : plan.id) === 'free';
  }

  /** True if the user/chat may use the model, media generation and link-media (admin/approved). */
  isApproved(person: Person, context: ChatContext): boolean {
    const isAdmin = this.permissions.isBotAdmin(person.userHandle);
    return this.access.isApproved(person, context, isAdmin);
  }

  /** First configured bot-admin handle, shown to users who must request approval. */
  adminContact(): string {
    return this.config.env.ADMIN_HANDLES?.[0] ?? 'the admin';
  }
}
