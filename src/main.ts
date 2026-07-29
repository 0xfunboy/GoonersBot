import { InputFile } from 'grammy';
import { loadConfig } from './config/index.js';
import { createLLMProvider, createMiningLLMProvider } from './providers/llm/index.js';
import { Storage } from './storage/index.js';
import { Services } from './services/index.js';
import { createBot } from './telegram/bot.js';
import { Scheduler } from './jobs/scheduler.js';
import { buildMiningWindows, withContinuousMiningLock } from './jobs/memoryMiningJob.js';
import { KNOWLEDGE_SEED } from './knowledge/seed.js';
import { getLogger } from './utils/logger.js';
import { currentLlmUsage, runWithGroupPlan } from './providers/llm/requestContext.js';
import { renderTelegramText } from './telegram/format.js';

/**
 * One versioned historical pass seeds both projections with the same dedicated Gemma route.
 * Per-window checkpoints make restarts cheap and keep an invalid structured response retryable.
 */
async function runInitialCommunityBackfill(
  config: ReturnType<typeof loadConfig>,
  storage: Storage,
  services: Services,
): Promise<void> {
  await withContinuousMiningLock(async () => {
    const log = getLogger();
    for (const chatId of await storage.chats.listStartedChatIds(services.access.list().chats)) {
      const backfillJob = `community_backfill_gemma31b_v1:${chatId}`;
      try {
        if (await storage.jobs.lastRun(backfillJob)) continue;
        const messages = await storage.messages.getRecent(
          chatId,
          config.env.MAX_STORED_MESSAGES_PER_CHAT,
        );
        const windows = buildMiningWindows(
          messages,
          { timestamp: 0, messageId: 0 },
          config.env.MEMORY_MINING_BATCH_MESSAGES,
          config.env.MEMORY_MINING_CONTEXT_MESSAGES,
          config.env.MEMORY_MINING_MAX_WINDOW_BYTES,
        );
        const language = await storage.chats.getLanguage(chatId, config.env.DEFAULT_LANGUAGE);
        const nsfwEnabled =
          (await storage.chats.getNsfwMode(chatId, config.env.LLM_NSFW_DEFAULT_MODE)) !== 'off';
        const aggregate = {
          loreStored: 0,
          loreReinforced: 0,
          loreUpdated: 0,
          loreExpired: 0,
          socialProposed: 0,
          socialAccepted: 0,
          socialRejected: 0,
        };
        let complete = true;
        for (const [windowIndex, window] of windows.entries()) {
          const firstEvidence =
            window.eligibleSourceMessageIds[0] ??
            new Date(window.messages[0]?.message.timestamp ?? 0)
              .toISOString()
              .replace(/[^0-9]/g, '');
          const lastEvidence =
            window.eligibleSourceMessageIds.at(-1) ??
            new Date(window.messages.at(-1)?.message.timestamp ?? 0)
              .toISOString()
              .replace(/[^0-9]/g, '');
          const checkpoint = `${backfillJob}:window:${firstEvidence}-${lastEvidence}`;
          if (await storage.jobs.lastRun(checkpoint)) continue;
          try {
            const lore = await services.lore.mineAndStore({
              chatId,
              messages: window.messages,
              eligibleSourceMessageIds: window.eligibleSourceMessageIds,
              language,
              nsfwEnabled,
              minConfidence: config.env.MEMORY_AUTO_MIN_CONFIDENCE,
              source: 'auto',
              createdByHandle: null,
            });
            const social = await services.socialLearning.learn({
              chatId,
              messages: window.messages,
              eligibleSourceMessageIds: window.eligibleSourceMessageIds,
              language,
            });
            if (social.degraded) throw new Error('social structured extraction degraded');
            aggregate.loreStored += lore.stored;
            aggregate.loreReinforced += lore.reinforced;
            aggregate.loreUpdated += lore.updated;
            aggregate.loreExpired += lore.expired;
            aggregate.socialProposed += social.proposed;
            aggregate.socialAccepted += social.accepted;
            aggregate.socialRejected += social.rejected;
            await Promise.all([
              storage.chats.setLoreMiningCursor(chatId, window.cursor),
              storage.chats.setSocialMiningCursor(chatId, window.cursor),
              storage.jobs.record(checkpoint, 'done', {
                windowIndex,
                newHumanMessages: window.newHumanMessages,
                lore,
                social,
              }),
            ]);
          } catch (err) {
            complete = false;
            log.warn(
              { err, chatId, windowIndex },
              'Gemma community backfill window failed; checkpoint retained for retry',
            );
            break;
          }
        }
        // A structured/network failure usually means the shared mining endpoint is unhealthy.
        // Stop this attempt rather than hammering every remaining chat; the periodic bootstrap
        // retry resumes from the last per-window checkpoint.
        if (!complete) break;
        await storage.jobs.record(backfillJob, 'done', {
          ...aggregate,
          model: config.miningLlm.model,
          windows: windows.length,
          messages: messages.length,
        });
        log.info(
          {
            chatId,
            model: config.miningLlm.model,
            result: aggregate,
            windows: windows.length,
            messages: messages.length,
          },
          'community history backfilled with dedicated mining model',
        );
      } catch (err) {
        log.warn({ err, chatId }, 'initial community backfill failed; it will retry next boot');
      }
    }
  });
}

