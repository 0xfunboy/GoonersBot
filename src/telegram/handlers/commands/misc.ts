import type { CommandSpec } from '../types.js';
import type { CommandResponse } from '../../../domain/types.js';
import { Priority } from '../types.js';
import { SET_LANGUAGE_CALLBACK, languagesKeyboard, termsKeyboard, termsHeader } from '../shared.js';
import { commandCatalogHelp } from './aliases.js';
import { helpLanguageForChat, normalizeHelpLanguage } from './helpCatalog.js';

/** /usage - show the caller's usage this period and limit. */
export const usageCommand: CommandSpec = {
  command: 'usage',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.LAST,
  async handle({ services, person }) {
    const report = await services.usage.getReport(person.userHandle);
    return { text: 'usage_text', vars: { this_month_usage: report.usage, limit: report.limit } };
  },
};

/** /language - show the language picker. */
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

/**
 * /tos (alias /terms) - show the terms-of-service prompt with accept/decline buttons and the header
 * image, so anyone can sign or revoke on demand. The prompt self-destructs after 1 minute and is
 * removed when a button is pressed.
 */
export const tosCommand: CommandSpec = {
  command: 'tos',
  aliases: ['terms'],
  // Read-only onboarding remains available even before allow-listing and while banned.
  permissions: [],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    const language = await services.getLanguage(context.chatId);
    const header = termsHeader();
    const resp: CommandResponse = {
      text: 'terms_text',
      keyboard: termsKeyboard(services, language),
      ephemeralMs: 60_000,
    };
    if (header) resp.imageBuffer = header;
    return resp;
  },
};

/** /help [it|en|es] - complete live command reference (public). */
export const helpCommand: CommandSpec = {
  command: 'help',
  permissions: [],
  needsTermsAccepted: false,
  priority: Priority.LAST,
  async handle({ services, context, args }) {
    const chatLanguage = await services.getLanguage(context.chatId);
    const explicitLanguage = args[0] ? normalizeHelpLanguage(args[0]) : null;
    if (args.length > 1 || (args[0] && !explicitLanguage)) {
      const language = helpLanguageForChat(chatLanguage);
      const usage =
        language === 'italian'
          ? 'Uso: /help [it|en|es]'
          : language === 'spanish'
            ? 'Uso: /help [it|en|es]'
            : 'Usage: /help [it|en|es]';
      return { rawText: usage, textFormat: 'plain' };
    }

    const language = explicitLanguage ?? helpLanguageForChat(chatLanguage);
    const intro =
      services.localizer.tPlain('help_intro_text', {}, language) ??
      (language === 'italian'
        ? 'GoonersBot — riferimento comandi'
        : language === 'spanish'
          ? 'GoonersBot — referencia de comandos'
          : 'GoonersBot — command reference');
    const catalog = commandCatalogHelp(language);
    const dynamic = services.capabilities.list();
    const dynamicSection =
      dynamic.length === 0
        ? ''
        : [
            language === 'italian'
              ? 'Comandi dinamici installati'
              : language === 'spanish'
                ? 'Comandos dinámicos instalados'
                : 'Installed dynamic commands',
            ...dynamic.map((item) => `/${item.command} — ${item.description}`),
            language === 'italian'
              ? 'Queste descrizioni provengono dalle capability installate e possono restare nella lingua in cui sono state create.'
              : language === 'spanish'
                ? 'Estas descripciones proceden de las capacidades instaladas y pueden conservar el idioma en el que fueron creadas.'
                : 'These descriptions come from installed capabilities and may remain in the language in which they were created.',
          ].join('\n');
    return {
      rawText: [intro, catalog, dynamicSection].filter(Boolean).join('\n\n'),
      textFormat: 'plain',
    };
  },
};
