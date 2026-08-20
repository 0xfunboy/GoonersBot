import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Localizer } from '../src/config/index.js';
import type { ChatContext, Person } from '../src/domain/types.js';
import {
  aliasesForCommand,
  commandCatalogHelp,
  menuNameForCommand,
  registerCommandCatalog,
  registeredCommandCatalog,
} from '../src/telegram/handlers/commands/aliases.js';
import {
  capabilitiesCommand,
  learnCommand,
} from '../src/telegram/handlers/commands/capabilities.js';
import {
  communityCommand,
  socialstatusCommand,
} from '../src/telegram/handlers/commands/community.js';
import { commandHandlers } from '../src/telegram/handlers/commands/index.js';
import { helpCommand } from '../src/telegram/handlers/commands/misc.js';
import {
  COMMAND_HELP,
  helpLanguageForChat,
  normalizeHelpLanguage,
} from '../src/telegram/handlers/commands/helpCatalog.js';
import type { HandlerInput } from '../src/telegram/handlers/types.js';

const person: Person = { telegramId: 1, userHandle: '@bob' };
const context: ChatContext = {
  chatId: -1,
  isGroup: true,
  isBotMentioned: false,
  isGroupAdmin: true,
  isReplyToBot: false,
};

function input(services: unknown, args: string[] = []): HandlerInput {
  return {
    services: services as HandlerInput['services'],
    person,
    context,
    message: { messageText: '', timestamp: new Date() },
    args,
    botUsername: 'GoonersBot',
    addressed: true,
  };
}

