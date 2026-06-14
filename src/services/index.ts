import type { AppConfig } from '../config/index.js';
import { Localizer } from '../config/index.js';
import type { ChatContext, Person } from '../domain/types.js';
import type { LLMProvider } from '../providers/llm/types.js';
import { MediaProcessor } from '../providers/media/index.js';
import type { Storage } from '../storage/index.js';
import { AutoEngageScorer } from './autoengage.js';
import { BanService } from './bans.js';
import { ModelRouter } from './modelRouter.js';
import { ConversationService } from './conversation.js';
import { FactService } from './facts.js';
import { ModeService } from './modes.js';
import { PermissionService } from './permissions.js';
import { ReplyService } from './reply.js';
import { TermsService } from './terms.js';
import { UsageService } from './usage.js';

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

/**
 * Service container. Built once at boot and shared by all handlers. Holds every domain service
 * plus the localizer and the LLM/media providers. `initializeContext` mirrors the original
 * per-request bootstrap (create chat, seed modes, upsert user, ensure usage).
 */
export class Services {
  readonly localizer: Localizer;
  readonly permissions: PermissionService;
  readonly terms: TermsService;
  readonly bans: BanService;
  readonly modes: ModeService;
  readonly facts: FactService;
  readonly usage: UsageService;
  readonly conversation: ConversationService;
  readonly autoengage: AutoEngageScorer;
  readonly reply: ReplyService;
  readonly media: MediaProcessor;
  readonly modelRouter: ModelRouter;

  constructor(
    readonly config: AppConfig,
    readonly storage: Storage,
    readonly llm: LLMProvider,
  ) {
    const env = config.env;
    this.localizer = new Localizer(env.DEFAULT_LANGUAGE);
    this.media = new MediaProcessor(llm);
    this.permissions = new PermissionService(storage, env.ALLOWED_HANDLES, env.ADMIN_HANDLES);
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
    this.reply = new ReplyService(llm, this.media, this.conversation, this.facts, 2048);
    this.modelRouter = new ModelRouter({
      defaultModel: config.llm.model,
      nsfwModel: config.llm.nsfwModel,
      extraLexicon: env.LLM_NSFW_LEXICON,
      refusalFallback: env.LLM_REFUSAL_FALLBACK,
      refusalBufferChars: env.LLM_REFUSAL_BUFFER_CHARS,
    });
  }

  /** Ensure baseline records exist for this person/chat. Idempotent; runs before each handler. */
  async initializeContext(person: Person, context: ChatContext): Promise<void> {
    const env = this.config.env;
    await this.storage.chats.createIfNotExists(context.chatId, context.chatName, {
      language: env.DEFAULT_LANGUAGE,
      conversationTracker: env.CONVERSATION_TRACKER_DEFAULT_ENABLED,
      autoFact: env.AUTOFACT_DEFAULT_ENABLED,
      autoengage: env.AUTOENGAGE_DEFAULT_ENABLED,
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
}
