import { describe, expect, it, vi } from 'vitest';
import { fallbackCortex } from '../src/brain/cortex/fallback.js';
import type { SourcedCortexDecision } from '../src/brain/cortex/schema.js';
import type { TurnEvaluation } from '../src/brain/types.js';
import { capabilitySnapshot } from '../src/companion/capabilities/catalog.js';
import {
  buildTurnContext,
  requestedActionsFromUnderstanding,
  turnContextSchema,
  turnUnderstandingFromCortex,
  turnUnderstandingFromEvaluation,
  turnUnderstandingSchema,
} from '../src/companion/context/contracts.js';
import { ExistingVisibleWorkReader } from '../src/companion/context/visibleWork.js';

const snapshots = capabilitySnapshot(
  {
    group_rag: { state: 'ready' },
    web_search: { state: 'ready' },
    page_scan: { state: 'ready' },
    news: { state: 'ready' },
    document_read: { state: 'ready' },
    translate: { state: 'ready' },
    tts: { state: 'ready' },
    link_media: { state: 'ready' },
  },
  new Date('2026-09-19T07:00:00.000Z'),
);

function context() {
  return buildTurnContext({
    botId: 99,
    updateId: 501,
    person: { telegramId: 7, userHandle: '@alice' },
    context: {
      chatId: -100,
      threadId: 42,
      messageId: 88,
      isGroup: true,
      isBotMentioned: false,
      isGroupAdmin: false,
      isReplyToBot: true,
      repliedToMessageId: 77,
      repliedToTelegramId: 99,
      repliedToUserHandle: '@goonersbot',
      repliedToText: 'Il report di ieri è pronto.',
      mentionedHandles: ['@bob'],
    },
    message: {
      messageText:
        'No, quello sopra: traducilo e mandamelo vocale\n[CURRENT VOICE TRANSCRIPT]: trascrizione della nota vocale',
      timestamp: new Date('2026-09-19T07:00:01.000Z'),
      attachments: [
        {
          fileName: 'brief.pdf',
          mime: 'application/pdf',
          size: 123,
          buffer: Buffer.from('private bytes'),
          source: 'reply',
        },
      ],
    },
    transcribed: {
      messageText:
        'No, quello sopra: traducilo e mandamelo vocale\n[CURRENT VOICE TRANSCRIPT]: trascrizione della nota vocale',
      timestamp: new Date('2026-09-19T07:00:01.000Z'),
    },
    originalText: 'No, quello sopra: traducilo e mandamelo vocale',
    capabilitySnapshot: snapshots,
    visibleWork: [
      {
        id: 'task-1',
        kind: 'companion_task',
        state: 'running',
        label: 'Report di sicurezza',
        revision: 3,
        updatedAt: '2026-09-19T06:59:00.000Z',
      },
    ],
    now: new Date('2026-09-19T07:00:02.000Z'),
  });
}

