import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';

/** /start — wake the bot in this chat (admin-gated). */
export const startCommand: CommandSpec = {
  command: 'start',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.FIRST,
  async handle({ services, context }) {
    await services.storage.chats.startChat(context.chatId);
    return { text: 'start_done' };
  },
};

/** /stop — put the bot to sleep in this chat (admin-gated). */
export const stopCommand: CommandSpec = {
  command: 'stop',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.FIRST,
  async handle({ services, context }) {
    await services.storage.chats.stopChat(context.chatId);
    return { text: 'stop_done' };
  },
};

/** /reset — wipe conversation memory for this chat. */
export const resetCommand: CommandSpec = {
  command: 'reset',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    await services.conversation.reset(context.chatId);
    return { text: 'reset_done' };
  },
};
