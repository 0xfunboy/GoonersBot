import type { UserDoc } from '../../../domain/entities.js';
import type { Person } from '../../../domain/types.js';
import { normalizeHandle } from '../../../utils/handles.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';

interface ResolvedTelegramUser {
  person: Person;
  known: boolean;
}

/** /id [@username|telegram-id] or reply + /id - deterministic Telegram identity lookup. */
export const idCommand: CommandSpec = {
  command: 'id',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.LAST,
  async handle(input) {
    const target = await resolveTelegramUser(input, { defaultSelf: true, allowNumeric: true });
    if (!target) {
      return {
        rawText:
          'Non conosco quell’utente. Usa /id in reply a un suo messaggio oppure /id @username dopo che ha scritto almeno una volta.',
        textFormat: 'plain',
      };
    }
    return { rawText: renderIdentityYaml(target.person), textFormat: 'markdown' };
  },
};

/** /admin @username or reply + /admin - grant persistent bot-admin authority by Telegram user id. */
export const adminCommand: CommandSpec = {
  command: 'admin',
  permissions: ['bot_admin', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle(input) {
    const target = await resolveTelegramUser(input, { defaultSelf: false, allowNumeric: false });
    if (!target) {
      return {
        rawText:
          'Uso: reply a un messaggio + /admin, oppure /admin @username. Se il bot non conosce ancora lo username, usa il reply.',
        textFormat: 'plain',
      };
    }
    if (target.person.telegramId === input.person.telegramId) {
      return { rawText: 'Sei già tu quello con le chiavi.', textFormat: 'plain' };
    }
    const result = await input.services.permissions.grantBotAdmin(target.person, input.person);
    if (result === 'root') {
      return {
        rawText: `${target.person.userHandle} è già un root bot-admin configurato in ADMIN_HANDLES.`,
        textFormat: 'plain',
      };
    }
    if (result === 'existing') {
      return {
        rawText: `✅ ${target.person.userHandle} è già bot admin (Telegram ID ${target.person.telegramId}).`,
        textFormat: 'plain',
      };
    }
    return {
      rawText: `✅ ${target.person.userHandle} è ora bot admin. Grant persistita sul Telegram ID ${target.person.telegramId}.`,
      textFormat: 'plain',
    };
  },
};

/** /unadmin @username or reply + /unadmin - revoke only runtime/id-based bot-admin grants. */
export const unadminCommand: CommandSpec = {
  command: 'unadmin',
  permissions: ['bot_admin', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle(input) {
    const target = await resolveTelegramUser(input, { defaultSelf: false, allowNumeric: false });
    if (!target) {
      return {
        rawText:
          'Uso: reply a un messaggio + /unadmin, oppure /unadmin @username. I root admin da ADMIN_HANDLES non sono revocabili da Telegram.',
        textFormat: 'plain',
      };
    }
    const result = await input.services.permissions.revokeBotAdmin(target.person);
    if (result === 'root') {
      return {
        rawText: `${target.person.userHandle} è un root bot-admin da ADMIN_HANDLES: non si revoca da Telegram.`,
        textFormat: 'plain',
      };
    }
    if (result === 'missing') {
      return {
        rawText: `${target.person.userHandle} non ha una grant bot-admin runtime.`,
        textFormat: 'plain',
      };
    }
    return {
      rawText: `✅ Grant bot-admin revocata a ${target.person.userHandle} (Telegram ID ${target.person.telegramId}).`,
      textFormat: 'plain',
    };
  },
};

/** /admins - show immutable runtime grants plus non-revocable bootstrap handles. */
export const adminsCommand: CommandSpec = {
  command: 'admins',
  permissions: ['bot_admin', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services }) {
    const root = services.config.env.ADMIN_HANDLES ?? [];
    const runtime = await services.permissions.listRuntimeBotAdmins();
    const lines = ['Bot admins'];
    lines.push('Bootstrap/root (ADMIN_HANDLES):');
    lines.push(...(root.length > 0 ? root.map((handle) => `• ${handle}`) : ['• nessuno']));
    lines.push('', 'Runtime, persistiti per Telegram ID:');
    lines.push(
      ...(runtime.length > 0
        ? runtime.map(
            (admin) =>
              `• ${admin.handle} — ${admin.telegramId}${displayName(admin) ? ` — ${displayName(admin)}` : ''}`,
          )
        : ['• nessuno']),
    );
    return { rawText: lines.join('\n'), textFormat: 'plain' };
  },
};

async function resolveTelegramUser(
  input: HandlerInput,
  options: { defaultSelf: boolean; allowNumeric: boolean },
): Promise<ResolvedTelegramUser | null> {
  const { context, args, person, services } = input;
  if (args.length === 0 && context.repliedToTelegramId !== undefined) {
    return {
      person: {
        telegramId: context.repliedToTelegramId,
        userHandle: context.repliedToUserHandle ?? `@id${context.repliedToTelegramId}`,
        ...(context.repliedToFirstName ? { firstName: context.repliedToFirstName } : {}),
        ...(context.repliedToLastName ? { lastName: context.repliedToLastName } : {}),
      },
      known: true,
    };
  }
  if (args.length === 0) return options.defaultSelf ? { person, known: true } : null;

  const token = args[0]?.trim() ?? '';
  if (!token) return null;
  if (token.startsWith('@')) {
    const user = await services.storage.users.findByHandle(normalizeHandle(token));
    return user ? { person: personFromUserDoc(user), known: true } : null;
  }

  if (!options.allowNumeric) return null;
  const telegramId = parseTelegramId(token);
  if (telegramId === null) return null;
  const user = await services.storage.users.getByTelegramId(telegramId);
  if (user) return { person: personFromUserDoc(user), known: true };
  return {
    person: { telegramId, userHandle: `@id${telegramId}` },
    known: false,
  };
}

function personFromUserDoc(user: UserDoc): Person {
  return {
    telegramId: user.telegramId,
    userHandle: user.handle,
    ...(user.firstName ? { firstName: user.firstName } : {}),
    ...(user.lastName ? { lastName: user.lastName } : {}),
    ...(user.isPremium !== undefined ? { isPremium: user.isPremium } : {}),
  };
}

function parseTelegramId(raw: string): number | null {
  if (!/^[\d._-]+$/u.test(raw)) return null;
  const digits = raw.replace(/\D/gu, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function renderIdentityYaml(person: Person): string {
  return [
    '```yaml',
    `${person.telegramId}:`,
    `  username: ${person.userHandle.startsWith('@id') ? 'null' : yamlString(person.userHandle)}`,
    `  first_name: ${person.firstName ? yamlString(person.firstName) : 'null'}`,
    `  last_name: ${person.lastName ? yamlString(person.lastName) : 'null'}`,
    '```',
  ].join('\n');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function displayName(admin: { firstName?: string | null; lastName?: string | null }): string {
  return [admin.firstName, admin.lastName].filter(Boolean).join(' ').trim();
}

export const __test = { parseTelegramId, renderIdentityYaml, resolveTelegramUser };
