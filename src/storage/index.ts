import { MongoServerError, type Db } from 'mongodb';
import type { Env } from '../config/env.js';
import { childLogger } from '../utils/logger.js';
import { connectMongo, type MongoConnection } from './mongo.js';
import { ChatsRepo } from './repositories/chats.js';
import { UsersRepo } from './repositories/users.js';
import { ChatMembersRepo } from './repositories/chatMembers.js';
import { ModesRepo } from './repositories/modes.js';
import { FactsRepo } from './repositories/facts.js';
import { MessagesRepo } from './repositories/messages.js';
import { UsageRepo } from './repositories/usage.js';
import { BansRepo } from './repositories/bans.js';
import { TermsRepo } from './repositories/terms.js';
import { MediaRepo } from './repositories/media.js';
import { JobsRepo } from './repositories/jobs.js';
import { MemoryItemsRepo } from './repositories/memoryItems.js';
import { BotRepliesRepo } from './repositories/botReplies.js';
import { BrainDebugRepo } from './repositories/brainDebug.js';
import { UserHeatRepo } from './repositories/userHeat.js';
import { KnowledgeRepo } from './repositories/knowledge.js';
import { AutopostHistoryRepo } from './repositories/autopostHistory.js';
import { LinkMediaCacheRepo } from './repositories/linkMediaCache.js';
import { ChatQuotaRepo } from './repositories/chatQuota.js';
import { ConversationThreadsRepo } from './repositories/conversationThreads.js';
import { ConversationEntitiesRepo } from './repositories/conversationEntities.js';
import { ChatMembershipEventsRepo } from './repositories/chatMembershipEvents.js';
import { AnimeCatalogRepo } from './repositories/animeCatalog.js';
import { AnimeFollowsRepo } from './repositories/animeFollows.js';
import { AmbientCacheRepo } from './repositories/ambientCache.js';
import { JobNotificationsRepo } from './repositories/jobNotifications.js';
import { TopicAffinityRepo } from './repositories/topicAffinity.js';
import { SocialStandingRepo } from './repositories/socialStanding.js';
import { SocialQuestionsRepo } from './repositories/socialQuestions.js';
import { AnimeArchiveRepo } from './repositories/animeArchive.js';
import { BotAdminsRepo } from './repositories/botAdmins.js';
import { MongoSocialProfileStore } from '../social/mongoStore.js';
import { UpdateInboxRepo } from './repositories/updateInbox.js';
import { CompanionTaskRepository } from '../companion/tasks/repository.js';
import { ReminderService, type ReminderServiceOptions } from '../companion/workflows/index.js';
import { WorkflowTickCoordinator } from '../companion/workflows/index.js';
import { MongoIntegrationRepository } from '../integrations/index.js';
import {
  CompanionMemoryService,
  MongoMemoryRepository,
  MemoryPrivacyGuard,
  type CompanionMemory,
} from '../companion/memory/index.js';

const log = childLogger('storage');

/**
 * Storage facade: owns the Mongo connection and exposes all repositories.
 * `ensureIndexes()` is idempotent and safe to call on every boot.
 */
export class Storage {
  readonly chats: ChatsRepo;
  readonly users: UsersRepo;
  readonly chatMembers: ChatMembersRepo;
  readonly modes: ModesRepo;
  readonly facts: FactsRepo;
  readonly messages: MessagesRepo;
  readonly usage: UsageRepo;
  readonly bans: BansRepo;
  readonly terms: TermsRepo;
  readonly media: MediaRepo;
  readonly jobs: JobsRepo;
  readonly memoryItems: MemoryItemsRepo;
  readonly botReplies: BotRepliesRepo;
  readonly brainDebug: BrainDebugRepo;
  readonly userHeat: UserHeatRepo;
  readonly knowledge: KnowledgeRepo;
  readonly autopostHistory: AutopostHistoryRepo;
  readonly linkMediaCache: LinkMediaCacheRepo;
  readonly chatQuota: ChatQuotaRepo;
  readonly conversationThreads: ConversationThreadsRepo;
  readonly conversationEntities: ConversationEntitiesRepo;
  readonly chatMembershipEvents: ChatMembershipEventsRepo;
  readonly animeCatalog: AnimeCatalogRepo;
  readonly animeFollows: AnimeFollowsRepo;
  readonly ambientCache: AmbientCacheRepo;
  readonly jobNotifications: JobNotificationsRepo;
  readonly topicAffinity: TopicAffinityRepo;
  readonly socialStanding: SocialStandingRepo;
  readonly socialQuestions: SocialQuestionsRepo;
  readonly animeArchive: AnimeArchiveRepo;
  readonly botAdmins: BotAdminsRepo;
  readonly socialProfiles: MongoSocialProfileStore;
  /** Durable Telegram ingress receipts used for deduplication and crash recovery. */
  readonly updateInbox: UpdateInboxRepo;
  readonly companionTasks: CompanionTaskRepository;
  readonly companionMemory: CompanionMemoryService;
  readonly memoryPrivacy: MemoryPrivacyGuard;
  readonly integrations: MongoIntegrationRepository;
  readonly workflowTicks: WorkflowTickCoordinator;

