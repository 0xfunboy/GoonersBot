import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatContext, Person } from '../domain/types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('access');

interface ApprovedStore {
  chats: number[];
  users: number[];
}

/**
 * Approval gate. The model, media generation and link-media are available only to:
 *   - bot admins (ADMIN_HANDLES), checked by the caller and passed as `isAdmin`,
 *   - approved user ids,
 *   - approved chat ids (communities).
 * Everyone else is limited to the basic commands. Approvals persist to a JSON file and are seeded
 * from APPROVED_CHATS / APPROVED_USERS on first run.
 */
export class AccessService {
  private chats: Set<number>;
  private users: Set<number>;

  constructor(
    private readonly storePath: string,
    seedChats: number[],
    seedUsers: number[],
  ) {
    const loaded = this.load();
    if (loaded) {
      this.chats = new Set(loaded.chats);
      this.users = new Set(loaded.users);
    } else {
      this.chats = new Set(seedChats);
      this.users = new Set(seedUsers);
      this.save(); // materialize the seed so it can be edited/extended at runtime
    }
  }

  isChatApproved(chatId: number): boolean {
    return this.chats.has(chatId);
  }

  isUserApproved(userId: number): boolean {
    return this.users.has(userId);
  }

  /** Full gate: admins always pass; otherwise the user id or the chat id must be approved. */
  isApproved(person: Person, context: ChatContext, isAdmin: boolean): boolean {
    return isAdmin || this.users.has(person.telegramId) || this.chats.has(context.chatId);
  }

  approveChat(chatId: number): void {
    this.chats.add(chatId);
    this.save();
  }

  approveUser(userId: number): void {
    this.users.add(userId);
    this.save();
  }

  unapproveChat(chatId: number): boolean {
    const ok = this.chats.delete(chatId);
    if (ok) this.save();
    return ok;
  }

  unapproveUser(userId: number): boolean {
    const ok = this.users.delete(userId);
    if (ok) this.save();
    return ok;
  }

  list(): ApprovedStore {
    return { chats: [...this.chats], users: [...this.users] };
  }

  private load(): ApprovedStore | null {
    try {
      if (!existsSync(this.storePath)) return null;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as Partial<ApprovedStore>;
      return {
        chats: Array.isArray(raw.chats) ? raw.chats.filter((n) => Number.isFinite(n)) : [],
        users: Array.isArray(raw.users) ? raw.users.filter((n) => Number.isFinite(n)) : [],
      };
    } catch (err) {
      log.warn({ err, path: this.storePath }, 'failed to read approved store; starting from seed');
      return null;
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, `${JSON.stringify(this.list(), null, 2)}\n`);
    } catch (err) {
      log.error({ err, path: this.storePath }, 'failed to persist approved store');
    }
  }
}