describe('Telegram command registry', () => {
  it('registers every statically exported CommandSpec, including previously orphaned /lore', () => {
    const commandDir = join(process.cwd(), 'src/telegram/handlers/commands');
    const exported = readdirSync(commandDir)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) => {
        const source = readFileSync(join(commandDir, file), 'utf8');
        return [
          ...source.matchAll(
            /export const \w+Command:\s*CommandSpec\s*=\s*\{\s*command:\s*'([^']+)'/g,
          ),
        ].map((match) => match[1] as string);
      })
      .sort();
    const registered = commandHandlers.map((spec) => spec.command).sort();
    expect(registered).toEqual(exported);
    expect(registered).toContain('lore');
    expect(registered).not.toContain('fact');
    expect(registered).not.toContain('autofact');
  });

  it('keeps human-friendly memory and remember aliases after removing manual mining', () => {
    const facts = commandHandlers.find((spec) => spec.command === 'facts')!;
    const setfact = commandHandlers.find((spec) => spec.command === 'setfact')!;

    expect(aliasesForCommand(facts)).toContain('memory');
    expect(aliasesForCommand(setfact)).toContain('remember');
  });

  it('publishes the exact validated catalog and has no route or menu collisions', () => {
    expect(registeredCommandCatalog()).toEqual(commandHandlers);
    const routes = commandHandlers.flatMap((spec) => [spec.command, ...aliasesForCommand(spec)]);
    expect(new Set(routes).size).toBe(routes.length);
    const menuNames = commandHandlers.map(menuNameForCommand);
    expect(new Set(menuNames).size).toBe(menuNames.length);
    for (const menuName of menuNames) expect(routes).toContain(menuName);
    expect(menuNames.length).toBeLessThanOrEqual(100);
  });

  it('rejects duplicate canonical handlers instead of treating the shared owner label as safe', () => {
    const duplicate = {
      command: 'same',
      permissions: [],
      needsTermsAccepted: false,
      priority: 1,
      handle: vi.fn(),
    };
    expect(() => registerCommandCatalog([duplicate, { ...duplicate }])).toThrow(
      'duplicate Telegram command route /same',
    );
    // A failed validation must not replace the live catalog used by /help.
    expect(registeredCommandCatalog()).toEqual(commandHandlers);
  });

  it('derives access labels from real command permissions', () => {
    const help = commandCatalogHelp('english');
    expect(help).toContain('Administration & development');
    expect(help).toContain('/start\n  Wake GoonersBot in the current chat.');
    expect(help).toContain('Access: admin');
    expect(help).toContain('/facts [@user]');
    expect(help).toContain('Access: approved user/chat');
    expect(help).toContain('/ban @user [seconds]');
    expect(help).toContain('Access: bot admin');
    expect(help).toContain('/learn <request>');
    expect(help).toContain('Access: learn admin');
  });

  it('requires accepted terms for LLM/media and personal-data reads, but keeps onboarding public', () => {
    const protectedCommands = [
      'usage',
      'facts',
      'lore',
      'setfact',
      'brain',
      'debuglast',
      'voice',
      'play',
      'sing',
      'translate',
      'news',
      'genera',
      'disegna',
      'genvid',
      'vision',
      'learn',
      'community',
      'socialstatus',
    ];
    for (const command of protectedCommands) {
      expect(commandHandlers.find((spec) => spec.command === command)?.needsTermsAccepted).toBe(
        true,
      );
    }
    for (const command of ['start', 'tos', 'help']) {
      expect(commandHandlers.find((spec) => spec.command === command)?.needsTermsAccepted).toBe(
        false,
      );
    }
    expect(commandHandlers.find((spec) => spec.command === 'tos')?.permissions).toEqual([]);
  });

  it('routes every command that invokes an LLM through conversation quota accounting', () => {
    for (const command of [
      'voice',
      'play',
      'sing',
      'translate',
      'news',
      'genera',
      'disegna',
      'genvid',
      'vision',
      'learn',
    ]) {
      expect(commandHandlers.find((spec) => spec.command === command)?.quotaConversation).toBe(
        true,
      );
    }
  });

  it('has detailed Italian, English and Spanish help for every registered static command', () => {
    expect(Object.keys(COMMAND_HELP).sort()).toEqual(
      commandHandlers.map((spec) => spec.command).sort(),
    );
    for (const spec of commandHandlers) {
      const definition = COMMAND_HELP[spec.command];
      expect(definition, `missing help for /${spec.command}`).toBeDefined();
      for (const language of ['italian', 'english', 'spanish'] as const) {
        expect(definition?.usage[language].trim().length).toBeGreaterThan(1);
        expect(definition?.description[language].trim().length).toBeGreaterThan(10);
      }
    }
  });

  it('builds detailed /help from every real command and alias in Italian, English and Spanish', async () => {
    const localizer = new Localizer('italian');
    for (const language of ['italian', 'english', 'spanish'] as const) {
      const catalog = commandCatalogHelp(language);
      for (const spec of commandHandlers) {
        expect(catalog).toContain(COMMAND_HELP[spec.command]!.usage[language]);
        expect(catalog).toContain(COMMAND_HELP[spec.command]!.description[language]);
        for (const alias of aliasesForCommand(spec)) expect(catalog).toContain(`/${alias}`);
      }
      const response = await helpCommand.handle(
        input({
          getLanguage: vi.fn().mockResolvedValue(language),
          localizer,
          capabilities: { list: () => [] },
        }),
      );
      expect(response?.textFormat).toBe('plain');
      expect(response?.rawText).toContain('/lore');
      expect(response?.rawText).toContain('/capabilities');
      expect(response?.rawText).toContain('/community');
      expect(response?.rawText).toContain('/anime <');
      expect(response?.rawText?.length).toBeGreaterThan(4096);
    }
  });

  it('keeps docs/COMMANDS.md and the README command pointer synchronized with runtime help', () => {
    const docs = readFileSync(join(process.cwd(), 'docs/COMMANDS.md'), 'utf8');
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    expect(docs).toContain(`Static commands: **${commandHandlers.length}**`);
    expect(readme).toContain(`**${commandHandlers.length} static slash commands**`);
    expect(readme).toContain('[`docs/COMMANDS.md`](docs/COMMANDS.md)');
    expect(readme).toContain('/help it');
    expect(readme).toContain('/help en');
    expect(readme).toContain('/help es');
    expect(docs).toContain('## Italiano');
    expect(docs).toContain('## English');
    expect(docs).toContain('## Español');
    for (const spec of commandHandlers) {
      const definition = COMMAND_HELP[spec.command]!;
      for (const language of ['italian', 'english', 'spanish'] as const) {
        expect(docs).toContain(`\`${definition.usage[language]}\``);
        expect(docs).toContain(definition.description[language]);
      }
      for (const alias of aliasesForCommand(spec)) expect(docs).toContain(`\`/${alias}\``);
    }
  });

  it('/help can override only its output language and appends installed dynamic commands', async () => {
    const localizer = new Localizer('italian');
    const response = await helpCommand.handle(
      input(
        {
          getLanguage: vi.fn().mockResolvedValue('italian'),
          localizer,
          capabilities: {
            list: () => [{ command: 'papers', description: 'Search technical papers' }],
          },
        },
        ['es'],
      ),
    );
    expect(response?.rawText).toContain('Chat y configuración');
    expect(response?.rawText).toContain('Comandos dinámicos instalados');
    expect(response?.rawText).toContain('/papers — Search technical papers');
    expect(response?.rawText).not.toContain('Chat e configurazione');

    const invalid = await helpCommand.handle(
      input(
        {
          getLanguage: vi.fn().mockResolvedValue('english'),
          localizer,
          capabilities: { list: () => [] },
        },
        ['de'],
      ),
    );
    expect(invalid).toMatchObject({ rawText: 'Usage: /help [it|en|es]', textFormat: 'plain' });
    expect(normalizeHelpLanguage('español')).toBe('spanish');
    expect(helpLanguageForChat('russian')).toBe('english');
  });
});

