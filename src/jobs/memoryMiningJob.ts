import type { AppConfig } from '../config/index.js';
import type { Storage } from '../storage/index.js';
import type { LoreEngine } from '../memory/loreEngine.js';
import type { GroupQuotaService } from '../services/groupQuota.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('job-mining');

/**
 * Background memory mining: while the bot is silent, learn durable lore from active chats that have
 * /autofact enabled. Dedup-aware (reinforces instead of duplicating), so periodic runs are safe.
 */
export async function runMemoryMiningJob(
  storage: Storage,
  lore: LoreEngine,
  quota: GroupQuotaService,
  config: AppConfig,
): Promise<void> {
  if (!config.env.MEMORY_MINING_ENABLED) return;
  const env = config.env;
  const chats = await storage.chats.listForMining();
  for (const chat of chats) {
    try {
      // Free is direct-request only: no background LLM work while the group is idle.
      if ((await quota.getReport(chat.chatId)).plan.id === 'free') continue;
      const messages = await storage.messages.getRecent(
        chat.chatId,
        env.FACT_EXTRACTION_CONTEXT_MESSAGES,
      );
      const humanMessages = messages.filter((m) => !m.isBot);
      if (humanMessages.length < env.MEMORY_MINING_MIN_ACTIVE_MESSAGES) continue;

      // Skip idle chats: only spend an LLM call when there are NEW human messages since the last
      // mining run. Without this the same unchanged window is re-mined every interval forever.
      const ts = (m: (typeof messages)[number]): number => new Date(m.message.timestamp).getTime();
      const lastMinedAt = await storage.chats.getLastMinedAt(chat.chatId);
      const newestTs = Math.max(...messages.map((m) => ts(m)));
      const newHuman = humanMessages.filter((m) => ts(m) > lastMinedAt).length;
      if (newHuman === 0) continue;

      const res = await lore.mineAndStore({
        chatId: chat.chatId,
        messages,
        language: chat.language,
        nsfwEnabled: chat.nsfwMode !== 'off',
        minConfidence: env.MEMORY_AUTO_MIN_CONFIDENCE,
        source: 'auto',
        createdByHandle: null,
      });
      // Mark this window as processed so it is not re-mined until new activity arrives.
      await storage.chats.setLastMinedAt(chat.chatId, newestTs);
      if (res.stored > 0 || res.reinforced > 0) {
        await storage.jobs.record('memory_mining', 'done', {
          chatId: chat.chatId,
          stored: res.stored,
          reinforced: res.reinforced,
        });
      }
    } catch (err) {
      log.warn({ err, chatId: chat.chatId }, 'mining failed for chat');
    }
  }
}