async function main(): Promise<void> {
  const log = getLogger();
  log.info('GoonersBot starting up');

  // 1. Config (fails fast on invalid/missing required env).
  const config = loadConfig();

  // 2. Storage.
  const storage = await Storage.connect(config.env);
  await storage.ensureIndexes();
  await storage.migrateLegacyFacts();
  if (config.env.KNOWLEDGE_SEED_ON_BOOT) {
    await storage.knowledge.upsertMany(KNOWLEDGE_SEED);
    log.info({ entries: KNOWLEDGE_SEED.length }, 'knowledge base seeded');
  }

  // 3. LLM provider (env-selected; capabilities logged).
  const llm = createLLMProvider(config.llm, config.embeddings);
  const miningLlm = createMiningLLMProvider(config.miningLlm);

  // 4. Services.
  const services = new Services(config, storage, llm, miningLlm);
  await services.capabilities.initialize();
  for (const chatId of await storage.chats.listStartedChatIds(services.access.list().chats)) {
    const members = await storage.chatMembers.listMembers(chatId);
    const totalMessagesByTelegramId = new Map<number, number>();
    for (const member of members) {
      const memberMessageCount = Number.isFinite(member.messageCount)
        ? Math.max(0, member.messageCount)
        : 0;
      totalMessagesByTelegramId.set(
        member.telegramId,
        (totalMessagesByTelegramId.get(member.telegramId) ?? 0) + memberMessageCount,
      );
    }
    for (const member of members) {
      const user = await storage.users.getByHandle(member.handle);
      await services.social.recordPresence({
        chatId,
        handle: member.handle,
        telegramId: member.telegramId,
        displayName:
          [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || undefined,
        alias: user?.firstName ?? undefined,
        seenAt: member.lastSeenAt,
        messageCountDelta: 0,
        // Legacy storage is keyed by mutable handle, so one Telegram user can have several rows.
        // The stable social identity should inherit the aggregate activity without adding it again
        // on every restart.
        minimumMessageCount:
          totalMessagesByTelegramId.get(member.telegramId) ?? member.messageCount,
      });
    }
    const memory = await services.lore.maintainLegacyMemory(chatId);
    const social = await services.social.maintain(chatId);
    if (memory.unsafeExpired || memory.cooled || social.members || social.chatState) {
      log.info({ chatId, memory, social }, 'social/memory lifecycle maintenance applied');
    }
  }

  // 5. Telegram bot.
  const goonerBot = await createBot(config, services);

  // 6. Background scheduler (incl. probabilistic autonomous posting into opted-in chats).
  const autopostTick = async (): Promise<void> => {
    const chats = await storage.chats.listForAutopost(services.access.list().chats);
    for (const c of chats) {
      if (services.isFreePlan(await services.planForChat(c.chatId))) continue;
      if (Math.random() >= config.auto.autopostProbability) continue;
      const post = await services.autonomousPoster.compose(c.language, undefined, {
        chatId: c.chatId,
      });
      if (!post) continue;
      try {
        const rendered = post.text ? renderTelegramText(post.text, 'markdown') : undefined;
        if (post.imageBuffer) {
          await goonerBot.bot.api.sendPhoto(
            c.chatId,
            new InputFile(post.imageBuffer),
            rendered ? { caption: rendered.text, parse_mode: rendered.parseMode } : {},
          );
        } else if (rendered) {
          await goonerBot.bot.api.sendMessage(c.chatId, rendered.text, {
            parse_mode: rendered.parseMode,
          });
        }
      } catch (err) {
        log.warn({ err, chatId: c.chatId }, 'autopost send failed');
      }
    }
  };
  const generatedImageTick = async (): Promise<void> => {
    const chats = await storage.chats.listForAutopost(services.access.list().chats);
    for (const c of chats) {
      const plan = await services.planForChat(c.chatId);
      if (services.isFreePlan(plan)) continue;
      if (Math.random() >= config.auto.generatedImageAutopostProbability) continue;
      const execution = await runWithGroupPlan(plan.id, async () => {
        const post = await services.generatedImagePoster.compose(c.chatId, c.language);
        return { post, usage: currentLlmUsage() };
      });
      const post = execution.post;
      const llmTokens = (execution.usage?.inputTokens ?? 0) + (execution.usage?.outputTokens ?? 0);
      await services.quota
        .recordLlmTokens(c.chatId, llmTokens)
        .catch((err) =>
          log.warn({ err, chatId: c.chatId }, 'generated image autopost token accounting failed'),
        );
      if (!post) continue;
      try {
        const rendered = renderTelegramText(post.text, 'markdown');
        await goonerBot.bot.api.sendPhoto(c.chatId, new InputFile(post.imageBuffer), {
          caption: rendered.text,
          parse_mode: rendered.parseMode,
          ...(post.imageSpoiler ? { has_spoiler: true } : {}),
        });
        log.info(
          {
            chatId: c.chatId,
            llmCalls: execution.usage?.calls ?? 0,
            llmTokens,
            imageCalls: post.generationAttempts,
            visionCalls: post.visionCalls,
          },
          'generated image autopost delivered',
        );
      } catch (err) {
        log.warn({ err, chatId: c.chatId }, 'generated image autopost send failed');
      }
    }
  };
  const scheduler = new Scheduler(
    config,
    storage,
    services.lore,
    autopostTick,
    generatedImageTick,
    services.socialLearning,
    () => services.access.list().chats,
  );
  scheduler.start();

  // 7. Start polling.
  await goonerBot.start();
  log.info('GoonersBot is live');
  // The first historical extraction can spend an LLM timeout budget. Polling must be live before
  // that
  // work starts, otherwise one exhausted provider can make a healthy bot look offline for minutes.
  let communityBackfillRunning = false;
  const runCommunityBackfill = (): void => {
    if (communityBackfillRunning) return;
    communityBackfillRunning = true;
    void runInitialCommunityBackfill(config, storage, services)
      .catch((err) =>
        log.warn({ err }, 'community backfill attempt failed; checkpoints will retry'),
      )
      .finally(() => {
        communityBackfillRunning = false;
      });
  };
  const communityBackfillTimer = setTimeout(runCommunityBackfill, 1_000);
  communityBackfillTimer.unref();
  const communityBackfillRetry = setInterval(runCommunityBackfill, 5 * 60_000);
  communityBackfillRetry.unref();

  // Graceful shutdown on signals (restart-friendly; no destructive teardown).
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down gracefully');
    scheduler.stop();
    try {
      await goonerBot.stop();
    } catch (err) {
      log.warn({ err }, 'error stopping bot');
    }
    try {
      await storage.close();
    } catch (err) {
      log.warn({ err }, 'error closing storage');
    }
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
