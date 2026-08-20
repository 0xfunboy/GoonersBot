import { describe, expect, it, vi } from 'vitest';
import { SocialQuestionService } from '../src/social/questions.js';
import type { SocialQuestionDoc } from '../src/storage/repositories/socialQuestions.js';

const now = new Date('2026-08-20T16:00:00.000Z');

function scene() {
  return {
    currentTopic: 'musica',
    energy: 'medium',
    humorStyle: [],
    activeUsers: ['@alice'],
    mentionedUsers: [],
    openThreads: [],
    botIsBeingAddressed: true,
    botIsBeingCriticized: false,
    userIntent: 'continue_banter',
    shouldUseMemory: true,
    shouldBeDefensive: false,
    bestAngle: '',
    risk: 'low',
    socialSignal: {
      situation: 'casual',
      supportNeed: 'none',
      posture: 'playful',
      humorAllowed: true,
      roastCeiling: 'light',
      memoryPolicy: 'implicit_only',
      responseOrder: 'play_first',
      confidence: 0.8,
      cues: [],
    },
  } as never;
}

function question(overrides: Partial<SocialQuestionDoc> = {}): SocialQuestionDoc {
  return {
    id: 'sq_test',
    chatId: -100,
    threadId: null,
    targetHandle: '@alice',
    targetTelegramId: 1,
    subjectHandle: '@alice',
    kind: 'curiosity',
    questionText: 'Che musica ascolti quando lavori?',
    facet: 'preference',
    key: 'music',
    candidates: [],
    reason: 'natural topic follow-up',
    botMessageId: 500,
    state: 'pending',
    answerMessageId: null,
    resolvedValue: null,
    resolutionConfidence: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    answeredAt: null,
    ...overrides,
  };
}

function harness(
  options: {
    plan?: unknown;
    answer?: unknown;
    pending?: SocialQuestionDoc | null;
    recent?: boolean;
    random?: number;
  } = {},
) {
  const create = vi.fn(async (input: Record<string, unknown>) =>
    question({
      id: 'sq_created',
      kind: input['kind'] as 'clarification' | 'curiosity',
      questionText: String(input['questionText']),
      facet: (input['facet'] as SocialQuestionDoc['facet']) ?? null,
      key: (input['key'] as string | null) ?? null,
      subjectHandle: (input['subjectHandle'] as string | null) ?? '@alice',
    }),
  );
  const attachMessage = vi.fn(async () => question());
  const resolve = vi.fn(async (_id: string, state: 'answered' | 'declined') => question({ state }));
  const repo = {
    hasRecentQuestion: vi.fn(async () => options.recent ?? false),
    create,
    attachMessage,
    findPendingForAnswer: vi.fn(async () => options.pending ?? null),
    resolve,
  };
  const observeBatch = vi.fn(async () => ({
    accepted: 1,
    rejected: 0,
    memberProfilesChanged: 1,
    chatStateChanged: false,
  }));
  const social = {
    resolveHandlesInText: vi.fn(async () => []),
    observeBatch,
  };
  const jsonCompletion = vi.fn(async (request: { system?: string }) =>
    request.system?.includes('evaluate whether')
      ? (options.answer ?? { status: 'not_answer', value: null, confidence: 0.9, reason: '' })
      : (options.plan ?? { ask: false, confidence: 0.9 }),
  );
  const llm = { capabilities: { chat: true }, jsonCompletion };
  const service = new SocialQuestionService(
    llm as never,
    repo as never,
    social as never,
    {
      enabled: true,
      curiosityProbability: 1,
      userCooldownMinutes: 720,
      ttlMinutes: 30,
      unquotedAnswerWindowMinutes: 8,
      model: 'test',
    },
    () => options.random ?? 0,
  );
  return { service, repo, social, create, attachMessage, resolve, observeBatch, jsonCompletion };
}

