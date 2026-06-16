import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';

/** /conversationtracker — toggle passive conversation tracking. */
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

/** /autofact — toggle automatic fact extraction. */
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

/** /autoengage — toggle auto-engage. */
export const autoengageCommand: CommandSpec = {
  command: 'autoengage',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    const on = await services.storage.chats.switchAutoengage(context.chatId);
    return { text: on ? 'autoengage_turned_on' : 'autoengage_turned_off' };
  },
};

/** /autopost — toggle autonomous posts (news/images) for this chat. */
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
