import { InputFile } from 'grammy';
import { loadConfig } from './config/index.js';
import { createLLMProvider } from './providers/llm/index.js';
import { Storage } from './storage/index.js';
import { Services } from './services/index.js';
import { createBot } from './telegram/bot.js';
import { Scheduler } from './jobs/scheduler.js';
import { KNOWLEDGE_SEED } from './knowledge/seed.js';
import { getLogger } from './utils/logger.js';

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
  const llm = createLLMProvider(config.llm);

  // 4. Services.
  const services = new Services(config, storage, llm);

  // 5. Telegram bot.
  const goonerBot = await createBot(config, services);

  // 6. Background scheduler (incl. probabilistic autonomous posting into opted-in chats).
  const autopostTick = async (): Promise<void> => {
    const chats = await storage.chats.listForAutopost();
    for (const c of chats) {
      if (Math.random() >= config.auto.autopostProbability) continue;
      const post = await services.autonomousPoster.compose(c.language, undefined, {
        chatId: c.chatId,
      });
      if (!post) continue;
      try {
        if (post.imageBuffer) {
          await goonerBot.bot.api.sendPhoto(
            c.chatId,
            new InputFile(post.imageBuffer),
            post.text ? { caption: post.text } : {},
          );
        } else if (post.text) {
          await goonerBot.bot.api.sendMessage(c.chatId, post.text);
        }
      } catch (err) {
        log.warn({ err, chatId: c.chatId }, 'autopost send failed');
      }
    }
  };
  const scheduler = new Scheduler(config, storage, services.lore, autopostTick);
  scheduler.start();

  // 7. Start polling.
  await goonerBot.start();
  log.info('GoonersBot is live');

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