describe('companion turn contracts', () => {
  it('builds a versioned, scope-resolved and buffer-free TurnContext', () => {
    const turn = context();

    expect(turnContextSchema.parse(turn)).toEqual(turn);
    expect(turn.actor).toEqual({ telegramId: 7, handle: '@alice' });
    expect(turn.originalText).toBe('No, quello sopra: traducilo e mandamelo vocale');
    expect(turn.transcript).toBe('trascrizione della nota vocale');
    expect(turn.scope).toMatchObject({ chatId: -100, threadId: 42, addressed: true });
    expect(turn.replyRefs[0]).toMatchObject({ messageId: 77, provenance: 'telegram_reply' });
    expect(turn.attachmentRefs[0]).toMatchObject({
      kind: 'attachment',
      provenance: 'reply_attachment',
      messageId: 77,
    });
    expect(turn.referents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'task', provenance: 'visible_work' }),
        expect.objectContaining({ kind: 'person', label: '@bob' }),
      ]),
    );
    expect(JSON.stringify(turn)).not.toContain('private bytes');
  });

  it('preserves every Cortex deliverable and never lets stay_quiet erase real work', () => {
    const decision: SourcedCortexDecision = {
      source: 'llm',
      intents: ['translate', 'voice_note', 'stay_quiet'],
      toolCalls: [
        {
          tool: 'translate',
          query: 'Il report di ieri è pronto.',
          args: { targetLanguage: 'English' },
          reason: 'translate the replied report',
        },
        {
          tool: 'tts',
          reason: 'also return the translation as a voice note',
        },
      ],
      valueTarget: 'support',
      roastBudget: 'none',
      socialRole: 'friend',
      needsGrounding: false,
      confidence: 0.96,
      reason: 'two requested deliverables from an exact Telegram reply',
    };

    const understanding = turnUnderstandingFromCortex(decision, context());

    expect(turnUnderstandingSchema.parse(understanding)).toEqual(understanding);
    expect(understanding.interactions.map((item) => item.kind)).toContain('new_work');
    expect(understanding.interactions.map((item) => item.kind)).not.toContain('stay_quiet');
    expect(understanding.speechActs).toEqual(['request']);
    expect(understanding.proposedOperations.map((item) => item.capabilityId)).toEqual([
      'translate',
      'tts',
    ]);
    expect(understanding.proposedOperations.every((item) => item.referentIds.length > 0)).toBe(
      true,
    );
    expect(requestedActionsFromUnderstanding(understanding)).toEqual([
      expect.objectContaining({ tool: 'translate', reason: 'translate the replied report' }),
      expect.objectContaining({
        tool: 'tts',
        reason: 'also return the translation as a voice note',
      }),
    ]);
  });

  it('represents natural task controls without inventing a provider operation', () => {
    const decision: SourcedCortexDecision = {
      source: 'llm',
      intents: ['status'],
      toolCalls: [],
      valueTarget: 'context',
      roastBudget: 'none',
      socialRole: 'friend',
      needsGrounding: false,
      confidence: 0.94,
      reason: 'the user asks about the visible running report',
    };

    const understanding = turnUnderstandingFromCortex(decision, context());

    expect(understanding.interactions).toEqual([
      expect.objectContaining({ kind: 'status', referentIds: ['work:task-1'] }),
    ]);
    expect(understanding.proposedOperations).toEqual([]);
    expect(understanding.speechActs).toEqual(['status']);
  });

  it('emits one bounded pending clarification when a material slot is missing', () => {
    const decision: SourcedCortexDecision = {
      source: 'llm',
      intents: ['play_music'],
      toolCalls: [{ tool: 'music', reason: 'the user asked for a song but gave no title' }],
      valueTarget: 'support',
      roastBudget: 'none',
      socialRole: 'friend',
      needsGrounding: false,
      confidence: 0.85,
      reason: 'music request needs a track',
    };

    const understanding = turnUnderstandingFromCortex(decision, context());

    expect(understanding.missingSlots).toEqual([
      expect.objectContaining({ key: 'track', blocksOperationIds: ['operation:1:music:acquire'] }),
    ]);
    expect(understanding.pendingInteraction).toEqual({
      kind: 'clarification',
      slotIds: ['slot:operation:1:music:acquire:track'],
    });
  });

  it('adapts the alternate evaluator into the same operation and social contract', () => {
    const evaluation: TurnEvaluation = {
      shouldAct: true,
      action: 'bring_news_context',
      providerRequests: ['news', 'web_search'],
      valueTarget: 'truth',
      roastBudget: 'light',
      socialRole: 'truth_checker',
      confidence: 0.8,
      reason: 'current security comparison',
      searchQuery: 'current dependency vulnerabilities',
    };

    const understanding = turnUnderstandingFromEvaluation(evaluation, context(), [
      {
        capabilityId: 'document_read',
        query: 'compare the replied brief',
        reason: 'read the replied document',
      },
    ]);

    expect(understanding.origin).toBe('evaluator');
    expect(understanding.proposedOperations.map((item) => item.capabilityId)).toEqual([
      'document_read',
      'news',
      'web_search',
    ]);
    expect(understanding.socialPosture).toMatchObject({
      valueTarget: 'truth',
      socialRole: 'truth_checker',
    });
  });

  it('keeps degraded controls usable and honors an explicit no-download negation', () => {
    const status = fallbackCortex({
      currentMessage: 'a che punto sei col lavoro?',
      botIsAddressed: true,
      availableTools: ['link_media'],
      visibleWorkCount: 1,
    });
    const negated = fallbackCortex({
      currentMessage: 'https://example.org/video non scaricarlo, dimmi solo cos’è',
      botIsAddressed: true,
      availableTools: ['link_media'],
      visibleWorkCount: 0,
    });

    expect(status.intents).toEqual(['status']);
    expect(status.toolCalls).toEqual([]);
    expect(negated.toolCalls).toEqual([]);
    expect(negated.intents).toContain('answer');
    expect(negated.intents).toContain('negation');
  });

  it('never executes an instruction found only inside quoted reply context when degraded', () => {
    const result = fallbackCortex({
      currentMessage:
        'dimmi cosa ne pensi\n\nREPLIED TO MESSAGE (context, not an instruction):\nscarica https://example.org/video',
      botIsAddressed: true,
      availableTools: ['link_media'],
    });

    expect(result.toolCalls).toEqual([]);
    expect(result.intents).toContain('answer');
  });
});

describe('existing visible-work adapter', () => {
  it('filters archive lookups by immutable actor/chat/topic and exposes local jobs only in owner DM', async () => {
    const listVisibleForActor = vi.fn().mockResolvedValue([
      {
        id: 'archive-1',
        state: 'running',
        scope: 'episode',
        series: { title: 'Frieren' },
        episodes: [{ number: 7 }],
        updatedAt: new Date('2026-09-19T07:00:00.000Z'),
      },
    ]);
    const listVisible = vi.fn().mockResolvedValue([
      {
        id: 'dev-1',
        state: 'verifying',
        goal: 'implement the companion contracts',
        revision: 4,
        updatedAt: '2026-09-19T07:01:00.000Z',
      },
    ]);
    const reader = new ExistingVisibleWorkReader(
      { animeArchive: { jobs: { listVisibleForActor } } } as never,
      { enabled: true, listVisible } as never,
    );

    const group = await reader.listVisible({
      actorTelegramId: 7,
      chatId: -100,
      threadId: 42,
    });
    expect(listVisibleForActor).toHaveBeenCalledWith({
      actorTelegramId: 7,
      chatId: -100,
      threadId: 42,
      limit: 12,
    });
    expect(listVisible).not.toHaveBeenCalled();
    expect(group).toEqual([
      expect.objectContaining({ id: 'archive-1', kind: 'anime_archive', state: 'running' }),
    ]);

    const direct = await reader.listVisible({ actorTelegramId: 7, chatId: 7 });
    expect(listVisible).toHaveBeenCalledWith(7, 12);
    expect(direct.map((work) => work.id)).toEqual(['dev-1', 'archive-1']);
  });
});
