import { Bot } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { Services } from '../services/index.js';
import { commandHandlers } from './handlers/commands/index.js';
import { callbackHandlers } from './handlers/callbacks/index.js';
import { handleMessage } from './handlers/message.js';
import { runCallback, runCommand, type DispatchDeps } from './dispatch.js';
import { buildChatContext, buildIncomingMessage, buildPerson, isBotAddressed } from './context.js';
import { childLogger } from '../utils/logger.js';
import { runWithGroupPlan } from '../providers/llm/requestContext.js';
import { aliasesForCommand, menuNameForCommand } from './handlers/commands/aliases.js';
import { extractUrls } from '../providers/media/linkMedia/url.js';
import {
  applyReactionFeedback,
  isFeedbackReaction,
  telegramReactionActorKey,
} from '../services/reactionFeedback.js';
import {
  executeDynamicCapabilityTurn,
  tryAcquireDynamicCommandRateLimit,
} from './handlers/commands/dynamic.js';
import { localizeResponse, sendResponse } from './render.js';
import { renderTelegramText, splitTelegramMarkdown, telegramPlainText } from './format.js';
import { auditApprovedChatMemberships, persistMyChatMemberUpdate } from './membership.js';

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

  // Refresh membership before any scheduler is started. Mining/autopost queries fail closed until
  // Telegram has confirmed that an approved chat still contains the bot.
  await auditApprovedChatMemberships(bot, services, me.id);

  services.capabilities.reserveCommands(
    commandHandlers.flatMap((spec) => [
      spec.command,
      ...aliasesForCommand(spec),
      menuNameForCommand(spec),
    ]),
  );

  // Register every English/Italian alias; the menu exposes the English baseline below.
  for (const spec of commandHandlers) {
    const names = [spec.command, ...aliasesForCommand(spec)];
    bot.command(names, (ctx) => runCommand(ctx, spec, deps));
  }

  // Register callback handlers (match by action prefix on callback_data).
  for (const spec of callbackHandlers) {
    bot.callbackQuery(new RegExp(`^${spec.action}(\\||$)`), (ctx) => runCallback(ctx, spec, deps));
  }

  // Telegram reactions are explicit, message-level feedback. Observe both additions and removals
  // so changing a reaction corrects the score instead of leaving stale positive/negative feedback.
  bot.on('message_reaction', async (ctx) => {
    const diff = ctx.reactions();
    if (![...diff.emojiAdded, ...diff.emojiRemoved].some(isFeedbackReaction)) return;
    const actorKey = telegramReactionActorKey(ctx.messageReaction);
    if (!actorKey) return;
    await applyReactionFeedback({
      storage: services.storage,
      chatId: ctx.messageReaction.chat.id,
      botMessageId: ctx.messageReaction.message_id,
      actorKey,
      emojis: diff.emoji,
    });
  });

  // Telegram emits this update when the bot is added, promoted, demoted, removed or banned.
  // Persist it independently of ordinary messages: a kicked bot cannot receive a final message
  // from the group with which to repair stale local state.
  bot.on('my_chat_member', async (ctx) => {
    const membership = ctx.update.my_chat_member;
    const chatName = 'title' in membership.chat ? membership.chat.title : undefined;
    await persistMyChatMemberUpdate(services, {
      updateId: ctx.update.update_id,
      chatId: membership.chat.id,
      chatName,
      oldStatus: membership.old_chat_member.status,
      newStatus: membership.new_chat_member.status,
      occurredAt: new Date(membership.date * 1_000),
    });
  });

  // Free-text / media messages (not commands) go to the conversational handler.
  bot.on(
    [
      'message:text',
      'message:voice',
      'message:audio',
      'message:video',
      'message:video_note',
      'message:photo',
      'message:document',
      'message:caption',
    ],
    async (ctx) => {
      const commandMatch = ctx.message?.text?.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
      if (commandMatch) {
        const command = commandMatch[1]?.toLowerCase() ?? '';
        const input = commandMatch[2]?.trim() ?? '';
        // Registered static commands stop in their own middleware. Unknown slash commands are
        // handled here only when CapabilityForge owns a non-reserved route.
        if (!services.capabilities.hasCommand(command)) return;
        if (!tryAcquireDynamicCommandRateLimit(services, ctx.chat?.id ?? 0, ctx.from?.id ?? 0)) {
          log.debug(
            { chatId: ctx.chat?.id, telegramId: ctx.from?.id, command },
            'dynamic command rate-limited',
          );
          return;
        }

        const person = buildPerson(ctx);
        const context = await buildChatContext(ctx, botUsername);
        if (!person || !context) return;
        await services.initializeContext(person, context);
        if (
          !(await services.permissions.checkAll(['allowed_user', 'not_banned'], person, context)) ||
          !(await services.terms.hasAccepted(person.userHandle)) ||
          !services.isApproved(person, context)
        ) {
          return;
        }

        const result = await executeDynamicCapabilityTurn({
          services,
          person,
          context,
          command,
          input,
          language: await services.getLanguage(context.chatId),
        });
        if (result.status === 'usage_denied') {
          const localized = await localizeResponse(services, context.chatId, {
            text: 'usage_limit_exceeded',
            vars: { user_handle: person.userHandle, usage_limit: result.limit },
          });
          await sendResponse(ctx, localized);
        } else if (result.status === 'quota_denied') {
          const localized = await localizeResponse(services, context.chatId, {
            text: 'group_quota_exceeded',
            vars: {
              reason: result.reason,
              retry_after: result.retryAfterSeconds,
            },
          });
          await sendResponse(ctx, localized);
        } else if (result.status === 'completed') {
          const chunks = splitTelegramMarkdown(result.execution.text);
          for (const [index, chunk] of chunks.entries()) {
            const rendered = renderTelegramText(chunk, 'markdown');
            await ctx
              .reply(rendered.text, { parse_mode: rendered.parseMode })
              .catch(async (err) => {
                log.warn({ err, command, index }, 'dynamic command formatted send failed');
                await ctx.reply(telegramPlainText(chunk, 'markdown'));
              });
          }
        }
        return;
      }

      const person = buildPerson(ctx);
      const context = await buildChatContext(ctx, botUsername);
      if (!person || !context) return;
      const { mentioned, replyToBot } = isBotAddressed(ctx, botUsername);
      const addressed = mentioned || replyToBot;
      // Unaddressed traffic stays text-only. It enters inference only when this chat explicitly
      // enabled /autoengage; otherwise it remains free background context.
      const wantVoice = addressed;
      const message = await buildIncomingMessage(ctx, {
        image: addressed,
        voice: wantVoice,
        documents: addressed,
      });
      const autoengageEnabled =
        !addressed && (await services.storage.chats.getAutoengage(context.chatId));
      const hasMediaUrl =
        Boolean(message.messageText) &&
        extractUrls(message.messageText, config.linkMedia.maxUrlsPerMessage).length > 0;
      if (!addressed && !autoengageEnabled && !hasMediaUrl) {
        await handleMessage(ctx, person, context, message, {
          services,
          env: config.env,
          botUsername,
        });
        return;
      }
      const plan = await services.planForTurn(person, context);
      await runWithGroupPlan(plan.id, () =>
        handleMessage(ctx, person, context, message, {
          services,
          env: config.env,
          botUsername,
        }),
      );
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
      command: menuNameForCommand(c),
      description:
        services.localizer.t(`${c.command}_description`, {}, 'english') ?? 'GoonersBot command',
    }));
  await bot.api.setMyCommands(menu).catch((err) => log.warn({ err }, 'setMyCommands failed'));

  return {
    bot,
    start: async () => {
      log.info('starting long-polling');
      // grammY start() resolves only when the bot stops; run it detached.
      void bot
        .start({
          drop_pending_updates: false,
          allowed_updates: ['message', 'callback_query', 'message_reaction', 'my_chat_member'],
        })
        .catch((err) => {
          log.error({ err }, 'long-polling stopped unexpectedly');
          // Let systemd's restart policy recover instead of leaving a healthy-looking dead process.
          process.exit(1);
        });
    },
    stop: async () => {
      await bot.stop();
    },
  };
}
