import { describe, expect, it } from 'vitest';
import { AutoEngageScorer, type AutoEngageInputs } from '../src/services/autoengage.js';
import { fakeLLM } from './helpers.js';

function inputs(): AutoEngageInputs {
  return {
    person: { telegramId: 1, userHandle: '@bob' },
    context: {
      chatId: -100,
      isGroup: true,
      isBotMentioned: false,
      isGroupAdmin: false,
      isReplyToBot: false,
    },
    currentMessage: 'hello chat',
    modeName: 'Default',
    modeDescription: 'natural participant',
    history: [],
    userFacts: [],
    groupFacts: [],
  };
}

const cfg = {
  maxRepliesPerChatPerHour: 100,
  chatCooldownSeconds: 60,
  userCooldownSeconds: 30,
  minConfidence: 0.6,
};

describe('AutoEngageScorer', () => {
  it('replies almost always when directly addressed', async () => {
    const scorer = new AutoEngageScorer(fakeLLM({ score: { shouldReply: false } }), cfg);
    const d = await scorer.decide(inputs(), true, false);
    expect(d.shouldReply).toBe(true);
    expect(d.reason).toMatch(/addressed/);
  });

  it('does not engage passively when autoengage is disabled', async () => {
    const scorer = new AutoEngageScorer(fakeLLM({}), cfg);
    const d = await scorer.decide(inputs(), false, false);
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toMatch(/disabled/);
  });

  it('engages passively when enabled and confidence is high', async () => {
    const scorer = new AutoEngageScorer(
      fakeLLM({ score: { shouldReply: true, confidence: 0.9 } }),
      cfg,
    );
    const d = await scorer.decide(inputs(), false, true);
    expect(d.shouldReply).toBe(true);
  });

  it('declines when confidence is below threshold', async () => {
    const scorer = new AutoEngageScorer(
      fakeLLM({ score: { shouldReply: true, confidence: 0.2 } }),
      cfg,
    );
    const d = await scorer.decide(inputs(), false, true);
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toMatch(/confidence/);
  });

  it('declines high-risk replies', async () => {
    const scorer = new AutoEngageScorer(
      fakeLLM({ score: { shouldReply: true, confidence: 0.9, risk: 'high' } }),
      cfg,
    );
    const d = await scorer.decide(inputs(), false, true);
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toMatch(/risk/);
  });

  it('respects the per-hour reply cap even for mentions', async () => {
    const scorer = new AutoEngageScorer(fakeLLM({}), { ...cfg, maxRepliesPerChatPerHour: 1 });
    scorer.noteReply(-100, '@bob');
    const d = await scorer.decide(inputs(), true, true);
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toMatch(/cap/);
  });

  it('respects the chat cooldown for passive engagement', async () => {
    const scorer = new AutoEngageScorer(
      fakeLLM({ score: { shouldReply: true, confidence: 0.9 } }),
      cfg,
    );
    scorer.noteReply(-100, '@alice'); // advances chat cooldown
    const d = await scorer.decide(inputs(), false, true);
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toMatch(/cooldown/);
  });

  it('does not engage when scoring throws', async () => {
    const llm = fakeLLM({});
    llm.scoreAutoEngage = async () => {
      throw new Error('boom');
    };
    const scorer = new AutoEngageScorer(llm, cfg);
    const d = await scorer.decide(inputs(), false, true);
    expect(d.shouldReply).toBe(false);
  });
});
