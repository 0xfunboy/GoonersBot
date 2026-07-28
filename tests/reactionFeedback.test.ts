import { describe, expect, it, vi } from 'vitest';
import {
  applyReactionFeedback,
  isFeedbackReaction,
  reactionFeedbackScore,
  telegramReactionActorKey,
} from '../src/services/reactionFeedback.js';

describe('Telegram reaction feedback', () => {
  it('scores explicit reactions and lets mixed signals cancel out', () => {
    expect(reactionFeedbackScore(['🔥', '👍'])).toBe(1);
    expect(reactionFeedbackScore(['🤡', '👎'])).toBe(-1);
    expect(reactionFeedbackScore(['🔥', '👎'])).toBe(0);
    expect(reactionFeedbackScore(['👀'])).toBe(0);
    expect(isFeedbackReaction('🔥')).toBe(true);
    expect(isFeedbackReaction('👀')).toBe(false);
    expect(telegramReactionActorKey({ user: { id: 42 } })).toBe('user_42');
    expect(telegramReactionActorKey({ actor_chat: { id: -100 } })).toBe('chat_-100');
  });

  it('scores the exact reply and adjusts only memories that influenced it', async () => {
    const setReactionFeedback = vi.fn().mockResolvedValue({ previousScore: 0, currentScore: 1 });
    const adjustReactionFeedback = vi.fn().mockResolvedValue(undefined);
    const storage = {
      botReplies: {
        findByMessageId: vi.fn().mockResolvedValue({
          _id: '507f1f77bcf86cd799439011',
          usedMemoryIds: ['m1', 'm2'],
        }),
        setReactionFeedback,
      },
      memoryItems: { adjustReactionFeedback },
    };
    const applied = await applyReactionFeedback({
      storage: storage as never,
      chatId: -100,
      botMessageId: 42,
      actorKey: 'user_7',
      emojis: ['🔥'],
    });

    expect(applied).toBe(true);
    expect(setReactionFeedback).toHaveBeenCalledWith('507f1f77bcf86cd799439011', 'user_7', 1, [
      'telegram_reaction:🔥',
    ]);
    expect(adjustReactionFeedback).toHaveBeenCalledTimes(2);
    expect(adjustReactionFeedback).toHaveBeenCalledWith('m1', 0.12, 1, 0);
  });

  it('is idempotent on redelivery and applies only the correction when a vote changes', async () => {
    const setReactionFeedback = vi
      .fn()
      .mockResolvedValueOnce({ previousScore: 1, currentScore: 1 })
      .mockResolvedValueOnce({ previousScore: 1, currentScore: -1 });
    const adjustReactionFeedback = vi.fn().mockResolvedValue(undefined);
    const storage = {
      botReplies: {
        findByMessageId: vi.fn().mockResolvedValue({
          _id: '507f1f77bcf86cd799439011',
          usedMemoryIds: ['m1'],
        }),
        setReactionFeedback,
      },
      memoryItems: { adjustReactionFeedback },
    };

    const base = {
      storage: storage as never,
      chatId: -100,
      botMessageId: 42,
      actorKey: 'user_7',
    };
    await applyReactionFeedback({ ...base, emojis: ['🔥'] });
    expect(adjustReactionFeedback).not.toHaveBeenCalled();

    await applyReactionFeedback({ ...base, emojis: ['👎'] });
    expect(adjustReactionFeedback).toHaveBeenCalledOnce();
    // Undo the old +0.12 and apply the new -0.16; counters are corrected as well.
    expect(adjustReactionFeedback).toHaveBeenCalledWith('m1', -0.28, -1, 1);
  });
});
