import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  buildReplyUserPrompt,
  buildAutoEngagePrompt,
  buildAutoEngageSystem,
  buildFactExtractionContext,
} from '../src/prompts/index.js';

describe('prompt builders', () => {
  it('system prompt includes identity, mode, language and safety', () => {
    const p = buildSystemPrompt({
      botUsername: 'GoonersBot',
      chatName: 'Gooners',
      language: 'english',
      modeName: 'Roast',
      modeDescription: 'light banter only',
    });
    expect(p).toContain('GoonersBot');
    expect(p).toContain('Gooners');
    expect(p).toContain('Roast');
    expect(p).toContain('light banter only');
    expect(p.toLowerCase()).toContain('english');
    expect(p).toContain('SAFETY');
    expect(p).toContain('OUTPUT STYLE');
    expect(p.toLowerCase()).toContain('not an assistant');
  });

  it('reply user prompt includes message, facts and first-message marker', () => {
    const p = buildReplyUserPrompt({
      person: { telegramId: 1, userHandle: '@bob' },
      message: { messageText: 'gm gooners', timestamp: new Date('2026-01-01T00:00:00Z') },
      history: [],
      groupFacts: [{ handle: '@alice', fact: 'always early' }],
      userFacts: ['meme lord'],
      introduction: 'I am bob',
      botLabel: 'bot',
    });
    expect(p).toContain('@bob');
    expect(p).toContain('gm gooners');
    expect(p).toContain('meme lord');
    expect(p).toContain('@alice: always early');
    expect(p).toContain('I am bob');
    expect(p).toContain('first message');
  });

  it('autoengage prompt + system carry the decision contract', () => {
    expect(buildAutoEngageSystem()).toContain('shouldReply');
    const p = buildAutoEngagePrompt({
      modeName: 'Default',
      modeDescription: 'natural',
      history: [],
      currentMessage: 'anyone around?',
      userHandle: '@bob',
      userFacts: [],
      groupFacts: [],
      isMentionedOrReplied: false,
      recentBotReplies: 0,
      conversationEnergy: 3,
      botLabel: 'bot',
    });
    expect(p).toContain('anyone around?');
    expect(p).toContain('Default');
  });

  it('fact extraction context lists good vs bad facts', () => {
    const p = buildFactExtractionContext({
      userHandle: '@bob',
      latestMessage: 'I love doom metal',
      botReply: 'based',
      history: [],
      botLabel: 'bot',
    });
    expect(p).toContain('@bob');
    expect(p.toLowerCase()).toContain('running joke');
    expect(p.toLowerCase()).toContain('medical');
  });
});
