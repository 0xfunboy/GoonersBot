import type { CommandSpec } from '../types.js';
import {
  HELP_CATEGORY_ORDER,
  categoryLabel,
  commandAccessLabel,
  helpDefinition,
  helpLanguageForChat,
} from './helpCatalog.js';

/**
 * One canonical map for the Italian/English command surface. Telegram command names are ASCII,
 * so display language is kept out of the command itself and both forms resolve everywhere.
 */
const languageAliases: Readonly<Record<string, readonly string[]>> = {
  start: ['avvia'],
  stop: ['ferma'],
  reset: ['reimposta'],
  mode: ['modalita'],
  addmode: ['aggiungimodalita'],
  deletemode: ['eliminamodalita'],
  introduce: ['presentati'],
  setfact: ['impostafatto', 'remember', 'ricorda'],
  facts: ['fatti', 'memory', 'memoria'],
  clearfacts: ['cancellafatti'],
  lore: ['storia'],
  forget: ['dimentica'],
  conversationtracker: ['tracciaconversazione'],
  autoengage: ['autointerventi'],
  autopost: ['autopubblica'],
  linkmedia: ['medialink'],
  news: ['notizie'],
  genera: ['generate'],
  disegna: ['sketch'],
  genvid: ['generavideo'],
  ban: ['banna'],
  unban: ['sbanna'],
  usage: ['utilizzo'],
  language: ['lingua'],
  tos: ['termini'],
  voice: ['voce'],
  play: ['suona'],
  sing: ['canta'],
  translate: ['traduci'],
  brain: ['cervello'],
  debuglast: ['debugultimo'],
  // Only the alias the group actually types: /help renders every alias and already sits at the
  // Telegram 4096-character ceiling, so each extra one costs room a real command may need.
  follow: ['segui'],
  unfollow: [],
  following: [],
  anime: [],
  help: ['aiuto'],
  approve: ['approva'],
  unapprove: ['disapprova'],
  approved: ['approvati'],
  profile: ['profilo'],
  vision: ['visione'],
  capabilities: ['capacita'],
  learn: ['impara'],
  community: ['comunita'],
  socialstatus: ['statosociale'],
  hardware: ['sistema'],
  models: ['modelli'],
  quota: ['quote'],
  botinfo: ['infobot'],
};

/** English form to expose in Telegram's base command menu. */
const englishMenuNames: Readonly<Record<string, string>> = {
  genera: 'image',
  disegna: 'draw',
  genvid: 'video',
  tos: 'terms',
};

/** The canonical Italian spelling when the implementation's primary command is already Italian. */
const italianHelpNames: Readonly<Record<string, string>> = {
  genera: 'genera',
  disegna: 'disegna',
  genvid: 'generavideo',
};

let registeredCatalog: readonly CommandSpec[] = [];

export function aliasesForCommand(spec: CommandSpec): string[] {
  return [...new Set([...(spec.aliases ?? []), ...(languageAliases[spec.command] ?? [])])].filter(
    (name) => name !== spec.command,
  );
}

export function menuNameForCommand(spec: CommandSpec): string {
  return englishMenuNames[spec.command] ?? spec.command;
}

/**
 * Fail fast at boot/module-load time when two handlers claim the same command route or Telegram
 * menu name. Without this guard grammY would silently make one handler unreachable.
 */
export function registerCommandCatalog(specs: readonly CommandSpec[]): void {
  const routes = new Map<string, string>();
  const menuNames = new Map<string, string>();
  for (const spec of specs) {
    const names = [spec.command, ...aliasesForCommand(spec)];
    for (const name of names) {
      if (!/^[a-z0-9_]{1,32}$/.test(name)) {
        throw new Error(`invalid Telegram command route: /${name}`);
      }
      const owner = routes.get(name);
      if (owner !== undefined) {
        throw new Error(`duplicate Telegram command route /${name}: ${owner}, ${spec.command}`);
      }
      routes.set(name, spec.command);
    }
    const menuName = menuNameForCommand(spec);
    if (!/^[a-z0-9_]{1,32}$/.test(menuName)) {
      throw new Error(`invalid Telegram menu command: /${menuName}`);
    }
    const menuOwner = menuNames.get(menuName);
    if (menuOwner !== undefined) {
      throw new Error(
        `duplicate Telegram menu command /${menuName}: ${menuOwner}, ${spec.command}`,
      );
    }
    menuNames.set(menuName, spec.command);
  }
  for (const [menuName, owner] of menuNames) {
    const routeOwner = routes.get(menuName);
    if (routeOwner !== owner) {
      throw new Error(
        `Telegram menu command /${menuName} is not routed to ${owner}` +
          (routeOwner ? ` (owned by ${routeOwner})` : ''),
      );
    }
  }
  if (specs.length > 100) {
    throw new Error(`Telegram supports at most 100 menu commands, got ${specs.length}`);
  }
  registeredCatalog = [...specs];
}

/** Snapshot used by /help and diagnostics. */
export function registeredCommandCatalog(): readonly CommandSpec[] {
  return registeredCatalog;
}

/**
 * Render the complete registered command surface. Long-form descriptions come from helpCatalog,
 * while aliases and access requirements come from the actual CommandSpec registry so /help cannot
 * drift away from runtime routing or permission semantics.
 */
export function commandCatalogHelp(language: string): string {
  const helpLanguage = helpLanguageForChat(language);
  const aliasLabel =
    helpLanguage === 'italian' ? 'Alias' : helpLanguage === 'spanish' ? 'Alias' : 'Aliases';
  const accessLabel =
    helpLanguage === 'italian' ? 'Accesso' : helpLanguage === 'spanish' ? 'Acceso' : 'Access';

  return HELP_CATEGORY_ORDER.map((category) => {
    const specs = registeredCatalog
      .filter((spec) => helpDefinition(spec.command)?.category === category)
      .sort((a, b) => a.priority - b.priority || a.command.localeCompare(b.command));
    if (specs.length === 0) return '';
    const lines = specs.map((spec) => {
      const definition = helpDefinition(spec.command);
      if (!definition) return `/${menuNameForCommand(spec)} — ${spec.command}`;
      const usage = definition.usage[helpLanguage];
      const primary = /^\/([a-z0-9_]+)/iu.exec(usage)?.[1];
      const aliases = [spec.command, ...aliasesForCommand(spec)]
        .filter((alias) => alias !== primary)
        .map((alias) => `/${alias}`);
      return [
        usage,
        `  ${definition.description[helpLanguage]}`,
        `  ${accessLabel}: ${commandAccessLabel(spec, helpLanguage)}${
          aliases.length > 0 ? ` · ${aliasLabel}: ${aliases.join(', ')}` : ''
        }`,
      ].join('\n');
    });
    return `${categoryLabel(category, helpLanguage)}\n${lines.join('\n\n')}`;
  })
    .filter(Boolean)
    .join('\n\n');
}

/** Compact alias appendix for /help, ordered for the selected chat language. */
export function commandAliasHelp(language: string): string {
  const italianFirst = language === 'italian';
  const label = italianFirst ? 'Alias italiano / inglese' : 'Italian / English aliases';
  const rows = Object.entries(languageAliases)
    .map(([command, italian]) => {
      const english = englishMenuNames[command] ?? command;
      const italianName = italianHelpNames[command] ?? italian[0] ?? command;
      const left = italianFirst ? italianName : english;
      const right = italianFirst ? english : italianName;
      return `<em>/${left}</em> /<em>${right}</em>`;
    })
    .join(' · ');
  return `<strong>${label}</strong>\n${rows}`;
}
