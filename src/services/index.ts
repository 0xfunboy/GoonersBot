import type { AppConfig } from '../config/index.js';
import { Localizer } from '../config/index.js';
import type { Api } from 'grammy';
import type { ChatContext, Person } from '../domain/types.js';
import type { LLMProvider } from '../providers/llm/types.js';
import { MediaProcessor } from '../providers/media/index.js';
import { MusicService } from '../providers/media/music.js';
import { LinkMediaService } from './linkMedia.js';
import { TtsProvider } from '../providers/voice/tts.js';
import { SttProvider } from '../providers/voice/stt.js';
import { StableDiffusionGenerator } from '../providers/image/stableDiffusion.js';
import { AgnesVideoGenerator } from '../providers/video/agnes.js';
import type { Storage } from '../storage/index.js';
import { Cooldown } from '../utils/rateLimit.js';
import { MemoryMiner } from '../memory/memoryMiner.js';
import { LoreEngine } from '../memory/loreEngine.js';
import { MemoryRetriever } from '../memory/memoryRetriever.js';
import { VectorMemoryRetriever } from '../memory/vectorRetriever.js';
import { createEmbedder, type Embedder } from '../rag/embedder.js';
import { SceneAnalyzer } from '../brain/sceneAnalyzer.js';
import { NativeMetaSearch } from '../search/index.js';
import { AnilistProvider } from '../anime/providers/anilist.js';
import { JikanEnricher } from '../anime/providers/jikan.js';
import { AnimeCatalogService } from '../anime/catalogService.js';
import { AnimeFollowService } from '../anime/followService.js';
import { AnimeKnowledgeService } from '../anime/knowledgeService.js';
import {
  AnimeArchiveService,
  AnimeArchiveWorker,
  createDefaultAnimeSourceRegistry,
} from '../anime/archive/index.js';
import { SocialStandingService } from '../social/standingService.js';
import { AmbientRetriever } from '../ambient/retriever.js';
import { AnimeAmbientProvider } from '../ambient/providers/animeAmbient.js';
import { WikipediaAmbientProvider } from '../ambient/providers/wikipediaAmbient.js';
import { NewsAmbientProvider } from '../ambient/providers/curatedAmbient.js';
import { GroundingService } from '../search/groundingService.js';
import { PageScanner } from '../search/pageScanner.js';
import { HeatService } from './heat.js';
import { KnowledgeRetriever } from '../knowledge/knowledgeRetriever.js';
import { ImageFinder } from '../media/imageFinder.js';
import { NewsService } from '../news/newsService.js';
import { AutonomousPoster } from './autonomousPoster.js';
import { GeneratedImagePoster } from './generatedImagePoster.js';
import { ImagePromptService } from './imagePrompt.js';
import { VideoPromptService } from './videoPrompt.js';
import { AgentRuntime } from './agentRuntime.js';
import { AutoEngageScorer } from './autoengage.js';
import { BanService } from './bans.js';
import { ModelRouter } from './modelRouter.js';
import { ConversationService } from './conversation.js';
import { ModeService } from './modes.js';
import { PermissionService } from './permissions.js';
import { AccessService } from './access.js';
import { ReplyService } from './reply.js';
import { TermsService } from './terms.js';
import { UsageService } from './usage.js';
import { GroupQuotaService } from './groupQuota.js';
import { SystemInfoService } from './systemInfo.js';
import { SelfKnowledgeService } from './selfKnowledge.js';
import { QUOTA_PLANS, type QuotaPlan, type QuotaPlanId } from '../quota/plans.js';
import { ConversationThreadTracker } from './threadTracker.js';
import { DocumentProcessor } from '../documents/documentProcessor.js';
import { CapabilityForge } from '../capabilities/forge.js';
import { LocalDevelopmentService } from '../capabilities/localDevelopmentService.js';
import {
  SocialLearningPipeline,
  SocialObservationMiner,
  SocialProfileEngine,
  SocialQuestionService,
} from '../social/index.js';
import {
  capabilitySnapshot,
  type BuiltinCapabilityId,
  type CapabilityReadiness,
  type RuntimeCapabilitySnapshotItem,
} from '../companion/capabilities/catalog.js';
import { ExistingVisibleWorkReader } from '../companion/context/visibleWork.js';
import { CompanionWorkService } from './companionWork.js';
import { deliverCompanionLink } from './companionLinkTransport.js';
import {
  IntegrationService,
  TelegramConnector,
  parseTelegramRecipient,
} from '../integrations/index.js';
import { CompanionArtifactStore } from '../companion/artifacts/store.js';
import type { ReminderService } from '../companion/workflows/index.js';