describe('dynamic capability commands', () => {
  it('/capabilities lists installed commands', async () => {
    const response = await capabilitiesCommand.handle(
      input({
        capabilities: {
          list: () => [{ command: 'papers', description: 'Search technical papers' }],
        },
      }),
    );
    expect(response).toMatchObject({
      text: 'capabilities_list',
      vars: {
        capabilities: {
          kind: 'trusted_html',
          value: '/<code>papers</code> — Search technical papers',
        },
      },
    });
  });

  it('/learn is bot-admin-only and refuses an empty acquisition request', async () => {
    expect(learnCommand.permissions).toContain('learn_admin');
    const response = await learnCommand.handle(input({ capabilities: {} }));
    expect(response?.text).toBe('learn_usage');
  });

  it('/learn status reports readiness without invoking the planner', async () => {
    const planForTurn = vi.fn();
    const response = await learnCommand.handle(
      input(
        {
          getLanguage: vi.fn().mockResolvedValue('italian'),
          planForTurn,
          capabilities: {
            status: () => ({
              enabled: true,
              chatModelReady: true,
              webGroundingReady: false,
              autoInstallResearch: true,
              installed: 2,
            }),
          },
        },
        ['stato'],
      ),
    );

    expect(response?.rawText).toContain('<strong>Stato Capability Forge</strong>');
    expect(response?.rawText).toContain('Web grounding: <code>non disponibile</code>');
    expect(response?.rawText).toContain('Capacità installate: <code>2</code>');
    expect(planForTurn).not.toHaveBeenCalled();
  });

  it('/learn distinguishes a verified install from a dependency-blocked existing command', async () => {
    const acquire = vi.fn().mockResolvedValue({
      handled: false,
      text: '/papers è installato, ma il grounding web non è configurato.',
      status: 'blocked_dependency',
      installed: true,
      command: 'papers',
      diagnostic: {
        code: 'web_grounding_unavailable',
        requirements: ['WEB_SEARCH_ENABLED', 'SEARXNG_URL'],
        requirementsVerified: true,
        retryable: false,
      },
      usage: { inputTokens: 0, outputTokens: 0, estimated: true },
      model: null,
      sources: [],
    });
    const response = await learnCommand.handle(
      input(
        {
          getLanguage: vi.fn().mockResolvedValue('italian'),
          planForTurn: vi.fn().mockResolvedValue({ id: 'free' }),
          modelForPlan: vi.fn().mockReturnValue(undefined),
          bypassesGroupPlan: vi.fn().mockReturnValue(true),
          capabilities: { acquire },
        },
        ['cerca', 'paper'],
      ),
    );

    expect(response?.rawText).toContain('Stato: <code>blocked_dependency</code>');
    expect(response?.rawText).toContain('<code>WEB_SEARCH_ENABLED</code>');
    expect(response?.rawText).not.toContain('✅');
  });

  it('/learn includes relevant replied text and never renders sources for local automation', async () => {
    const acquire = vi.fn().mockResolvedValue({
      handled: false,
      text: 'Proposta locale salvata per revisione.',
      status: 'proposal_saved',
      installed: false,
      command: 'fix_download',
      diagnostic: {
        code: 'local_automation_required',
        requirements: [],
        requirementsVerified: false,
        retryable: false,
      },
      usage: { inputTokens: 0, outputTokens: 0, estimated: true },
      model: null,
      sources: ['https://platform.openai.com/docs/irrelevant'],
    });
    const commandInput = input(
      {
        getLanguage: vi.fn().mockResolvedValue('italian'),
        planForTurn: vi.fn().mockResolvedValue({ id: 'free' }),
        modelForPlan: vi.fn().mockReturnValue(undefined),
        bypassesGroupPlan: vi.fn().mockReturnValue(true),
        capabilities: { acquire },
      },
      ['correggi', 'questo', 'bug'],
    );
    commandInput.context = {
      ...context,
      repliedToText: 'Il bot ignora i video oltre cinque minuti invece di estrarre tre frame.',
    };

    const response = await learnCommand.handle(commandInput);

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.stringContaining('correggi questo bug'),
      }),
    );
    const request = acquire.mock.calls[0]?.[0]?.request as string;
    expect(request).toContain('REPLIED MESSAGE CONTEXT');
    expect(request).toContain('Il bot ignora i video oltre cinque minuti');
    expect(response?.rawText).not.toContain('platform.openai.com');
  });

  it('/learn code queues a private immutable-admin development job without invoking Forge', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: '12345678-1234-1234-1234-123456789abc' });
    const acquire = vi.fn();
    const commandInput = input(
      {
        getLanguage: vi.fn().mockResolvedValue('italian'),
        localDevelopment: { enabled: true, enqueue },
        capabilities: { acquire },
      },
      ['code', 'aggiungi', 'un', 'comando', 'diagnostico', 'al', 'bot'],
    );
    commandInput.context = {
      ...context,
      chatId: person.telegramId,
      isGroup: false,
    };

    const response = await learnCommand.handle(commandInput);

    expect(enqueue).toHaveBeenCalledWith(
      {
        actorTelegramId: person.telegramId,
        chatId: person.telegramId,
        isGroup: false,
      },
      'aggiungi un comando diagnostico al bot',
    );
    expect(response?.rawText).toContain('Job <code>12345678</code> accodato');
    expect(acquire).not.toHaveBeenCalled();
  });

  it('/learn status renders the hash-bound diff/apply instructions for a ready job', async () => {
    const response = await learnCommand.handle(
      input(
        {
          getLanguage: vi.fn().mockResolvedValue('italian'),
          localDevelopment: {
            enabled: true,
            status: vi.fn().mockResolvedValue({
              id: '12345678-1234-1234-1234-123456789abc',
              state: 'ready',
              goal: 'aggiungi un comando diagnostico',
              artifactHash: 'a'.repeat(64),
              artifactFiles: ['src/example.ts'],
              resultCode: undefined,
            }),
          },
          capabilities: { status: vi.fn() },
        },
        ['status', '12345678'],
      ),
    );

    expect(response?.rawText).toContain('pronto per approvazione');
    expect(response?.rawText).toContain('SHA-256: <code>aaaaaaaaaaaa</code>');
    expect(response?.rawText).toContain('/learn apply 12345678 aaaaaaaaaaaa');
  });

  it('/learn diff exposes the complete artifact through deterministic pages', async () => {
    const text = `${'A'.repeat(1_800)}${'B'.repeat(1_800)}${'C'.repeat(200)}`;
    const response = await learnCommand.handle(
      input(
        {
          getLanguage: vi.fn().mockResolvedValue('italian'),
          localDevelopment: {
            diff: vi.fn().mockResolvedValue({
              job: { id: '12345678-1234-1234-1234-123456789abc' },
              artifact: {
                text,
                hash: 'a'.repeat(64),
                files: ['src/example.ts'],
              },
            }),
          },
        },
        ['diff', '12345678', '2'],
      ),
    );

    expect(response?.textFormat).toBe('plain');
    expect(response?.rawText).toContain('pagina 2/3');
    expect(response?.rawText).toContain('B'.repeat(100));
    expect(response?.rawText).not.toContain('A'.repeat(100));
    expect(response?.rawText).toContain('/learn diff 12345678 3');
  });
});

