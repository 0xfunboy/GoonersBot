import { Bot } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { Services } from '../services/index.js';
import { commandHandlers } from './handlers/commands/index.js';
import { callbackHandlers } from './handlers/callbacks/index.js';
import { handleMessage } from './handlers/message.js';
import { runCallback, runCommand, type DispatchDeps } from './dispatch.js';
import { buildChatContext, buildIncomingMessage, buildPerson, isBotAddressed } from './context.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('bot');

export interface GoonersBot {
  bot: Bot;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function createBot(config: AppConfig, services: Services): Promise<GoonersBot> {
  const bot = new Bot(config.env.TELEGRAM_BOT_TOKEN);

  // Resolve the real bot username (used for mention detection) - env value is a default/hint.
  const me = await bot.api.getMe();
  const botUsername = me.username ?? config.env.BOT_USERNAME.replace(/^@/, '');
  log.info({ botUsername, id: me.id }, 'authenticated with Telegram');

  const deps: DispatchDeps = { services, botUsername };

  // Register commands (with any aliases; only the canonical name appears in the menu).
  for (const spec of commandHandlers) {
    const names = [spec.command, ...(spec.aliases ?? [])];
    bot.command(names, (ctx) => runCommand(ctx, spec, deps));
  }

  // Register callback handlers (match by action prefix on callback_data).
  for (const spec of callbackHandlers) {
    bot.callbackQuery(new RegExp(`^${spec.action}(\\||$)`), (ctx) => runCallback(ctx, spec, deps));
  }

  // Free-text / media messages (not commands) go to the conversational handler.
  bot.on(
    [
      'message:text',
      'message:voice',
      'message:audio',
      'message:video',
      'message:video_note',
      'message:photo',
      'message:caption',
    ],
    async (ctx) => {
      // Ignore commands here (handled above).
      if (ctx.message?.text?.startsWith('/')) return;
      const person = buildPerson(ctx);
      const context = await buildChatContext(ctx, botUsername);
      if (!person || !context) return;
      const { mentioned, replyToBot } = isBotAddressed(ctx, botUsername);
      const addressed = mentioned || replyToBot;
      // Unaddressed group traffic is stored as text-only context. Never download media or send it
      // through inference until someone explicitly mentions or replies to the bot.
      const wantVoice = addressed;
      const message = await buildIncomingMessage(ctx, { image: addressed, voice: wantVoice });
      await handleMessage(ctx, person, context, message, {
        services,
        env: config.env,
        botUsername,
      });
    },
  );

  // Global error handler - never crash the bot on a single update.
  bot.catch((err) => {
    log.error({ err: err.error, update: err.ctx.update.update_id }, 'unhandled error in update');
  });

  // Publish the command menu (sorted by priority then name).
  const menu = [...commandHandlers]
    .sort((a, b) => a.priority - b.priority || a.command.localeCompare(b.command))
    .map((c) => ({
      command: c.command,
      description:
        services.localizer.t(`${c.command}_description`, {}, config.env.DEFAULT_LANGUAGE) ??
        'GoonersBot command',
    }));
  await bot.api.setMyCommands(menu).catch((err) => log.warn({ err }, 'setMyCommands failed'));

  return {
    bot,
    start: async () => {
      log.info('starting long-polling');
      // grammY start() resolves only when the bot stops; run it detached.
      void bot.start({ drop_pending_updates: false });
    },
    stop: async () => {
      await bot.stop();
    },
  };
}
