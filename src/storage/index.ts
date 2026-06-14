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
    log.info('indexes ensured');
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

export type { MongoConnection };