  private constructor(
    private readonly connection: MongoConnection,
    private readonly db: Db,
    private readonly env: Env,
  ) {
    this.chats = new ChatsRepo(db);
    this.users = new UsersRepo(db);
    this.chatMembers = new ChatMembersRepo(db);
    this.modes = new ModesRepo(db);
    this.facts = new FactsRepo(db);
    this.messages = new MessagesRepo(
      db,
      env.MAX_STORED_MESSAGES_PER_CHAT,
      env.MESSAGE_HISTORY_RETENTION_DAYS,
    );
    this.usage = new UsageRepo(db, env.DEFAULT_USAGE_LIMIT);
    this.bans = new BansRepo(db);
    this.terms = new TermsRepo(db);
    this.media = new MediaRepo(db);
    this.jobs = new JobsRepo(db);
    this.memoryPrivacy = new MemoryPrivacyGuard(db);
    this.memoryItems = new MemoryItemsRepo(db, this.memoryPrivacy);
    this.botReplies = new BotRepliesRepo(db, env.BOT_REPLIES_RETENTION_DAYS);
    this.brainDebug = new BrainDebugRepo(db, env.BRAIN_DEBUG_TTL_DAYS);
    this.userHeat = new UserHeatRepo(db);
    this.knowledge = new KnowledgeRepo(db);
    this.autopostHistory = new AutopostHistoryRepo(db);
    this.linkMediaCache = new LinkMediaCacheRepo(db);
    this.chatQuota = new ChatQuotaRepo(db);
    this.conversationThreads = new ConversationThreadsRepo(db);
    this.conversationEntities = new ConversationEntitiesRepo(db);
    this.chatMembershipEvents = new ChatMembershipEventsRepo(db);
    this.animeCatalog = new AnimeCatalogRepo(db);
    this.animeFollows = new AnimeFollowsRepo(db);
    this.ambientCache = new AmbientCacheRepo(db);
    this.jobNotifications = new JobNotificationsRepo(db);
    this.topicAffinity = new TopicAffinityRepo(db);
    this.socialStanding = new SocialStandingRepo(db);
    this.socialQuestions = new SocialQuestionsRepo(db);
    this.animeArchive = new AnimeArchiveRepo(db);
    this.botAdmins = new BotAdminsRepo(db);
    this.socialProfiles = new MongoSocialProfileStore(db, this.memoryPrivacy);
    this.updateInbox = new UpdateInboxRepo(db);
    this.companionTasks = new CompanionTaskRepository(db);
    this.integrations = new MongoIntegrationRepository(db);
    this.workflowTicks = new WorkflowTickCoordinator(db);
    this.companionMemory = new CompanionMemoryService(new MongoMemoryRepository(db), {
      list: async (scope) => {
        const aliases = await this.users.listAliasesByTelegramId(scope.ownerTelegramId);
        if (
          !aliases.length ||
          !(await this.memoryPrivacy.allowsHandles(aliases, scope.ownerTelegramId))
        )
          return [];
        const knownAliases = new Set(aliases.map((alias) => alias.toLowerCase()));
        const [items, messages] = await Promise.all([
          this.memoryItems.listActive(scope.chatId, 300),
          this.messages.getRecent(scope.chatId, 2_000, scope.telegramTopicId ?? null),
        ]);
        const humanIds = new Set(
          messages.filter((message) => !message.isBot).map((message) => message.messageId),
        );
        return items
          .filter((item) => {
            if (
              !item._id ||
              !item.subjectHandle ||
              !knownAliases.has(item.subjectHandle.toLowerCase())
            )
              return false;
            if (item.sourceMessageIds.length)
              return item.sourceMessageIds.every((id) => humanIds.has(id));
            // Legacy manual rows have no topic provenance. Never project them into a forum topic.
            return (
              scope.telegramTopicId == null &&
              ['admin', 'self_declared', 'migration'].includes(item.source)
            );
          })
          .map(
            (item): CompanionMemory => ({
              id: `legacy:${item._id}`,
              chatId: scope.chatId,
              telegramTopicId: scope.telegramTopicId ?? null,
              kind: 'social',
              category: item.category,
              text: item.text,
              provenance: {
                source: 'human',
                messageId: item.sourceMessageIds[0],
                sourceAt: item.firstSeenAt,
              },
              revision: item.revision ?? 1,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            }),
          );
      },
      forget: async (scope, items) => {
        let count = 0;
        for (const item of items) {
          if (item.provenance.messageId)
            await this.socialProfiles.forgetSource(scope.chatId, item.provenance.messageId);
          if (await this.memoryItems.forgetById(scope.chatId, item.id.slice('legacy:'.length)))
            count++;
        }
        return count;
      },
    });
  }