describe('SocialQuestionService', () => {
  it('prepares a sparse stateful curiosity question for the current speaker', async () => {
    const h = harness({
      plan: {
        ask: true,
        kind: 'curiosity',
        targetHandle: '@alice',
        subjectHandle: '@alice',
        question: 'Che musica ascolti quando lavori?',
        facet: 'preference',
        key: 'music',
        candidates: [],
        confidence: 0.94,
        reason: 'the chat is already talking about music',
      },
    });
    const prepared = await h.service.maybePrepare({
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: true,
        isGroupAdmin: false,
        isReplyToBot: false,
      },
      scene: scene(),
      currentMessage: 'mentre lavoro metto sempre qualcosa in cuffia',
      socialContext: '- MEMBER @alice',
      language: 'italian',
    });
    expect(prepared).toEqual({
      id: 'sq_created',
      kind: 'curiosity',
      questionText: 'Che musica ascolti quando lavori?',
    });
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        targetHandle: '@alice',
        subjectHandle: '@alice',
        facet: 'preference',
        key: 'music',
      }),
      expect.any(Date),
    );
  });

  it('forces clarification after an attribution failure even when curiosity cooldown would block', async () => {
    const h = harness({
      recent: true,
      random: 1,
      plan: {
        ask: true,
        kind: 'curiosity',
        targetHandle: '@alice',
        subjectHandle: '@alice',
        question: 'Quando dici Piero, intendi Bob o Daniele?',
        facet: null,
        key: null,
        candidates: ['Bob', 'Daniele'],
        confidence: 0.96,
        reason: 'resolve wrong owner',
      },
    });
    const prepared = await h.service.maybePrepare({
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        isGroup: true,
        isBotMentioned: true,
        isGroupAdmin: false,
        isReplyToBot: false,
      },
      scene: scene(),
      currentMessage: 'Piero è quello dei video',
      socialContext: '- MEMBER @alice',
      attributionIssues: ['wrong_owner: Piero -> video del trattore'],
      language: 'italian',
    });
    expect(prepared).toMatchObject({ kind: 'clarification' });
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clarification', facet: null, key: null }),
      expect.any(Date),
    );
  });

  it('does not ask curiosity for a profile slot already present in social context', async () => {
    const h = harness({
      plan: {
        ask: true,
        kind: 'curiosity',
        targetHandle: '@alice',
        subjectHandle: '@alice',
        question: 'Che musica ascolti quando lavori?',
        facet: 'preference',
        key: 'music',
        candidates: [],
        confidence: 0.99,
        reason: 'duplicate curiosity',
      },
    });
    await expect(
      h.service.maybePrepare({
        person: { telegramId: 1, userHandle: '@alice' },
        context: {
          chatId: -100,
          isGroup: true,
          isBotMentioned: true,
          isGroupAdmin: false,
          isReplyToBot: false,
        },
        scene: scene(),
        currentMessage: 'musica',
        socialContext: '- MEMBER @alice: preference:music=doom metal (solid)',
        language: 'italian',
      }),
    ).resolves.toBeNull();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('turns a direct answer into clarified_self evidence bound to the exact person and slot', async () => {
    const h = harness({
      pending: question(),
      answer: { status: 'answered', value: 'doom metal', confidence: 0.98, reason: 'clear answer' },
    });
    const resolution = await h.service.consumeAnswer({
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        messageId: 501,
        repliedToMessageId: 500,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: false,
        isReplyToBot: true,
      },
      messageText: 'doom metal quasi sempre',
    });
    expect(resolution).toMatchObject({ state: 'answered', value: 'doom metal' });
    expect(h.observeBatch).toHaveBeenCalledWith(-100, [
      expect.objectContaining({
        subjectHandle: '@alice',
        facet: 'preference',
        key: 'music',
        value: 'doom metal',
        source: 'clarified_self',
        authorHandle: '@alice',
        sourceMessageId: 501,
      }),
    ]);
    expect(h.resolve).toHaveBeenCalledWith(
      'sq_test',
      'answered',
      expect.objectContaining({ answerMessageId: 501, resolvedValue: 'doom metal' }),
    );
  });

  it('keeps pure referent clarification as conversation state without inventing profile biography', async () => {
    const h = harness({
      pending: question({
        kind: 'clarification',
        subjectHandle: '@bob',
        questionText: 'Quando dici Piero, intendi Bob?',
        facet: null,
        key: null,
        candidates: ['Bob', 'Daniele'],
      }),
      answer: { status: 'answered', value: 'Bob', confidence: 0.98, reason: 'explicit referent' },
    });
    const resolution = await h.service.consumeAnswer({
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        messageId: 504,
        repliedToMessageId: 500,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: false,
        isReplyToBot: true,
      },
      messageText: 'sì, Bob',
    });
    expect(resolution).toMatchObject({ state: 'answered', value: 'Bob' });
    expect(h.observeBatch).not.toHaveBeenCalled();
  });

  it('keeps durable clarification about another member as peer_report instead of stealing ownership', async () => {
    const h = harness({
      pending: question({
        kind: 'clarification',
        subjectHandle: '@bob',
        questionText: 'Quando dici quello dei video, parli di Bob?',
        facet: 'role',
        key: 'video_person',
        candidates: ['Bob', 'Piero'],
      }),
      answer: { status: 'answered', value: 'Bob', confidence: 0.97, reason: 'explicit selection' },
    });
    await h.service.consumeAnswer({
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        messageId: 502,
        repliedToMessageId: 500,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: false,
        isReplyToBot: true,
      },
      messageText: 'sì, Bob',
    });
    expect(h.observeBatch).toHaveBeenCalledWith(-100, [
      expect.objectContaining({
        subjectHandle: '@bob',
        value: 'Bob',
        action: 'revise',
        source: 'peer_report',
        authorHandle: '@alice',
      }),
    ]);
  });

  it('respects a refusal and never writes a profile observation', async () => {
    const h = harness({
      pending: question(),
      answer: { status: 'declined', value: null, confidence: 0.99, reason: 'explicit refusal' },
    });
    const resolution = await h.service.consumeAnswer({
      person: { telegramId: 1, userHandle: '@alice' },
      context: {
        chatId: -100,
        messageId: 503,
        repliedToMessageId: 500,
        isGroup: true,
        isBotMentioned: false,
        isGroupAdmin: false,
        isReplyToBot: true,
      },
      messageText: 'fatti i cazzi tuoi',
    });
    expect(resolution?.state).toBe('declined');
    expect(h.observeBatch).not.toHaveBeenCalled();
    expect(h.resolve).toHaveBeenCalledWith(
      'sq_test',
      'declined',
      expect.objectContaining({ answerMessageId: 503 }),
    );
  });

  it('never uses curiosity to collect nationality/origin identity', async () => {
    const h = harness({
      plan: {
        ask: true,
        kind: 'curiosity',
        targetHandle: '@alice',
        subjectHandle: '@alice',
        question: 'Di che nazionalità sei?',
        facet: 'role',
        key: 'national_identity',
        candidates: [],
        confidence: 0.99,
        reason: 'identity curiosity must be blocked',
      },
    });
    await expect(
      h.service.maybePrepare({
        person: { telegramId: 1, userHandle: '@alice' },
        context: {
          chatId: -100,
          isGroup: true,
          isBotMentioned: true,
          isGroupAdmin: false,
          isReplyToBot: false,
        },
        scene: scene(),
        currentMessage: 'parlavamo di viaggi',
        socialContext: '- MEMBER @alice',
        language: 'italian',
      }),
    ).resolves.toBeNull();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('rejects planner questions about sensitive profile topics', async () => {
    const h = harness({
      plan: {
        ask: true,
        kind: 'curiosity',
        targetHandle: '@alice',
        subjectHandle: '@alice',
        question: 'Che partito politico voti?',
        facet: 'preference',
        key: 'political_party',
        candidates: [],
        confidence: 0.99,
        reason: 'bad idea',
      },
    });
    await expect(
      h.service.maybePrepare({
        person: { telegramId: 1, userHandle: '@alice' },
        context: {
          chatId: -100,
          isGroup: true,
          isBotMentioned: true,
          isGroupAdmin: false,
          isReplyToBot: false,
        },
        scene: scene(),
        currentMessage: 'boh',
        socialContext: '- MEMBER @alice',
        language: 'italian',
      }),
    ).resolves.toBeNull();
    expect(h.create).not.toHaveBeenCalled();
  });
});
