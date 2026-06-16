import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';
import { normalizeHandle } from '../../../utils/handles.js';

/**
 * /ban @handle [seconds] - ban a Gooner. Reply-aware: replying to a message bans its author.
 * Adapted from the original: the duration is optional (defaults to DEFAULT_BAN_SECONDS; 0 =
 * permanent), so the command never crashes on a missing seconds argument.
 */
export const banCommand: CommandSpec = {
  command: 'ban',
  permissions: ['bot_admin', 'allowed_user'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context, person, args }) {
    let targetHandle: string | undefined;
    let seconds: number | undefined;

    if (context.repliedToUserHandle) {
      targetHandle = context.repliedToUserHandle;
      if (args[0] !== undefined) seconds = parseSeconds(args[0]);
    } else if (args[0]) {
      targetHandle = normalizeHandle(args[0]);
      if (args[1] !== undefined) seconds = parseSeconds(args[1]);
    }

    if (!targetHandle) return { text: 'invalid_ban_args' };

    const duration = await services.bans.ban(targetHandle, seconds, person.userHandle);
    const suffix = duration > 0 ? ` for ${duration}s` : ' permanently';
    return { text: 'user_banned', vars: { user_handle: targetHandle, ban_suffix: suffix } };
  },
};

/** /unban @handle - lift a ban. */
export const unbanCommand: CommandSpec = {
  command: 'unban',
  permissions: ['bot_admin', 'allowed_user'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context, args }) {
    const target = context.repliedToUserHandle ?? (args[0] ? normalizeHandle(args[0]) : undefined);
    if (!target) return { text: 'invalid_unban_args' };
    await services.bans.unban(target);
    return { text: 'user_unbanned', vars: { user_handle: target } };
  },
};

function parseSeconds(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? undefined : n;
}
