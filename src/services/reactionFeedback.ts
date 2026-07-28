import type { Storage } from '../storage/index.js';

const POSITIVE_REACTIONS = new Set([
  '👍',
  '❤',
  '❤️',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🎉',
  '🤩',
  '👌',
  '💯',
  '🤣',
  '😂',
  '🏆',
  '❤‍🔥',
  '😍',
  '🤝',
  '🤗',
  '🫡',
]);

const NEGATIVE_REACTIONS = new Set(['👎', '🤮', '💩', '🤡', '🥱', '😴', '😡', '🤬', '😒']);

export function reactionFeedbackScore(emojis: string[]): -1 | 0 | 1 {
  let score = 0;
  for (const emoji of emojis) {
    if (POSITIVE_REACTIONS.has(emoji)) score += 1;
    if (NEGATIVE_REACTIONS.has(emoji)) score -= 1;
  }
  return score > 0 ? 1 : score < 0 ? -1 : 0;
}

export function isFeedbackReaction(emoji: string): boolean {
  return POSITIVE_REACTIONS.has(emoji) || NEGATIVE_REACTIONS.has(emoji);
}

/** Stable, Mongo-safe identity for user reactions and anonymous/channel reactions. */
export function telegramReactionActorKey(reaction: {
  user?: { id: number } | undefined;
  actor_chat?: { id: number } | undefined;
}): string | null {
  if (reaction.user) return `user_${reaction.user.id}`;
  if (reaction.actor_chat) return `chat_${reaction.actor_chat.id}`;
  return null;
}

/**
 * Apply explicit Telegram reactions to the exact generated reply. This is higher quality feedback
 * than guessing from later chat messages, and immediately changes the salience of any memories
 * that actually influenced that reply.
 */
export async function applyReactionFeedback(params: {
  storage: Storage;
  chatId: number;
  botMessageId: number;
  actorKey: string;
  emojis: string[];
}): Promise<boolean> {
  const score = reactionFeedbackScore(params.emojis);
  const reply = await params.storage.botReplies.findByMessageId(params.chatId, params.botMessageId);
  if (!reply?._id) return false;

  const reasons = params.emojis.map((emoji) => `telegram_reaction:${emoji}`).slice(0, 8);
  const change = await params.storage.botReplies.setReactionFeedback(
    reply._id,
    params.actorKey,
    score,
    reasons,
  );
  if (!change) return false;

  const salienceDelta =
    salienceContribution(change.currentScore) - salienceContribution(change.previousScore);
  const positiveCountDelta = Number(change.currentScore > 0) - Number(change.previousScore > 0);
  const negativeCountDelta = Number(change.currentScore < 0) - Number(change.previousScore < 0);
  if (salienceDelta !== 0 || positiveCountDelta !== 0 || negativeCountDelta !== 0) {
    for (const memoryId of reply.usedMemoryIds ?? []) {
      await params.storage.memoryItems.adjustReactionFeedback(
        memoryId,
        salienceDelta,
        positiveCountDelta,
        negativeCountDelta,
      );
    }
  }
  return true;
}

function salienceContribution(score: -1 | 0 | 1): number {
  return score > 0 ? 0.12 : score < 0 ? -0.16 : 0;
}
