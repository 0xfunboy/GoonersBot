import { describe, expect, it } from 'vitest';
import type { ConversationEntityDoc, ConversationThreadDoc } from '../src/domain/entities.js';
import { ConversationThreadTracker } from '../src/services/threadTracker.js';
import { NullEmbedder } from '../src/rag/embedder.js';
import { fakeStorage } from './helpers.js';

function storage() {
  const threads: ConversationThreadDoc[] = [];
  const entities: ConversationEntityDoc[] = [];
  return {
    threads,
    entities,
    storage: fakeStorage({
      conversationThreads: {
        async listActive(chatId: number) {
          return threads
            .filter((t) => t.chatId === chatId && t.status === 'active')
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        },
        async findByMessageId(chatId: number, messageId: number) {
          return (
            threads.find((t) => t.chatId === chatId && t.sourceMessageIds.includes(messageId)) ??
            null
          );
        },
        async upsert(doc: ConversationThreadDoc) {
          const idx = threads.findIndex((t) => t.threadId === doc.threadId);
          if (idx >= 0) threads[idx] = doc;
          else threads.push(doc);
        },
        async attachMessage(chatId: number, threadId: string, messageId: number) {
          const t = threads.find(
            (thread) => thread.chatId === chatId && thread.threadId === threadId,
          );
          if (t && !t.sourceMessageIds.includes(messageId)) t.sourceMessageIds.push(messageId);
        },
      },
      conversationEntities: {
        async findByAlias(chatId: number, aliases: string[]) {
          return entities.filter(
            (e) => e.chatId === chatId && e.aliases.some((a) => aliases.includes(a)),
          );
        },
        async upsert(doc: ConversationEntityDoc) {
          const idx = entities.findIndex((e) => e.entityId === doc.entityId);
          if (idx >= 0) entities[idx] = doc;
          else entities.push(doc);
        },
      },
    }),
  };
}

function makeTracker(s = storage()) {
  return {
    ...s,
    tracker: new ConversationThreadTracker(s.storage, new NullEmbedder(), {
      enabled: true,
      ttlDays: 5,
      maxActive: 10,
      embeddingDim: 1024,
    }),
  };
}

const chat = {
  chatId: -100,
  isGroup: true,
  isBotMentioned: true,
  isGroupAdmin: false,
  isReplyToBot: false,
};

describe('ConversationThreadTracker', () => {
  it('keeps a first-person vehicle thread owned by the speaker', async () => {
    const { tracker } = makeTracker();
    const state = await tracker.track({
      person: { telegramId: 1, userHandle: '@funboy' },
      context: { ...chat, messageId: 10 },
      message: {
        messageText: 'nel 2020 mi comprai la Toyota RAV4, la mia va ancora bene',
        timestamp: new Date(),
      },
      history: [],
    });

    expect(state.currentThread?.ownerHandle).toBe('@funboy');
    expect(state.currentEntities[0]?.type).toBe('vehicle');
    expect(state.promptBlock).toContain('Owner/subject: @funboy');
  });

  it('opens a separate thread when another speaker introduces a different car choice', async () => {
    const s = makeTracker();
    await s.tracker.track({
      person: { telegramId: 1, userHandle: '@funboy' },
      context: { ...chat, messageId: 10 },
      message: { messageText: 'la mia Toyota RAV4 ha 6 anni', timestamp: new Date() },
      history: [],
    });
    const miguel = await s.tracker.track({
      person: { telegramId: 2, userHandle: '@miguel' },
      context: { ...chat, messageId: 11, isBotMentioned: false },
      message: { messageText: 'Devo comprare un ferrari o un lamborghini?', timestamp: new Date() },
      history: [],
    });

    expect(s.threads).toHaveLength(2);
    expect(miguel.currentThread?.ownerHandle).toBe('@miguel');
    expect(miguel.currentThread?.title).toMatch(/ferrari|lamborghini/);
  });

  it('lets a third party comment on the owner thread without stealing ownership', async () => {
    const s = makeTracker();
    const first = await s.tracker.track({
      person: { telegramId: 1, userHandle: '@funboy' },
      context: { ...chat, messageId: 10 },
      message: {
        messageText: 'la mia Toyota RAV4 plug-in hybrid ha 6 anni',
        timestamp: new Date(),
      },
      history: [],
    });
    const comment = await s.tracker.track({
      person: { telegramId: 2, userHandle: '@miguel' },
      context: { ...chat, messageId: 12 },
      message: { messageText: 'secondo me quella RAV4 la deve tenere', timestamp: new Date() },
      history: [],
    });

    expect(comment.currentThread?.threadId).toBe(first.currentThread?.threadId);
    expect(comment.currentThread?.ownerHandle).toBe('@funboy');
    expect(comment.promptBlock).toContain("@miguel is talking about @funboy's thread/entity");
  });

  it('treats an injected replied-media transcript as quoted context, never as the current speaker words', async () => {
    const s = makeTracker();
    const first = await s.tracker.track({
      person: { telegramId: 1, userHandle: '@berry' },
      context: { ...chat, messageId: 20 },
      message: { messageText: 'Piero è quello dei video del trattore', timestamp: new Date() },
      history: [],
    });
    const entityCount = s.entities.length;
    const quoted = await s.tracker.track({
      person: { telegramId: 2, userHandle: '@daniele' },
      context: {
        ...chat,
        messageId: 21,
        repliedToMessageId: 20,
        repliedToUserHandle: '@berry',
        isReplyToBot: false,
      },
      message: {
        messageText:
          '[transcript of the replied audio/video]: io sono il tizio del trattore e mando quei video',
        timestamp: new Date(),
      },
      history: [],
    });

    expect(quoted.currentThread?.threadId).toBe(first.currentThread?.threadId);
    expect(quoted.currentThread?.ownerHandle).toBe('@berry');
    expect(quoted.currentEntities).toEqual([]);
    expect(s.entities).toHaveLength(entityCount);
    expect(quoted.promptBlock).toContain('Quoted/replied transcripts belong to the quoted message');
  });

  it('can identify one explicitly mentioned subject without changing the existing thread owner', async () => {
    const s = makeTracker();
    const first = await s.tracker.track({
      person: { telegramId: 1, userHandle: '@berry' },
      context: { ...chat, messageId: 30 },
      message: { messageText: 'sto parlando degli amici del gruppo', timestamp: new Date() },
      history: [],
    });
    const correction = await s.tracker.track({
      person: { telegramId: 1, userHandle: '@berry' },
      context: {
        ...chat,
        messageId: 31,
        mentionedHandles: ['@ilrinnegato'],
      },
      message: { messageText: 'Daniele è @ilrinnegato, quello è lui', timestamp: new Date() },
      history: [],
    });

    expect(correction.currentThread?.threadId).toBe(first.currentThread?.threadId);
    expect(correction.currentThread?.ownerHandle).toBe('@berry');
    expect(correction.currentEntities[0]?.ownerHandle).toBe('@ilrinnegato');
    expect(correction.promptBlock).toContain('Entities:\n- daniele lui (topic) owner=@ilrinnegato');
    expect(correction.currentThread?.summary).toContain('owner=@berry');
  });
});
