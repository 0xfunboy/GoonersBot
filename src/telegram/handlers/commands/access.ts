import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';

/** Resolve the approval target: an explicit id arg (negative = chat, positive = user), else the
 *  current chat when invoked inside a group. */
function resolveTarget(
  args: string[],
  context: HandlerInput['context'],
): { kind: 'chat' | 'user'; id: number } | null {
  const raw = args[0];
  if (raw) {
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id)) return null;
    return id < 0 ? { kind: 'chat', id } : { kind: 'user', id };
  }
  if (context.isGroup) return { kind: 'chat', id: context.chatId };
  return null;
}

/** /approve [id] - approve a community chat or a user (admin only). In a group with no id, approves
 *  the current chat. In DM, pass an id: negative = chat, positive = user. */
export const approveCommand: CommandSpec = {
  command: 'approve',
  permissions: ['bot_admin', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context, args }: HandlerInput): Promise<CommandResponse | null> {
    const target = resolveTarget(args, context);
    if (!target) return { text: 'approve_usage' };
    if (target.kind === 'chat') services.access.approveChat(target.id);
    else services.access.approveUser(target.id);
    return { text: 'approve_done', vars: { target: `${target.kind} ${target.id}` } };
  },
};

/** /unapprove [id] - revoke approval for a chat or user (admin only). */
export const unapproveCommand: CommandSpec = {
  command: 'unapprove',
  permissions: ['bot_admin', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context, args }: HandlerInput): Promise<CommandResponse | null> {
    const target = resolveTarget(args, context);
    if (!target) return { text: 'approve_usage' };
    const ok =
      target.kind === 'chat'
        ? services.access.unapproveChat(target.id)
        : services.access.unapproveUser(target.id);
    return {
      text: ok ? 'unapprove_done' : 'approve_not_found',
      vars: { target: `${target.kind} ${target.id}` },
    };
  },
};

/** /approved - list approved chats and users (admin only). */
export const approvedCommand: CommandSpec = {
  command: 'approved',
  permissions: ['bot_admin', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services }: HandlerInput): Promise<CommandResponse | null> {
    const { chats, users } = services.access.list();
    const text = [
      `Approved chats (${chats.length}):`,
      chats.length ? chats.join('\n') : '-',
      '',
      `Approved users (${users.length}):`,
      users.length ? users.join('\n') : '-',
    ].join('\n');
    return { rawText: text };
  },
};
