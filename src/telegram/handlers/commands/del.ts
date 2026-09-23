import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';
import { childLogger } from '../../../utils/logger.js';

const log = childLogger('del');

/**
 * /del — reply to a bot message with /del to have the bot delete its own message.
 * Only bot admins and group admins may use this. The /del command message itself
 * is also deleted (via deleteOrigin) to keep the chat clean.
 */
export const delCommand: CommandSpec = {
  command: 'del',
  permissions: ['admin'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ context, person }) {
    const repliedToMessageId = context.repliedToMessageId;
    if (!repliedToMessageId) {
      return { text: 'del_needs_reply', ephemeralMs: 5000, deleteOriginCommand: true };
    }
    if (!context.isReplyToBot) {
      return { text: 'del_not_bot_message', ephemeralMs: 5000, deleteOriginCommand: true };
    }
    log.info(
      {
        chatId: context.chatId,
        messageId: repliedToMessageId,
        admin: person.userHandle,
      },
      'admin requested bot message deletion',
    );
    return {
      deleteRepliedMessage: repliedToMessageId,
      deleteOriginCommand: true,
    };
  },
};
