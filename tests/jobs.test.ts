import { describe, expect, it, vi } from 'vitest';
import { inferFeedback, runFeedbackLearningJob } from '../src/jobs/feedbackLearningJob.js';
import type { AppConfig } from '../src/config/index.js';
import type { LoreEngine } from '../src/memory/loreEngine.js';
import type { Storage } from '../src/storage/index.js';

describe('inferFeedback', () => {
  it('scores positive reactions', () => {
    const { score } = inferFeedback(['ahahah muoio', 'top 😂']);
    expect(score).toBeGreaterThan(0);
  });
  it('scores negative reactions', () => {
    const { score, reasons } = inferFeedback(['sei ripetitivo', 'che cazzo dici']);
    expect(score).toBeLessThan(0);
    expect(reasons).toContain('negative');
  });
  it('neutral when no signal', () => {
    expect(inferFeedback(['ok', 'va bene']).score).toBe(0);
  });
});

describe('feedback attribution', () => {
  it('does not train a reply from unrelated later group chatter', async () => {
    const setFeedback = vi.fn(async () => undefined);
    const adjustSalience = vi.fn(async () => undefined);
    const createdAt = new Date(Date.now() - 20 * 60_000);
    const storage = {
      chats: { listStartedChatIds: async () => [-100] },
      botReplies: {
        getUnscored: async () => [
          {
            _id: '507f1f77bcf86cd799439011',
            chatId: -100,
            messageId: 42,
            createdAt,
            text: 'bot reply',
            normalizedText: 'bot reply',
            fingerprint: 'x',
            usedMemoryIds: ['507f1f77bcf86cd799439012'],
          },
        ],
        setFeedback,
      },
      messages: {
        getMessagesSince: async () => [
          {
            isBot: false,
            replyToMessageId: 999,
            message: {
              messageText: 'ahah top 😂',
              timestamp: new Date(createdAt.getTime() + 2 * 60_000),
            },
          },
        ],
      },
    } as unknown as Storage;
    const config = {
      env: {
        FEEDBACK_LEARNING_ENABLED: true,
        FEEDBACK_LOOKAHEAD_MESSAGES: 8,
      },
    } as AppConfig;
    await runFeedbackLearningJob(storage, { adjustSalience } as unknown as LoreEngine, config);
    expect(setFeedback).toHaveBeenCalledWith('507f1f77bcf86cd799439011', 0, [
      'no_explicit_feedback',
    ]);
    expect(adjustSalience).not.toHaveBeenCalled();
  });
});
