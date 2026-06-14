import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';
import { DELETE_MODE_CALLBACK, SET_MODE_CALLBACK, modesKeyboard } from '../shared.js';

/** /mode — show the inline keyboard of modes to pick from. */
export const modeCommand: CommandSpec = {
  command: 'mode',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    return {
      text: 'choose_mode',
      keyboard: await modesKeyboard(services, context.chatId, SET_MODE_CALLBACK),
    };
  },
};

/** /addmode <description> — add a custom mode (name derived from the first sentence). */
export const addmodeCommand: CommandSpec = {
  command: 'addmode',
  permissions: ['allowed_user', 'admin', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context, person, args }) {
    const description = args.join(' ').trim();
    if (description.length === 0) return { text: 'invalid_mode_args' };
    const name = await services.modes.add(context.chatId, description, person.userHandle);
    if (!name) return { text: 'inappropriate_mode' };
    return { text: 'mode_added', vars: { mode_name: name } };
  },
};

/** /deletemode — show the inline keyboard of modes to delete. */
export const deletemodeCommand: CommandSpec = {
  command: 'deletemode',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    return {
      text: 'choose_mode_to_delete',
      keyboard: await modesKeyboard(services, context.chatId, DELETE_MODE_CALLBACK),
    };
  },
};