  static async connect(env: Env): Promise<Storage> {
    const connection = await connectMongo(env.MONGO_URI, env.MONGO_DB);
    return new Storage(connection, connection.db, env);
  }

  createReminderService(options: ReminderServiceOptions): ReminderService {
    return new ReminderService(this.db, options);
  }

  async ensureIndexes(): Promise<void> {
    await ChatsRepo.ensureIndexes(this.db);
    await UsersRepo.ensureIndexes(this.db);
    await ChatMembersRepo.ensureIndexes(this.db);
    await ModesRepo.ensureIndexes(this.db);
    await FactsRepo.ensureIndexes(this.db);
    await this.messages.ensureIndexes();
    await UsageRepo.ensureIndexes(this.db);
    await BansRepo.ensureIndexes(this.db);
    await TermsRepo.ensureIndexes(this.db);
    await MediaRepo.ensureIndexes(this.db);
    await JobsRepo.ensureIndexes(this.db);
    await MemoryItemsRepo.ensureIndexes(this.db);
    await this.botReplies.ensureIndexes();
    await this.brainDebug.ensureIndexes();
    await UserHeatRepo.ensureIndexes(this.db);
    await KnowledgeRepo.ensureIndexes(this.db);
    await AutopostHistoryRepo.ensureIndexes(this.db);
    await LinkMediaCacheRepo.ensureIndexes(this.db);
    await ChatQuotaRepo.ensureIndexes(this.db);
    await ConversationThreadsRepo.ensureIndexes(this.db);
    await ConversationEntitiesRepo.ensureIndexes(this.db);
    await ChatMembershipEventsRepo.ensureIndexes(this.db);
    await AnimeCatalogRepo.ensureIndexes(this.db);
    await AnimeFollowsRepo.ensureIndexes(this.db);
    await AmbientCacheRepo.ensureIndexes(this.db);
    await JobNotificationsRepo.ensureIndexes(this.db);
    await TopicAffinityRepo.ensureIndexes(this.db);
    await SocialStandingRepo.ensureIndexes(this.db);
    await SocialQuestionsRepo.ensureIndexes(this.db);
    await AnimeArchiveRepo.ensureIndexes(this.db);
    await BotAdminsRepo.ensureIndexes(this.db);
    await MongoSocialProfileStore.ensureIndexes(this.db);
    await UpdateInboxRepo.ensureIndexes(this.db, this.env.TELEGRAM_INGRESS_RETENTION_DAYS);
    await CompanionTaskRepository.ensureIndexes(this.db);
    await ReminderService.ensureIndexes(this.db);
    await MongoIntegrationRepository.ensureIndexes(this.db);
    await WorkflowTickCoordinator.ensureIndexes(this.db);
    log.info('indexes ensured');
  }

