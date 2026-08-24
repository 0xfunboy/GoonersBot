import type { ChatContext, Person } from '../domain/types.js';
import type { Storage } from '../storage/index.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('permissions');

/**
 * Permission primitives, ported from the original auth.py permission classes:
 * - allowed_user : ALLOWED_HANDLES is null (unrestricted) or handle is listed
 * - group_admin  : the user is an admin of the current chat (private chat => always admin)
 * - bot_admin    : bootstrap ADMIN_HANDLES root OR a Mongo-backed runtime grant by Telegram user ID
 * - learn_admin  : bot_admin OR an immutable local-development Telegram user ID
 * - admin        : group_admin OR bot_admin (so root/runtime operators can control the bot anywhere,
 *                  even without being a group admin). Used for control commands.
 * - not_banned   : the user is not currently banned (honours ban expiry)
 *
 * Centralized here so admin/ban checks are never scattered across handlers.
 */
export type Permission =
  | 'allowed_user'
  | 'group_admin'
  | 'bot_admin'
  | 'learn_admin'
  | 'admin'
  | 'not_banned';

export class PermissionService {
  private readonly runtimeAdminIds = new Set<number>();

  constructor(
    private readonly storage: Storage,
    private readonly allowedHandles: string[] | null,
    private readonly adminHandles: string[] | null,
    private readonly localDevelopmentAdminIds: readonly number[] = [],
  ) {}

  /** Load id-based runtime grants before Telegram starts accepting updates. */
  async initialize(): Promise<void> {
    this.runtimeAdminIds.clear();
    for (const admin of await this.storage.botAdmins.list()) {
      this.runtimeAdminIds.add(admin.telegramId);
    }
  }

  isAllowed(handle: string): boolean {
    return this.allowedHandles === null || this.allowedHandles.includes(handle);
  }

  /** Bootstrap/root admins remain configured by handle and cannot be revoked from Telegram. */
  isRootAdmin(handle: string): boolean {
    const normalized = handle.toLowerCase();
    return this.adminHandles?.some((candidate) => candidate.toLowerCase() === normalized) ?? false;
  }

  /** Runtime authority is id-based; the optional handle only covers bootstrap admins. */
  isBotAdmin(handle: string, telegramId?: number): boolean {
    return (
      this.isRootAdmin(handle) || (telegramId !== undefined && this.runtimeAdminIds.has(telegramId))
    );
  }

  isBotAdminPerson(person: Person): boolean {
    return this.isBotAdmin(person.userHandle, person.telegramId);
  }

  async grantBotAdmin(target: Person, grantedBy: Person): Promise<'root' | 'existing' | 'granted'> {
    if (this.isRootAdmin(target.userHandle)) return 'root';
    if (this.runtimeAdminIds.has(target.telegramId)) {
      await this.storage.botAdmins.refreshIdentity(target);
      return 'existing';
    }
    await this.storage.botAdmins.grant(target, grantedBy);
    this.runtimeAdminIds.add(target.telegramId);
    return 'granted';
  }

  async revokeBotAdmin(target: Person): Promise<'root' | 'missing' | 'revoked'> {
    if (this.isRootAdmin(target.userHandle)) return 'root';
    if (!this.runtimeAdminIds.has(target.telegramId)) return 'missing';
    await this.storage.botAdmins.revoke(target.telegramId);
    this.runtimeAdminIds.delete(target.telegramId);
    return 'revoked';
  }

  listRuntimeBotAdmins() {
    return this.storage.botAdmins.list();
  }

  /** Refresh username/display metadata while preserving the immutable id grant. */
  async refreshBotAdminIdentity(person: Person): Promise<void> {
    if (!this.runtimeAdminIds.has(person.telegramId)) return;
    await this.storage.botAdmins.refreshIdentity(person);
  }

  isBanned(handle: string): Promise<boolean> {
    return this.storage.bans.isBanned(handle);
  }

  async check(permission: Permission, person: Person, context: ChatContext): Promise<boolean> {
    switch (permission) {
      case 'allowed_user':
        return this.isAllowed(person.userHandle);
      case 'group_admin':
        return context.isGroupAdmin;
      case 'bot_admin':
        return this.isBotAdminPerson(person);
      case 'learn_admin':
        return (
          this.isBotAdminPerson(person) || this.localDevelopmentAdminIds.includes(person.telegramId)
        );
      case 'admin':
        return context.isGroupAdmin || this.isBotAdminPerson(person);
      case 'not_banned':
        return !(await this.isBanned(person.userHandle));
      default: {
        const exhaustive: never = permission;
        throw new Error(`unknown permission: ${String(exhaustive)}`);
      }
    }
  }

  /** AND-composition: all required permissions must pass. */
  async checkAll(
    permissions: readonly Permission[],
    person: Person,
    context: ChatContext,
  ): Promise<boolean> {
    for (const permission of permissions) {
      if (!(await this.check(permission, person, context))) {
        log.info(
          { handle: person.userHandle, chatId: context.chatId, permission },
          'permission denied',
        );
        return false;
      }
    }
    return true;
  }
}
