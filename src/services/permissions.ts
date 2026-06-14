import type { ChatContext, Person } from '../domain/types.js';
import type { Storage } from '../storage/index.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('permissions');

/**
 * Permission primitives, ported from the original auth.py permission classes:
 * - allowed_user : ALLOWED_HANDLES is null (unrestricted) or handle is listed
 * - group_admin  : the user is an admin of the current chat (private chat => always admin)
 * - bot_admin    : ADMIN_HANDLES is set and the handle is listed
 * - admin        : group_admin OR bot_admin (so the deployer in ADMIN_HANDLES can control the bot
 *                  anywhere, even without being a group admin). Used for control commands.
 * - not_banned   : the user is not currently banned (honours ban expiry)
 *
 * Centralized here so admin/ban checks are never scattered across handlers.
 */
export type Permission = 'allowed_user' | 'group_admin' | 'bot_admin' | 'admin' | 'not_banned';

export class PermissionService {
  constructor(
    private readonly storage: Storage,
    private readonly allowedHandles: string[] | null,
    private readonly adminHandles: string[] | null,
  ) {}

  isAllowed(handle: string): boolean {
    return this.allowedHandles === null || this.allowedHandles.includes(handle);
  }

  isBotAdmin(handle: string): boolean {
    return this.adminHandles !== null && this.adminHandles.includes(handle);
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
        return this.isBotAdmin(person.userHandle);
      case 'admin':
        return context.isGroupAdmin || this.isBotAdmin(person.userHandle);
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
