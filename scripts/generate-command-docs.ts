import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commandHandlers } from '../src/telegram/handlers/commands/index.js';
import { aliasesForCommand } from '../src/telegram/handlers/commands/aliases.js';
import {
  HELP_CATEGORY_ORDER,
  categoryLabel,
  commandAccessLabel,
  helpDefinition,
  type HelpLanguage,
} from '../src/telegram/handlers/commands/helpCatalog.js';

const languages: ReadonlyArray<{ language: HelpLanguage; heading: string; intro: string }> = [
  {
    language: 'italian',
    heading: 'Italiano',
    intro:
      'Riferimento completo dei comandi statici registrati da GoonersBot. Le sintassi e gli alias qui sotto sono generati dalla stessa codebase usata dal runtime.',
  },
  {
    language: 'english',
    heading: 'English',
    intro:
      'Complete reference for the static commands registered by GoonersBot. Syntax and aliases below are generated from the same codebase used at runtime.',
  },
  {
    language: 'spanish',
    heading: 'Español',
    intro:
      'Referencia completa de los comandos estáticos registrados por GoonersBot. La sintaxis y los alias se generan desde la misma codebase usada en runtime.',
  },
];

const lines: string[] = [
  '# GoonersBot command reference',
  '',
  '> GENERATED FILE — update `src/telegram/handlers/commands/helpCatalog.ts` or the command registry, then run `pnpm docs:commands`.',
  '',
  `Static commands: **${commandHandlers.length}**. Capability Forge may install additional dynamic commands at runtime; use \`/capabilities\` to list those currently installed.`,
  '',
  'Access model: `admin` means group administrator **or** configured bot admin; `bot admin` means an entry in `ADMIN_HANDLES`; `learn admin` means bot admin or an immutable local-development admin ID. Except for `/start`, `/tos`/`/terms`, and `/help`, commands also pass through the approval gate.',
  '',
  'Anime note: `/anime` is the release/catalog command. AnimeUnity/HentaiSaturn availability, single-episode rehost, and current-season bulk rehost are natural-language `anime_archive` actions rather than separate slash commands. Archive delivery preserves the source and enforces one episode = one Telegram file.',
  '',
];

for (const { language, heading, intro } of languages) {
  lines.push(`## ${heading}`, '', intro, '');
  for (const category of HELP_CATEGORY_ORDER) {
    const specs = commandHandlers
      .filter((spec) => helpDefinition(spec.command)?.category === category)
      .sort((a, b) => a.priority - b.priority || a.command.localeCompare(b.command));
    if (specs.length === 0) continue;
    lines.push(`### ${categoryLabel(category, language)}`, '');
    for (const spec of specs) {
      const definition = helpDefinition(spec.command);
      if (!definition) throw new Error(`Missing help definition for /${spec.command}`);
      const aliases = aliasesForCommand(spec);
      lines.push(
        `#### \`${definition.usage[language]}\``,
        '',
        definition.description[language],
        '',
        `- **${language === 'italian' ? 'Accesso' : language === 'spanish' ? 'Acceso' : 'Access'}:** ${commandAccessLabel(spec, language)}`,
        `- **${language === 'italian' ? 'Alias registrati' : language === 'spanish' ? 'Alias registrados' : 'Registered aliases'}:** ${
          aliases.length > 0 ? aliases.map((alias) => `\`/${alias}\``).join(', ') : '—'
        }`,
        '',
      );
    }
  }
}

const output = `${lines.join('\n').trim()}\n`;
await writeFile(resolve(process.cwd(), 'docs/COMMANDS.md'), output, 'utf8');
console.log(`Generated docs/COMMANDS.md (${commandHandlers.length} static commands, 3 languages)`);
