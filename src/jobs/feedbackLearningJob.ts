import type { AppConfig } from '../config/index.js';
import type { Storage } from '../storage/index.js';
import type { LoreEngine } from '../memory/loreEngine.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('job-feedback');

const POSITIVE_RE =
  /(\bah+ah+\b|\blol\b|\blmao\b|\bmuoio\b|\bperfetto\b|\bgenio\b|\btop\b|\bbased\b|😂|🤣|😭|💀|❤️|🔥|👏|👍)/i;
const NEGATIVE_RE =
  /(\bripetitiv|\bnoios|\bstupid|\bnon fa ridere\b|\bbot rotto\b|\bnpc\b|\bsempre uguale\b|\bche cazzo dici\b|\bcringe\b|\bscemo\b|👎)/i;

/** Infer a feedback score in [-1, 1] from the messages that followed a bot reply. */
export function inferFeedback(texts: string[]): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const t of texts) {
    if (POSITIVE_RE.test(t)) {
      score += 1;
      reasons.push('positive');
    }
    if (NEGATIVE_RE.test(t)) {
      score -= 1;
      reasons.push('negative');
    }
  }
  const clamped = Math.max(-1, Math.min(1, score));
  return { score: clamped, reasons };
}

/**
 * Feedback observer: looks at the messages following each unscored bot reply, infers whether it
 * landed, and adapts - boosts/penalizes the salience of memories the reply used. Lets recent bad
 * feedback make future autoengage more conservative (read at decision time from bot_replies).
 */
export async function runFeedbackLearningJob(
  storage: Storage,
  lore: LoreEngine,
  config: AppConfig,
): Promise<void> {
  if (!config.env.FEEDBACK_LEARNING_ENABLED) return;
  const lookahead = config.env.FEEDBACK_LOOKAHEAD_MESSAGES;
  const minAgeMs = 60 * 1000; // give the chat a minute to react before scoring
  const now = Date.now();
  const chatIds = await storage.chats.listStartedChatIds();

  for (const chatId of chatIds) {
    try {
      const unscored = await storage.botReplies.getUnscored(chatId, 25);
      for (const reply of unscored) {
        if (now - new Date(reply.createdAt).getTime() < minAgeMs) continue;
        const following = await storage.messages.getMessagesSince(
          chatId,
          reply.createdAt,
          lookahead,
        );
        const human = following.filter((m) => !m.isBot);
        if (human.length === 0) continue;
        const { score, reasons } = inferFeedback(human.map((m) => m.message.messageText ?? ''));
        if (reply._id) await storage.botReplies.setFeedback(reply._id, score, reasons);
        if (score !== 0) {
          for (const memId of reply.usedMemoryIds) {
            await lore.adjustSalience(memId, score > 0 ? 0.1 : -0.1, score > 0);
          }
        }
      }
    } catch (err) {
      log.warn({ err, chatId }, 'feedback job failed for chat');
    }
  }
}
