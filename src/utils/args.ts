/**
 * Parse the argument string of a Telegram command into tokens.
 * Mirrors python-telegram-bot's `context.args` (whitespace split, command word removed).
 */
export function parseArgs(text: string): string[] {
  // Strip the leading command token (e.g. "/fact@GoonersBot")
  const withoutCommand = text.replace(/^\/\S+\s*/, '');
  if (withoutCommand.trim() === '') return [];
  return withoutCommand.trim().split(/\s+/);
}

/** Extract the command name (without slash, without @botname) from a command message. */
export function parseCommandName(text: string): string | null {
  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?/);
  return match && match[1] ? match[1].toLowerCase() : null;
}
