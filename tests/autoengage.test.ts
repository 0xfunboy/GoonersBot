import { describe, expect, it } from 'vitest';
import {
  analyzeConversationInvolvement,
  AutoEngageScorer,
  type AutoEngageInputs,
} from '../src/services/autoengage.js';
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
    currentMessage: 'questa roba mi sembra davvero assurda, voi che ne pensate?',
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

  it('engages passively only as a tiny no-memory interjection when confidence is high', async () => {
    const scorer = new AutoEngageScorer(
      fakeLLM({ score: { shouldReply: true, confidence: 0.9 } }),
      cfg,
    );
    const d = await scorer.decide(inputs(), false, true);
    expect(d.shouldReply).toBe(true);
    expect(d.maxReplyLength).toBe('tiny');
    expect(d.shouldUseMemory).toBe(false);
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

  it('does not spend a model request on short human backchannel fragments such as "13 mesi"', async () => {
    const llm = fakeLLM({ score: { shouldReply: true, confidence: 0.99 } });
    let calls = 0;
    const original = llm.scoreAutoEngage.bind(llm);
    llm.scoreAutoEngage = async (request) => {
      calls += 1;
      return original(request);
    };
    const scorer = new AutoEngageScorer(llm, cfg);
    const d = await scorer.decide({ ...inputs(), currentMessage: '13 mesi' }, false, true);
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toMatch(/low-information/);
    expect(calls).toBe(0);
  });

  it('recognises an indirect reply chain that descends from a bot message', () => {
    const history = [
      {
        messageId: 179,
        handle: 'bot',
        isBot: true,
        message: { messageText: 'oh no, un memory leak', timestamp: new Date() },
      },
      {
        messageId: 180,
        handle: '@berry',
        isBot: false,
        replyToMessageId: 179,
        replyToHandle: '@GooNeuroBot',
        message: {
          messageText: 'ti ha fatto crashare una volta, posso farlo ancora',
          timestamp: new Date(),
        },
      },
    ];
    const involvement = analyzeConversationInvolvement({
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: false,
        isReplyToBot: false,
        isGroupAdmin: false,
        repliedToMessageId: 180,
        repliedToUserHandle: '@berry',
      },
      history,
      botUsername: '@GooNeuroBot',
    });
    expect(involvement.kind).toBe('reply_chain');
    expect(involvement.replyDepth).toBeGreaterThan(0);
  });

  it('treats a depth-2 bot reply branch as semi-addressed even if the passive scorer is over-cautious', async () => {
    const llm = fakeLLM({ score: { shouldReply: false, confidence: 0.9, risk: 'low' } });
    const scorer = new AutoEngageScorer(llm, { ...cfg, minConfidence: 0.78 });
    const d = await scorer.decide(
      {
        ...inputs(),
        currentMessage: 'Io ed Erika abbiamo perso il conto',
        botUsername: '@GooNeuroBot',
        context: {
          ...inputs().context,
          repliedToMessageId: 180,
          repliedToUserHandle: '@berry',
          repliedToText: 'Non mi fai paura. Ti ha fatto crashare una volta, posso farlo ancora',
        },
        history: [
          {
            messageId: 179,
            handle: 'bot',
            isBot: true,
            message: { messageText: 'oh no, un memory leak', timestamp: new Date() },
          },
          {
            messageId: 180,
            handle: '@berry',
            isBot: false,
            replyToMessageId: 179,
            replyToHandle: '@GooNeuroBot',
            message: {
              messageText: 'ti ha fatto crashare una volta, posso farlo ancora',
              timestamp: new Date(),
            },
          },
        ],
      },
      false,
      true,
    );
    expect(d.shouldReply).toBe(true);
    expect(d.reason).toMatch(/reply-chain/i);
  });

  it('does not force semi-addressed participation immediately after negative feedback', async () => {
    const llm = fakeLLM({ score: { shouldReply: false, confidence: 0.9, risk: 'low' } });
    const scorer = new AutoEngageScorer(llm, { ...cfg, minConfidence: 0.78 });
    const d = await scorer.decide(
      {
        ...inputs(),
        currentMessage: 'Io ed Erika abbiamo perso il conto',
        recentNegativeFeedback: true,
        botUsername: '@GooNeuroBot',
        context: {
          ...inputs().context,
          repliedToMessageId: 180,
          repliedToUserHandle: '@berry',
        },
        history: [
          {
            messageId: 179,
            handle: 'bot',
            isBot: true,
            message: { messageText: 'x', timestamp: new Date() },
          },
          {
            messageId: 180,
            handle: '@berry',
            isBot: false,
            replyToMessageId: 179,
            message: { messageText: 'y', timestamp: new Date() },
          },
        ],
      },
      false,
      true,
    );
    expect(d.shouldReply).toBe(false);
  });

  it('lets the existing scorer evaluate a short-ish continuation inside the bot reply chain', async () => {
    const llm = fakeLLM({ score: { shouldReply: true, confidence: 0.64 } });
    const scorer = new AutoEngageScorer(llm, { ...cfg, minConfidence: 0.78 });
    const d = await scorer.decide(
      {
        ...inputs(),
        currentMessage: 'Io ed Erika abbiamo perso il conto',
        botUsername: '@GooNeuroBot',
        context: {
          ...inputs().context,
          repliedToMessageId: 180,
          repliedToUserHandle: '@berry',
        },
        history: [
          {
            messageId: 179,
            handle: 'bot',
            isBot: true,
            message: { messageText: 'oh no, un memory leak', timestamp: new Date() },
          },
          {
            messageId: 180,
            handle: '@berry',
            isBot: false,
            replyToMessageId: 179,
            replyToHandle: '@GooNeuroBot',
            message: {
              messageText: 'ti ha fatto crashare una volta, posso farlo ancora',
              timestamp: new Date(),
            },
          },
        ],
      },
      false,
      true,
    );
    expect(d.shouldReply).toBe(true);
  });

  it('recognises a hot bot thread even when the latest continuation has no explicit reply arrow', async () => {
    const now = new Date();
    const history = [
      {
        messageId: 1,
        handle: 'bot',
        isBot: true,
        message: { messageText: 'prima risposta', timestamp: now },
      },
      {
        messageId: 2,
        handle: '@alice',
        isBot: false,
        replyToMessageId: 1,
        replyToHandle: '@GooNeuroBot',
        message: { messageText: 'prima replica', timestamp: now },
      },
      {
        messageId: 3,
        handle: 'bot',
        isBot: true,
        message: { messageText: 'seconda risposta', timestamp: now },
      },
      {
        messageId: 4,
        handle: '@bob',
        isBot: false,
        replyToMessageId: 3,
        replyToHandle: '@GooNeuroBot',
        message: { messageText: 'seconda replica', timestamp: now },
      },
    ];
    const involvement = analyzeConversationInvolvement({
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: false,
        isReplyToBot: false,
        isGroupAdmin: false,
      },
      history,
      botUsername: '@GooNeuroBot',
    });
    expect(involvement.kind).toBe('hot_thread');

    const scorer = new AutoEngageScorer(
      fakeLLM({ score: { shouldReply: true, confidence: 0.72, risk: 'low' } }),
      { ...cfg, minConfidence: 0.78 },
    );
    const d = await scorer.decide(
      {
        ...inputs(),
        currentMessage: 'ormai sei dentro fino al collo',
        history,
        botUsername: '@GooNeuroBot',
      },
      false,
      true,
    );
    expect(d.shouldReply).toBe(true);
  });

  it('does not spend a model request on low-information passive chatter', async () => {
    const llm = fakeLLM({ score: { shouldReply: true, confidence: 0.99 } });
    let calls = 0;
    const original = llm.scoreAutoEngage.bind(llm);
    llm.scoreAutoEngage = async (request) => {
      calls += 1;
      return original(request);
    };
    const scorer = new AutoEngageScorer(llm, cfg);
    const d = await scorer.decide({ ...inputs(), currentMessage: 'ok' }, false, true);
    expect(d.shouldReply).toBe(false);
    expect(d.reason).toMatch(/low-information/);
    expect(calls).toBe(0);
  });
});
