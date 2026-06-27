import type { Db } from 'mongodb';
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

  private constructor(
    private readonly connection: MongoConnection,
    private readonly db: Db,
    env: Env,
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
    this.memoryItems = new MemoryItemsRepo(db);
    this.botReplies = new BotRepliesRepo(db, env.BOT_REPLIES_RETENTION_DAYS);
    this.brainDebug = new BrainDebugRepo(db, env.BRAIN_DEBUG_TTL_DAYS);
    this.userHeat = new UserHeatRepo(db);
    this.knowledge = new KnowledgeRepo(db);
    this.autopostHistory = new AutopostHistoryRepo(db);
    this.linkMediaCache = new LinkMediaCacheRepo(db);
    this.chatQuota = new ChatQuotaRepo(db);
    this.conversationThreads = new ConversationThreadsRepo(db);
    this.conversationEntities = new ConversationEntitiesRepo(db);
  }

  static async connect(env: Env): Promise<Storage> {
    const connection = await connectMongo(env.MONGO_URI, env.MONGO_DB);
    return new Storage(connection, connection.db, env);
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
    log.info('indexes ensured');
  }

  /**
   * One-time migration: import legacy `facts` into `memory_items` (idempotent - skips if any
   * migrated item already exists for the chat). Old facts are kept; they're just no longer dumped
   * into reply prompts.
   */
  async migrateLegacyFacts(): Promise<number> {
    const factsCol = this.db.collection('facts');
    const memCol = this.db.collection('memory_items');
    const already = await memCol.countDocuments({ source: 'migration' });
    if (already > 0) return 0;
    const VULGAR = /\b(cazzo|merda|stronz|porn|sex|fuck|shit|bitch|puttana|troia|culo|figa)/i;
    const docs = await factsCol.find({}).toArray();
    let imported = 0;
    for (const f of docs) {
      const text: string = String(f['fact'] ?? '').trim();
      if (!text) continue;
      const handle: string | null = (f['userHandle'] as string) ?? null;
      const now = new Date();
      const source = String(f['source'] ?? 'manual');
      await memCol.insertOne({
        chatId: f['chatId'],
        subjectType: handle ? 'user' : 'group',
        subjectHandle: handle,
        involvedHandles: handle ? [handle] : [],
        text,
        normalizedText: text.toLowerCase().replace(/\s+/g, ' ').trim(),
        category: source === 'introduction' ? 'role' : 'reputation',
        source: 'migration',
        sourceMessageIds: [],
        createdByHandle: (f['createdByHandle'] as string) ?? null,
        confidence: 0.55,
        salience: 0.45,
        toxicity: VULGAR.test(text) ? 'vulgar' : 'clean',
        status: 'active',
        firstSeenAt: (f['createdAt'] as Date) ?? now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        useCount: 0,
        positiveFeedbackCount: 0,
        negativeFeedbackCount: 0,
        tags: [],
      });
      imported += 1;
    }
    if (imported > 0) log.info({ imported }, 'migrated legacy facts -> memory_items');
    return imported;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

export type { MongoConnection };
