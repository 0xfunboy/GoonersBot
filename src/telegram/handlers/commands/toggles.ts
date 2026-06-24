import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';

/** /conversationtracker - toggle passive conversation tracking. */
export const conversationtrackerCommand: CommandSpec = {
  command: 'conversationtracker',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    const on = await services.storage.chats.switchConversationTracker(context.chatId);
    return { text: on ? 'conversation_tracker_turned_on' : 'conversation_tracker_turned_off' };
  },
};

/** /autofact - toggle automatic fact extraction. */
export const autofactCommand: CommandSpec = {
  command: 'autofact',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    const on = await services.storage.chats.switchAutoFact(context.chatId);
    return { text: on ? 'autofact_turned_on' : 'autofact_turned_off' };
  },
};

/** /autoengage - passive LLM replies are disabled globally to protect shared model capacity. */
export const autoengageCommand: CommandSpec = {
  command: 'autoengage',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle() {
    return { text: 'autoengage_disabled' };
  },
};

/** /autopost - toggle autonomous posts (news/images) for this chat. */
export const autopostCommand: CommandSpec = {
  command: 'autopost',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    const on = await services.storage.chats.switchAutopost(context.chatId);
    return { text: on ? 'autopost_turned_on' : 'autopost_turned_off' };
  },
};

/** /linkmedia - toggle automatic rehosting of media links for this chat (on by default). */
export const linkmediaCommand: CommandSpec = {
  command: 'linkmedia',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    const on = await services.storage.chats.switchLinkMedia(context.chatId);
    return { text: on ? 'linkmedia_turned_on' : 'linkmedia_turned_off' };
  },
};
