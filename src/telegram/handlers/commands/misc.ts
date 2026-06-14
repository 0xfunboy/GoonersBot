import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';
import { SET_LANGUAGE_CALLBACK, languagesKeyboard, termsKeyboard } from '../shared.js';

/** /usage — show the caller's usage this period and limit. */
export const usageCommand: CommandSpec = {
  command: 'usage',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.LAST,
  async handle({ services, person }) {
    const report = await services.usage.getReport(person.userHandle);
    return { text: 'usage_text', vars: { this_month_usage: report.usage, limit: report.limit } };
  },
};

/** /language — show the language picker. */
export const languageCommand: CommandSpec = {
  command: 'language',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services }) {
    return {
      text: 'choose_language',
      keyboard: languagesKeyboard(services, SET_LANGUAGE_CALLBACK),
    };
  },
};

/** /terms — show terms text with accept/decline buttons. */
export const termsCommand: CommandSpec = {
  command: 'terms',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    const language = await services.getLanguage(context.chatId);
    return { text: 'terms_text', keyboard: termsKeyboard(services, language) };
  },
};

/** /help — show capabilities + command list (public). */
export const helpCommand: CommandSpec = {
  command: 'help',
  permissions: [],
  needsTermsAccepted: false,
  priority: Priority.LAST,
  async handle() {
    return { text: 'help_text' };
  },
};