export * from './permissions.js';
export * from './terms.js';
export * from './bans.js';
export * from './modes.js';
export * from './usage.js';
export * from './conversation.js';
export * from './autoengage.js';
export * from './reply.js';
export * from './modelRouter.js';
export * from './groupQuota.js';
export * from './systemInfo.js';
export * from './selfKnowledge.js';
export * from '../anime/index.js';
export * from '../ambient/index.js';
export * from '../capabilities/localDevelopmentService.js';

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
  readonly usage: UsageService;
  readonly quota: GroupQuotaService;
  readonly systemInfo: SystemInfoService;
  readonly selfKnowledge: SelfKnowledgeService;
  readonly threadTracker: ConversationThreadTracker;
  readonly conversation: ConversationService;
  readonly autoengage: AutoEngageScorer;
  readonly reply: ReplyService;
  readonly media: MediaProcessor;
  readonly music: MusicService;
  /** remote text-to-video (Agnes); rate limited to one clip per minute upstream */
  readonly video: AgnesVideoGenerator;
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
  readonly animeCatalog: AnimeCatalogService;
  readonly animeFollows: AnimeFollowService;
  readonly anime: AnimeKnowledgeService;
  readonly animeArchive: AnimeArchiveService;
  private readonly animeArchiveWorker: AnimeArchiveWorker;
  readonly ambient: AmbientRetriever;
  readonly standing: SocialStandingService;
  readonly imageFinder: ImageFinder;
  readonly news: NewsService;
  readonly autonomousPoster: AutonomousPoster;
  readonly generatedImagePoster: GeneratedImagePoster;
  readonly imagePrompts: ImagePromptService;
  readonly videoPrompts: VideoPromptService;
  readonly agentRuntime: AgentRuntime;
  readonly companionWork: CompanionWorkService;
  integrations?: IntegrationService;
  readonly workflows?: ReminderService;
  private companionApi?: Api;
  readonly social: SocialProfileEngine;
  readonly socialQuestions: SocialQuestionService;
  readonly socialLearning: SocialLearningPipeline;
  readonly documents: DocumentProcessor;
  readonly capabilities: CapabilityForge;
  readonly localDevelopment: LocalDevelopmentService;
  /** per-user, per-chat anti-spam cooldown for command invocations */
  readonly commandRateLimit: Cooldown;

  constructor(
    readonly config: AppConfig,
    readonly storage: Storage,
    readonly llm: LLMProvider,
    readonly miningLlm: LLMProvider,
  ) {
    const env = config.env;
    this.localizer = new Localizer(env.DEFAULT_LANGUAGE);
    this.documents = new DocumentProcessor({
      enabled: env.DOCUMENTS_ENABLED,
      maxCharsPerFile: env.DOCUMENT_MAX_CHARS_PER_FILE,
      maxFilesPerTurn: env.DOCUMENT_MAX_FILES_PER_TURN,
      ocr: {
        enabled: env.DOCUMENT_OCR_ENABLED,
        tesseractCommand: env.DOCUMENT_TESSERACT_COMMAND,
        pdfRendererCommand: env.DOCUMENT_PDFTOPPM_COMMAND,
        language: env.DOCUMENT_OCR_LANGUAGE,
        maxPages: 5,
      },
    });
    this.tts = new TtsProvider(config.voice.tts);
    this.stt = new SttProvider(config.voice.stt);
    const imageGenerator = new StableDiffusionGenerator(config.stableDiffusion);
    this.video = new AgnesVideoGenerator(config.agnes.video);
    this.media = new MediaProcessor(
      llm,
      this.stt,
      {
        bin: config.voice.stt.ffmpegBin,
        available: config.voice.tts.ffmpegAvailable,
        timeoutMs: config.voice.stt.timeoutMs,
      },
      imageGenerator,
      {
        enabled: env.IMAGE_GENERATION_QA_ENABLED,
        minScore: env.IMAGE_GENERATION_QA_MIN_SCORE,
        maxRetries: env.IMAGE_GENERATION_QA_MAX_RETRIES,
      },
    );
    this.music = new MusicService(config.music);
    this.quota = new GroupQuotaService(storage);
    const archiveConfig = {
      ...config.animeArchive,
      enabled: config.animeArchive.enabled && config.linkMedia.ffmpegAvailable,
      bulkEnabled:
        config.animeArchive.bulkEnabled &&
        config.linkMedia.ffmpegAvailable &&
        config.animeArchive.bulkConcurrency === 1,
    };
    const archiveRegistry = createDefaultAnimeSourceRegistry({
      timeoutMs: Math.min(15_000, archiveConfig.timeoutMs),
      maxResponseBytes: 2 * 1024 * 1024,
      userAgent: config.linkMedia.userAgent,
    });
    this.animeArchiveWorker = new AnimeArchiveWorker(
      archiveConfig,
      config.linkMedia,
      storage,
      this.quota,
      archiveRegistry,
    );
    this.animeArchive = new AnimeArchiveService(
      { animeArchive: archiveConfig, linkMedia: config.linkMedia },
      storage,
      this.quota,
      archiveRegistry,
      () => this.animeArchiveWorker.kick(),
    );
    this.systemInfo = new SystemInfoService(config, this.quota);
    this.linkMedia = new LinkMediaService(config.linkMedia, storage, this.media, this.quota);
    this.permissions = new PermissionService(
      storage,
      env.ALLOWED_HANDLES,
      env.ADMIN_HANDLES,
      env.CAPABILITY_LOCAL_DEVELOPMENT_ADMIN_IDS,
    );
    this.access = new AccessService(
      env.APPROVED_STORE_PATH,
      env.APPROVED_CHATS,
      env.APPROVED_USERS,
    );
    this.terms = new TermsService(storage, async (actorId) => {
      await this.companionWork.eraseActor(actorId);
      await this.workflows?.revokeActor(actorId);
      await this.integrations?.eraseOwner(actorId);
    });
    this.bans = new BanService(storage, env.DEFAULT_BAN_SECONDS);
    this.modes = new ModeService(storage);
    this.usage = new UsageService(storage);
    this.conversation = new ConversationService(storage, env.MAX_CONTEXT_MESSAGES);
    this.autoengage = new AutoEngageScorer(llm, {
      maxRepliesPerChatPerHour: env.MAX_REPLIES_PER_CHAT_PER_HOUR,
      chatCooldownSeconds: env.AUTOENGAGE_MIN_COOLDOWN_SECONDS,
      userCooldownSeconds: env.AUTOENGAGE_USER_COOLDOWN_SECONDS,
      model: env.AUTOENGAGE_MODEL,
      maxTokens: env.AUTOENGAGE_MAX_TOKENS,
      minConfidence: env.AUTOENGAGE_MIN_CONFIDENCE,
      knownTopicBonus: config.ambient.autoengageBonus,
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
    this.threadTracker = new ConversationThreadTracker(storage, this.embedder, {
      enabled: env.THREAD_STATE_ENABLED,
      ttlDays: env.THREAD_STATE_TTL_DAYS,
      maxActive: env.THREAD_STATE_MAX_ACTIVE,
      embeddingDim: config.embeddings.dim,
    });
    const miner = new MemoryMiner(miningLlm, {
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
    const nativeSearch = new NativeMetaSearch({
      enabled: config.search.webEnabled,
      searxngUrl: config.search.searxngUrl,
      timeoutMs: config.search.timeoutMs,
      maxResults: config.search.maxResults,
    });
    const pageScanner = new PageScanner({
      timeoutMs: Math.min(10_000, Math.max(3_000, config.search.timeoutMs)),
      maxBytes: 512_000,
      userAgent: config.linkMedia.userAgent,
    });
    this.grounding = new GroundingService(
      nativeSearch,
      this.media,
      {
        webEnabled: config.search.webEnabled,
        imageEnabled: config.search.imageEnabled,
        maxResults: config.search.maxResults,
      },
      pageScanner,
      this.quota,
    );
    this.capabilities = new CapabilityForge(llm, this.grounding, {
      enabled: env.CAPABILITY_FORGE_ENABLED,
      storePath: env.CAPABILITY_STORE_PATH,
      autoInstallResearch: env.CAPABILITY_AUTO_INSTALL_RESEARCH,
    });
    this.selfKnowledge = new SelfKnowledgeService(config, storage, this.capabilities, () =>
      this.runtimeCapabilitySnapshot(),
    );
    this.localDevelopment = LocalDevelopmentService.create(
      {
        enabled: env.CAPABILITY_LOCAL_DEVELOPMENT_ENABLED,
        repositoryPath: process.cwd(),
        storePath: env.CAPABILITY_LOCAL_DEVELOPMENT_STORE_PATH,
        adminTelegramIds: env.CAPABILITY_LOCAL_DEVELOPMENT_ADMIN_IDS,
        plannerModel: env.CAPABILITY_LOCAL_DEVELOPMENT_PLANNER_MODEL,
        coderModel: env.CAPABILITY_LOCAL_DEVELOPMENT_CODER_MODEL,
        reviewModel: env.CAPABILITY_LOCAL_DEVELOPMENT_REVIEW_MODEL,
        maxAttempts: env.CAPABILITY_LOCAL_DEVELOPMENT_MAX_ATTEMPTS,
        jobTimeoutMs: env.CAPABILITY_LOCAL_DEVELOPMENT_JOB_TIMEOUT_MS,
        bubblewrapBin: '/usr/bin/bwrap',
      },
      llm,
    );
    this.imageFinder = new ImageFinder(nativeSearch, this.media, config.auto.imageQueryPool);
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
    this.imagePrompts = new ImagePromptService(llm, config);
    this.generatedImagePoster = new GeneratedImagePoster(
      this.media,
      this.imagePrompts,
      config,
      storage,
      this.quota,
      this.localizer,
      this.imageFinder,
    );
    this.videoPrompts = new VideoPromptService(llm, config);
    this.social = new SocialProfileEngine(storage.socialProfiles);
    this.socialQuestions = new SocialQuestionService(llm, storage.socialQuestions, this.social, {
      enabled: env.SOCIAL_QUESTIONS_ENABLED,
      curiosityProbability: env.SOCIAL_QUESTION_CURIOSITY_PROBABILITY,
      userCooldownMinutes: env.SOCIAL_QUESTION_USER_COOLDOWN_MINUTES,
      ttlMinutes: env.SOCIAL_QUESTION_TTL_MINUTES,
      unquotedAnswerWindowMinutes: env.SOCIAL_QUESTION_UNQUOTED_ANSWER_WINDOW_MINUTES,
      model: config.brain.cortex.model,
    });
    this.socialLearning = new SocialLearningPipeline(
      this.social,
      new SocialObservationMiner(miningLlm, {
        temperature: Math.min(0.12, env.MEMORY_TEMPERATURE),
        maxObservations: env.MEMORY_MAX_CANDIDATES_PER_RUN,
      }),
    );
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
    this.animeCatalog = new AnimeCatalogService(config.anime, {
      storage,
      provider: new AnilistProvider({
        enabled: config.anime.enabled,
        apiUrl: config.anime.anilistUrl,
        timeoutMs: config.anime.timeoutMs,
        maxResponseBytes: config.anime.maxResponseBytes,
      }),
      enricher: new JikanEnricher({
        enabled: config.anime.enabled && config.anime.enrichmentEnabled,
        apiUrl: config.anime.jikanUrl,
        timeoutMs: config.anime.timeoutMs,
        maxResponseBytes: config.anime.maxResponseBytes,
      }),
      search: nativeSearch,
    });
    this.animeFollows = new AnimeFollowService(config.anime, storage, this.animeCatalog);
    this.anime = new AnimeKnowledgeService(config.anime, this.animeCatalog, this.animeFollows);
    // Ambient recall sits after the services it wraps: it never owns a data source, it only asks
    // the existing ones whether they recognise what is being discussed.
    // The curated knowledge base is deliberately absent: `knowledge_rag` already retrieves it and
    // `reply.ts` joins both into the same prompt slot, so registering it here would pay for a
    // second embedding pass and print every matching entry twice inside one reply.
    this.standing = new SocialStandingService(storage, { enabled: config.standing.enabled });
    this.ambient = new AmbientRetriever(
      config.ambient,
      [
        new AnimeAmbientProvider(this.animeCatalog),
        new WikipediaAmbientProvider(storage, config.ambient.wikipedia),
        new NewsAmbientProvider(this.news),
      ],
      storage,
    );
    if (env.COMPANION_TASKS_ENABLED) {
      this.workflows = storage.createReminderService({
        observe: async (workflow, signal) => {
          const urls = workflow.sourceUrls ?? [];
          if (!urls.length) throw new Error('No public sources configured');
          const pages = await pageScanner.scan(urls, signal);
          if (pages.length !== urls.length)
            throw new Error('Not all monitored sources could be read; baseline unchanged');
          return {
            sources: pages.map((page) => ({
              url: page.requestedUrl ?? page.url,
              title: page.title,
              text: page.text,
            })),
          };
        },
        authorize: async (scope) => {
          const user = await storage.users.getByTelegramId(scope.actorTelegramId);
          if (
            !user ||
            !(await this.terms.hasAccepted(user.handle)) ||
            !(await this.conversation.isStarted(scope.chatId))
          )
            return false;
          const person = { telegramId: scope.actorTelegramId, userHandle: user.handle };
          const context = {
            chatId: scope.chatId,
            isGroup: scope.chatId < 0,
            isBotMentioned: true,
            isGroupAdmin: false,
            isReplyToBot: false,
          };
          return (
            this.access.isApproved(person, context, this.permissions.isBotAdminPerson(person)) &&
            (await this.permissions.checkAll(['allowed_user', 'not_banned'], person, context))
          );
        },
        send: async (reminder, signal) => {
          if (!this.companionApi) throw new Error('Telegram transport unavailable');
          const sent = await this.companionApi.sendMessage(
            reminder.scope.chatId,
            reminder.text,
            {
              ...(reminder.scope.threadId !== undefined
                ? { message_thread_id: reminder.scope.threadId }
                : {}),
            },
            signal as Parameters<Api['sendMessage']>[3],
          );
          return { messageId: sent.message_id };
        },
      });
    }
    this.agentRuntime = new AgentRuntime({
      config,
      llm,
      media: this.media,
      music: this.music,
      video: this.video,
      tts: this.tts,
      grounding: this.grounding,
      knowledge: this.knowledge,
      imageFinder: this.imageFinder,
      imagePrompts: this.imagePrompts,
      videoPrompts: this.videoPrompts,
      quota: this.quota,
      capabilities: this.capabilities,
      anime: this.anime,
      animeArchive: this.animeArchive,
      news: this.news,
      companionMemory: storage.companionMemory,
      integrations: () => this.integrations,
      localDevelopment: this.localDevelopment,
      ...(this.workflows ? { workflows: this.workflows } : {}),
    });
    this.companionWork = new CompanionWorkService({
      repository: storage.companionTasks,
      runtime: this.agentRuntime,
      artifacts: new CompanionArtifactStore(env.COMPANION_ARTIFACTS_PATH),
      enabled: env.COMPANION_TASKS_ENABLED,
      concurrency: env.COMPANION_TASK_CONCURRENCY,
      extractDocuments: async (files) =>
        this.documents.formatForPrompt(await this.documents.extractAll(files)),
      deliverLink: async (input, url, task, authorize) => {
        if (!this.companionApi) throw new Error('Telegram transport unavailable');
        return deliverCompanionLink(this.companionApi, this.linkMedia, input, url, task, authorize);
      },
      authorize: async (input) => {
        const current = await storage.users.getByTelegramId(input.person.telegramId);
        const person = { ...input.person, userHandle: current?.handle ?? input.person.userHandle };
        return Boolean(
          (!input.quotaBypass || this.bypassesGroupPlan(person, input.context)) &&
          (await this.terms.hasAccepted(person.userHandle)) &&
          (await this.permissions.checkAll(
            ['allowed_user', 'not_banned'],
            person,
            input.context,
          )) &&
          (await this.conversation.isStarted(input.context.chatId)) &&
          this.access.isApproved(person, input.context, this.permissions.isBotAdminPerson(person)),
        );
      },
      recordUsage: async (input, usage, media) => {
        await this.usage.record({
          handle: input.person.userHandle,
          chatId: input.context.chatId,
          provider: llm.name,
          model: input.model ?? config.brain.replyModel ?? null,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedTokens: usage.estimated ? usage.inputTokens + usage.outputTokens : 0,
          imageCalls: media?.imageCalls ?? 0,
          visionCalls: media?.visionCalls ?? 0,
          transcriptionCalls: 0,
          points: usage.inputTokens + usage.outputTokens + (media?.imageCalls ?? 0) * 100,
          costEstimate: 0,
        });
        if (!input.quotaBypass)
          await this.quota.recordLlmTokens(
            input.context.chatId,
            usage.inputTokens + usage.outputTokens,
          );
      },
      remember: async (input, text, messageIds, work) => {
        await this.conversation.addBotMessage(
          input.context.chatId,
          {
            messageText: text,
            timestamp: new Date(),
            imageDescription: null,
            voiceDescription: null,
          },
          {
            telegramTopicId: input.context.threadId ?? null,
            ...(messageIds[0] ? { messageId: messageIds[0] } : {}),
            ...(input.context.messageId ? { repliedToMessageId: input.context.messageId } : {}),
          },
        );
        if (work && text.trim())
          await storage.companionMemory.execute(
            {
              ownerTelegramId: input.person.telegramId,
              chatId: input.context.chatId,
              telegramTopicId: input.context.threadId ?? null,
            },
            {
              operation: 'remember',
              kind: 'operational',
              text: `${input.request.slice(0, 500)}\nEsito operativo (non biografia): ${text.slice(0, 1800)}`,
            },
            {
              source: 'task',
              taskId: work.taskId,
              artifactIds: work.artifactIds,
              requestKey: `task:${work.taskId}`,
              sourceAt: input.requestTime ? new Date(input.requestTime) : new Date(),
            },
          );
      },
    });
    const legacyWork = new ExistingVisibleWorkReader(storage, this.localDevelopment);
    this.reply = new ReplyService(
      llm,
      this.media,
      this.music,
      this.video,
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
      this.threadTracker,
      this.documents,
      this.capabilities,
      this.videoPrompts,
      this.agentRuntime,
      this.social,
      this.socialQuestions,
      this.anime,
      this.ambient,
      this.standing,
      this.selfKnowledge,
      {
        control: (understanding, person, context, language) =>
          legacyWork.control(understanding, person, context, language),
        listVisible: async (query) => {
          const [legacy, companion] = await Promise.all([
            legacyWork.listVisible(query),
            this.companionWork.listVisible(query),
          ]);
          return [...companion, ...legacy]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, query.limit ?? 12);
        },
      },
      this.companionWork,
      storage.companionMemory,
    );
  }

  /** Ensure baseline records exist for this person/chat. Idempotent; runs before each handler. */
  async initializeContext(person: Person, context: ChatContext): Promise<void> {
    const env = this.config.env;
    await this.storage.chats.createIfNotExists(context.chatId, context.chatName, {
      language: env.DEFAULT_LANGUAGE,
      conversationTracker: env.CONVERSATION_TRACKER_DEFAULT_ENABLED,
      autoengage: env.AUTOENGAGE_DEFAULT_ENABLED,
      autopost: env.AUTOPOST_DEFAULT_ENABLED,
      nsfwMode: env.LLM_NSFW_DEFAULT_MODE,
    });
    await this.modes.seedDefaults(context.chatId);
    // The adapter calls this method before the terms gate so it can render /tos in a fresh chat.
    // Do not create personal rows or recreate a declined user's erased social profile until the
    // person has explicitly accepted.
    if (!(await this.terms.hasAccepted(person.userHandle))) return;
    await Promise.all([
      this.storage.users.upsertFromPerson(person),
      this.storage.chatMembers.touch(context.chatId, person),
      this.permissions.refreshBotAdminIdentity(person),
      this.usage.ensure(person.userHandle),
      this.social.recordPresence({
        chatId: context.chatId,
        handle: person.userHandle,
        telegramId: person.telegramId,
        displayName:
          [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || undefined,
        alias: person.firstName,
      }),
    ]);
  }

  getLanguage(chatId: number): Promise<string> {
    return this.storage.chats.getLanguage(chatId, this.config.env.DEFAULT_LANGUAGE);
  }

  /** Provider-level readiness used by /capabilities and runtime-grounded self-knowledge. */
  runtimeCapabilitySnapshot(checkedAt = new Date()): RuntimeCapabilitySnapshotItem[] {
    const ready = (
      enabled: boolean,
      reason: string,
    ): { state: CapabilityReadiness; reason?: string } =>
      enabled ? { state: 'ready' } : { state: 'needs_configuration', reason };
    const states: Partial<
      Record<BuiltinCapabilityId, { state: CapabilityReadiness; reason?: string }>
    > = {
      group_rag: { state: 'ready' },
      knowledge_rag: ready(this.knowledge.enabled, 'knowledge index disabled'),
      anime_knowledge: ready(this.anime.enabled, 'anime catalog disabled'),
      anime_archive: ready(this.animeArchive.enabled, 'anime archive disabled'),
      web_search: ready(this.grounding.enabled, 'web grounding disabled'),
      page_scan: ready(this.grounding.pageAuditEnabled, 'page audit disabled'),
      news: ready(this.news.enabled, 'news feeds not configured'),
      image_lookup: ready(this.grounding.enabled, 'vision/web grounding unavailable'),
      document_read: { state: 'ready' },
      document_create: ready(this.llm.capabilities.chat, 'chat model unavailable'),
      workflow: ready(Boolean(this.workflows), 'persistent schedules disabled'),
      companion_memory: { state: 'ready' },
      connected_service: ready(Boolean(this.integrations), 'Telegram connection not attached'),
      code_work: ready(
        this.llm.capabilities.chat,
        'public repository reviewer unavailable; local execution requires configured workspace',
      ),
      data_analysis: { state: 'ready' },
      media_prompt: ready(
        this.media.canGenerateImage || this.video.enabled,
        'no media generator configured',
      ),
      image_gen: ready(this.media.canGenerateImage, 'image provider disabled'),
      video_gen: ready(this.video.enabled, 'video provider disabled'),
      music: ready(this.music.enabled, 'music provider disabled'),
      link_media: ready(this.config.linkMedia.enabled, 'link-media disabled'),
      translate: ready(this.llm.capabilities.chat, 'chat model unavailable'),
      tts: ready(this.tts.enabled, 'TTS provider disabled'),
      capability_forge: ready(this.capabilities.enabled, 'Capability Forge disabled'),
    };
    return capabilitySnapshot(states, checkedAt);
  }

  /** Free groups are always pinned to the economy model, including internal brain stages. */
  modelForPlan(plan: Pick<QuotaPlan, 'id'>, requestedModel?: string): string | undefined {
    return plan.id === 'free' ? this.config.env.FREE_LLM_MODEL : requestedModel;
  }

  async planForChat(chatId: number): Promise<QuotaPlan> {
    return (await this.quota.getReport(chatId)).plan;
  }

  /** Bot admins in private chat are operator sessions, not secondary/free groups. */
  bypassesGroupPlan(person: Person, context: ChatContext): boolean {
    return !context.isGroup && this.permissions.isBotAdminPerson(person);
  }

  /** Bulk archive authority: real group admin in groups, configured bot admin in private chat. */
  isAnimeArchiveAdmin(person: Person, context: ChatContext): boolean {
    return context.isGroup
      ? context.isGroupAdmin || this.permissions.isBotAdminPerson(person)
      : this.permissions.isBotAdminPerson(person);
  }

  attachAnimeArchiveTelegramApi(api: Api): void {
    this.companionApi = api;
    this.integrations = new IntegrationService(this.storage.integrations, {
      adapters: [new TelegramConnector(api)],
      authorize: async (owner, request) => {
        const user = await this.storage.users.getByTelegramId(owner);
        if (!user || !(await this.terms.hasAccepted(user.handle))) return false;
        const target = parseTelegramRecipient(request.recipient);
        const person: Person = {
          telegramId: owner,
          userHandle: user.handle,
          firstName: user.firstName ?? '',
          lastName: user.lastName ?? undefined,
        };
        const context: ChatContext = {
          chatId: target.chatId,
          isGroup: target.chatId < 0,
          isGroupAdmin: false,
          isBotMentioned: false,
          isReplyToBot: false,
          threadId: target.threadId,
        };
        if (!(await this.conversation.isStarted(target.chatId))) return false;
        if (target.chatId > 0 && target.chatId !== owner) return false;
        if (target.chatId < 0) {
          const member = await api.getChatMember(target.chatId, owner);
          if (
            member.status === 'left' ||
            member.status === 'kicked' ||
            (member.status === 'restricted' && !member.is_member)
          )
            return false;
        }
        return (
          this.access.isApproved(person, context, this.permissions.isBotAdminPerson(person)) &&
          (await this.permissions.checkAll(['allowed_user', 'not_banned'], person, context))
        );
      },
    });
    this.animeArchiveWorker.attachTelegramApi(api);
    this.companionWork.attachTelegramApi(api);
    this.workflows?.start();
  }

  kickAnimeArchiveWorker(): void {
    this.animeArchiveWorker.kick();
  }

  async shutdownAnimeArchive(): Promise<void> {
    await this.animeArchiveWorker.shutdown();
  }

  async planForTurn(person: Person, context: ChatContext): Promise<QuotaPlan> {
    if (this.bypassesGroupPlan(person, context)) return QUOTA_PLANS.pro;
    return this.planForChat(context.chatId);
  }

  async modelForChat(chatId: number, requestedModel?: string): Promise<string | undefined> {
    return this.modelForPlan(await this.planForChat(chatId), requestedModel);
  }

  isFreePlan(plan: Pick<QuotaPlan, 'id'> | QuotaPlanId): boolean {
    return (typeof plan === 'string' ? plan : plan.id) === 'free';
  }

  /** True if the user/chat may use the model, media generation and link-media (admin/approved). */
  isApproved(person: Person, context: ChatContext): boolean {
    const isAdmin = this.permissions.isBotAdminPerson(person);
    return this.access.isApproved(person, context, isAdmin);
  }

  /** First configured bot-admin handle, shown to users who must request approval. */
  adminContact(): string {
    return this.config.env.ADMIN_HANDLES?.[0] ?? 'the admin';
  }
}