describe('privacy-safe social observability commands', () => {
  const now = new Date();
  const profile = {
    handle: '@alice',
    lastSeenAt: now,
    facets: [{ state: 'active' }, { state: 'superseded' }],
  };
  const state = {
    version: 7,
    relationships: [{ score: 0.91, fromHandle: '@alice', toHandle: '@bob' }],
    runningJokes: [{ state: 'active', label: 'The cursed printer' }],
    norms: [{ state: 'active' }],
  };
  const services = {
    storage: {
      socialProfiles: {
        listMembers: vi.fn().mockResolvedValue([profile]),
        getChatState: vi.fn().mockResolvedValue(state),
      },
    },
  };

  it('/community returns aggregate coverage and themes, never handles or private scores', async () => {
    const response = await communityCommand.handle(input(services));
    expect(response?.text).toBe('community_summary');
    expect(response?.vars).toMatchObject({
      members: 1,
      active_members: 1,
      facets: 1,
      jokes: 1,
      norms: 1,
      themes: 'The cursed printer',
    });
    expect(JSON.stringify(response?.vars)).not.toContain('@alice');
    expect(JSON.stringify(response?.vars)).not.toContain('0.91');
  });

  it('/socialstatus exposes lifecycle counts only and is admin-only', async () => {
    const response = await socialstatusCommand.handle(input(services));
    expect(socialstatusCommand.adminOnly).toBe(true);
    expect(response?.vars).toMatchObject({
      members: 1,
      active_facets: 1,
      lifecycle_facets: 1,
      relationships: 1,
      version: 7,
    });
    expect(JSON.stringify(response?.vars)).not.toContain('@alice');
    expect(JSON.stringify(response?.vars)).not.toContain('0.91');
  });
});
