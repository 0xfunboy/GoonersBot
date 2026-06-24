import type { CommandSpec } from '../types.js';

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
  fact: ['estrai'],
  setfact: ['impostafatto'],
  facts: ['fatti'],
  clearfacts: ['cancellafatti'],
  forget: ['dimentica'],
  conversationtracker: ['tracciaconversazione'],
  autofact: ['autofatti'],
  autoengage: ['autointerventi'],
  autopost: ['autopubblica'],
  news: ['notizie'],
  genera: ['generate'],
  disegna: ['sketch'],
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
  help: ['aiuto'],
  approve: ['approva'],
  unapprove: ['disapprova'],
  approved: ['approvati'],
  profile: ['profilo'],
  vision: ['visione'],
};

/** English form to expose in Telegram's base command menu. */
const englishMenuNames: Readonly<Record<string, string>> = {
  genera: 'image',
  disegna: 'draw',
  tos: 'terms',
};

/** The canonical Italian spelling when the implementation's primary command is already Italian. */
const italianHelpNames: Readonly<Record<string, string>> = {
  genera: 'genera',
  disegna: 'disegna',
};

export function aliasesForCommand(spec: CommandSpec): string[] {
  return [...new Set([...(spec.aliases ?? []), ...(languageAliases[spec.command] ?? [])])].filter(
    (name) => name !== spec.command,
  );
}

export function menuNameForCommand(spec: CommandSpec): string {
  return englishMenuNames[spec.command] ?? spec.command;
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