  /**
   * Import legacy `facts` into `memory_items`.
   *
   * Idempotency is per fact, not global: a previous implementation stopped as soon as it found one
   * migrated item, which made a partially interrupted migration permanently skip the remaining
   * facts. Looking up every normalized legacy item also means an explicitly expired migration is
   * never resurrected on a later boot. Old facts are retained as a non-destructive source archive.
   */
  async migrateLegacyFacts(): Promise<number> {
    const factsCol = this.db.collection('facts');
    const memCol = this.db.collection('memory_items');
    const VULGAR = /\b(cazzo|merda|stronz|porn|sex|fuck|shit|bitch|puttana|troia|culo|figa)/i;
    const docs = await factsCol.find({}).toArray();
    let imported = 0;
    for (const f of docs) {
      const text: string = String(f['fact'] ?? '').trim();
      const chatId = f['chatId'];
      if (!text || !Number.isSafeInteger(chatId)) continue;
      const handle: string | null = (f['userHandle'] as string) ?? null;
      const subjectType = handle ? 'user' : 'group';
      const normalizedText = text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (
        !(await this.memoryPrivacy.allowsMemory(chatId, {
          text,
          sourceMessageIds: [],
          subjectHandle: handle,
        }))
      )
        continue;
      // Check every status/source. If this legacy item was deliberately expired, importing it
      // again would undo /clearfacts or /forget on the next restart.
      const existing = await memCol.findOne(
        { chatId, subjectType, subjectHandle: handle, normalizedText },
        { projection: { _id: 1 } },
      );
      if (existing) continue;
      const now = new Date();
      const source = String(f['source'] ?? 'manual');
      const legacyCreatedAt = f['createdAt'];
      const firstSeenAt =
        legacyCreatedAt instanceof Date && Number.isFinite(legacyCreatedAt.getTime())
          ? legacyCreatedAt
          : now;
      try {
        await this.memoryItems.insertRaw({
          chatId,
          subjectType,
          subjectHandle: handle,
          involvedHandles: handle ? [handle] : [],
          text,
          normalizedText,
          category: source === 'introduction' ? 'role' : 'reputation',
          source: 'migration',
          sourceMessageIds: [],
          createdByHandle: (f['createdByHandle'] as string) ?? null,
          confidence: 0.55,
          salience: 0.45,
          toxicity: VULGAR.test(text) ? 'vulgar' : 'clean',
          status: 'active',
          firstSeenAt,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
          useCount: 0,
          positiveFeedbackCount: 0,
          negativeFeedbackCount: 0,
          tags: [],
          revision: 1,
          history: [],
        });
        imported += 1;
      } catch (error) {
        // Another process may have completed the same migration after our lookup. The active
        // memory dedupe index is the final idempotency barrier.
        if (error instanceof MongoServerError && error.code === 11000) continue;
        throw error;
      }
    }
    if (imported > 0) log.info({ imported }, 'migrated legacy facts -> memory_items');
    return imported;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  /** Clear derived prompt/debug material in affected chats after fencing memory producers. */
  async eraseMemoryDerivedData(actorTelegramId: number, aliases: string[]): Promise<void> {
    await this.memoryPrivacy.blockHandles(aliases, actorTelegramId);
    await this.companionMemory.eraseActor(actorTelegramId);
    const messages = this.db.collection('messages');
    const chats = await messages.distinct('chatId', {
      $or: [{ telegramId: actorTelegramId }, { userHandle: { $in: aliases } }],
    });
    const profileChats = await this.db
      .collection('social_member_profiles')
      .distinct('chatId', { $or: [{ telegramId: actorTelegramId }, { handle: { $in: aliases } }] });
    const chatIds = [...new Set([...chats, ...profileChats])].filter((id) =>
      Number.isSafeInteger(id),
    );
    // These collections are disposable derived context, not Telegram messages or user files.
    for (const name of [
      'brain_debug_turns',
      'bot_replies',
      'conversation_threads',
      'conversation_entities',
    ]) {
      if (chatIds.length) await this.db.collection(name).deleteMany({ chatId: { $in: chatIds } });
    }
    await this.db.collection('social_questions').deleteMany({
      $or: [
        { targetTelegramId: actorTelegramId },
        { targetHandle: { $in: aliases } },
        { subjectHandle: { $in: aliases } },
      ],
    });
    await messages.deleteMany({
      $or: [{ telegramId: actorTelegramId }, { userHandle: { $in: aliases } }],
    });
  }
}

export type { MongoConnection };
