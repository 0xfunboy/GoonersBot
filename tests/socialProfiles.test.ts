import { describe, expect, it, vi } from 'vitest';
import {
  SocialProfileEngine,
  SocialObservationMiner,
  SocialLearningPipeline,
  buildSocialContext,
  createChatSocialState,
  createMemberProfile,
  maintainMemberProfile,
  normalizeSocialMiningCandidate,
  renderSocialContext,
  socialObservationBatchSchema,
  type ChatSocialState,
  type MemberSocialProfile,
  type SocialEvolutionOptions,
  type SocialProfileStore,
} from '../src/social/index.js';
import type { LLMProvider } from '../src/providers/llm/types.js';

class MemorySocialStore implements SocialProfileStore {
  readonly members = new Map<string, MemberSocialProfile>();
  readonly chats = new Map<number, ChatSocialState>();
  failNextMemberSave = false;

  private key(chatId: number, handle: string): string {
    return `${chatId}:${handle}`;
  }

  async getMember(chatId: number, handle: string): Promise<MemberSocialProfile | null> {
    const value = this.members.get(this.key(chatId, handle));
    return value ? structuredClone(value) : null;
  }

  async getMemberByTelegramId(
    chatId: number,
    telegramId: number,
  ): Promise<MemberSocialProfile | null> {
    const value = [...this.members.values()].find(
      (profile) => profile.chatId === chatId && profile.telegramId === telegramId,
    );
    return value ? structuredClone(value) : null;
  }

  async listMembers(chatId: number, limit = 100): Promise<MemberSocialProfile[]> {
    return [...this.members.values()]
      .filter((profile) => profile.chatId === chatId)
      .slice(0, limit)
      .map((profile) => structuredClone(profile));
  }

  async saveMember(profile: MemberSocialProfile, expectedVersion: number): Promise<boolean> {
    if (this.failNextMemberSave) {
      this.failNextMemberSave = false;
      return false;
    }
    const key = this.key(profile.chatId, profile.handle);
    const current = this.members.get(key);
    if ((current?.version ?? 0) !== expectedVersion) return false;
    this.members.set(key, structuredClone(profile));
    return true;
  }

  async deleteMember(chatId: number, handle: string): Promise<boolean> {
    return this.members.delete(this.key(chatId, handle));
  }

  async getChatState(chatId: number): Promise<ChatSocialState | null> {
    const value = this.chats.get(chatId);
    return value ? structuredClone(value) : null;
  }

  async saveChatState(state: ChatSocialState, expectedVersion: number): Promise<boolean> {
    const current = this.chats.get(state.chatId);
    if ((current?.version ?? 0) !== expectedVersion) return false;
    this.chats.set(state.chatId, structuredClone(state));
    return true;
  }
}

function harness(start = new Date('2026-01-01T12:00:00Z')) {
  let now = start;
  let sequence = 0;
  const store = new MemorySocialStore();
  const engine = new SocialProfileEngine(store, {
    clock: () => now,
    idFactory: () => `social-${++sequence}`,
  });
  return {
    store,
    engine,
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('SocialProfileEngine', () => {
  it('learns the whole room through presence, not only users with extracted lore', async () => {
    const { engine } = harness();
    await engine.recordPresence({
      chatId: -100,
      handle: 'Alice',
      telegramId: 10,
      displayName: 'Alice A.',
      alias: 'la Sindaca',
    });
    await engine.recordPresence({ chatId: -100, handle: '@bob', telegramId: 11 });
    await engine.recordPresence({ chatId: -100, handle: '@alice', telegramId: 10 });

    const alice = await engine.getMember(-100, '@ALICE');
    const context = await engine.getContext(-100, { maxMembers: 10 });
    expect(alice).toMatchObject({
      handle: '@alice',
      telegramId: 10,
      displayName: 'Alice A.',
      messageCount: 2,
      aliases: ['la Sindaca'],
    });
    expect(context.members.map((member) => member.handle)).toEqual(['@alice', '@bob']);
  });

  it('resolves plain display names and aliases to stable handles for focus-only turns', async () => {
    const { engine } = harness();
    await engine.recordPresence({
      chatId: -100,
      handle: '@lospread',
      telegramId: 20,
      displayName: 'Johnny Bear',
      alias: 'Johnny',
    });
    await engine.recordPresence({
      chatId: -100,
      handle: '@barchi7',
      telegramId: 21,
      displayName: 'Miguel B',
      alias: 'Miguel',
    });

    const resolved = await engine.resolveHandlesInText(
      -100,
      'Mi hai preso per Johnny? Miguel invece che dice?',
    );
    expect(resolved).toHaveLength(2);
    expect(resolved).toEqual(expect.arrayContaining(['@lospread', '@barchi7']));
    await expect(engine.resolveHandlesInText(-100, 'parliamo di cucina')).resolves.toEqual([]);
  });

  it('keeps Telegram identity stable and merges lore across username changes', async () => {
    const { engine } = harness();
    await engine.recordPresence({
      chatId: -100,
      handle: '@id10',
      telegramId: 10,
      displayName: 'Alice',
    });
    await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@id10',
        facet: 'skill',
        key: 'creative_tools',
        value: 'Blender',
        confidence: 0.9,
        source: 'self_declared',
        sourceMessageId: 1,
      },
    ]);
    await engine.recordPresence({ chatId: -100, handle: '@alice', telegramId: 10 });

    expect(await engine.getMember(-100, '@id10')).toBeNull();
    expect(await engine.getMember(-100, '@alice')).toMatchObject({
      telegramId: 10,
      aliases: expect.arrayContaining(['@id10']),
      facets: [expect.objectContaining({ value: 'Blender' })],
    });
  });

  it('does not let stale membership rows roll a Telegram identity back to an old username', async () => {
    const { engine } = harness();
    const currentSeenAt = new Date('2026-01-10T12:00:00Z');
    await engine.recordPresence({
      chatId: -100,
      handle: '@new_name',
      telegramId: 10,
      displayName: 'Current Name',
      alias: 'Current',
      seenAt: currentSeenAt,
      messageCountDelta: 0,
      minimumMessageCount: 300,
    });
    await engine.recordPresence({
      chatId: -100,
      handle: '@old_name',
      telegramId: 10,
      displayName: 'Stale Name',
      alias: 'Stale',
      seenAt: new Date('2025-12-01T12:00:00Z'),
      messageCountDelta: 0,
      minimumMessageCount: 300,
    });

    expect(await engine.getMember(-100, '@old_name')).toBeNull();
    expect(await engine.getMember(-100, '@new_name')).toMatchObject({
      telegramId: 10,
      displayName: 'Current Name',
      aliases: expect.arrayContaining(['Current', '@old_name']),
      lastSeenAt: currentSeenAt,
      messageCount: 300,
    });
    expect((await engine.getMember(-100, '@new_name'))?.aliases).not.toContain('Stale');
  });

  it('supersedes fossilized lore when the person corrects it', async () => {
    const { engine } = harness();
    await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@alice',
        facet: 'preference',
        key: 'football_team',
        value: 'Inter',
        confidence: 0.8,
        source: 'peer_report',
      },
    ]);
    await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@alice',
        facet: 'preference',
        key: 'football_team',
        value: 'Roma',
        confidence: 0.95,
        source: 'self_declared',
        action: 'revise',
      },
    ]);

    const profile = await engine.getMember(-100, '@alice');
    expect(profile?.facets).toHaveLength(2);
    expect(profile?.facets.find((claim) => claim.value === 'Inter')).toMatchObject({
      state: 'superseded',
    });
    expect(profile?.facets.find((claim) => claim.value === 'Roma')).toMatchObject({
      state: 'active',
      source: 'self_declared',
    });
    const context = await engine.getContext(-100, { focusHandles: ['@alice'] });
    expect(context.members[0]?.facets.map((facet) => facet.value)).toEqual(['Roma']);
  });

  it('keeps interests set-valued instead of treating every new value as a contradiction', async () => {
    const { engine } = harness();
    await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@bob',
        facet: 'interest',
        key: 'music',
        value: 'doom metal',
        confidence: 0.9,
        source: 'direct_observation',
      },
      {
        kind: 'facet',
        subjectHandle: '@bob',
        facet: 'interest',
        key: 'music',
        value: 'reggaeton',
        confidence: 0.45,
        source: 'peer_report',
      },
    ]);
    const profile = await engine.getMember(-100, '@bob');
    expect(profile?.facets.find((claim) => claim.value === 'doom metal')?.state).toBe('active');
    expect(profile?.facets.find((claim) => claim.value === 'reggaeton')?.state).toBe('active');
    const context = await engine.getContext(-100, { focusHandles: ['@bob'] });
    expect(context.members[0]?.facets.map((facet) => facet.value)).toEqual([
      'doom metal',
      'reggaeton',
    ]);
  });

  it('does not let a peer revise or retract a strong self-declaration', async () => {
    const { engine } = harness();
    await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@bob',
        facet: 'preference',
        key: 'football_team',
        value: 'Roma',
        confidence: 0.95,
        source: 'self_declared',
        sourceMessageId: 10,
      },
      {
        kind: 'facet',
        subjectHandle: '@bob',
        facet: 'preference',
        key: 'football_team',
        value: 'Lazio',
        confidence: 0.99,
        source: 'peer_report',
        sourceMessageId: 11,
        action: 'revise',
      },
      {
        kind: 'facet',
        subjectHandle: '@bob',
        facet: 'preference',
        key: 'football_team',
        value: 'Roma',
        confidence: 0.99,
        source: 'peer_report',
        sourceMessageId: 12,
        action: 'retract',
      },
    ]);

    const profile = await engine.getMember(-100, '@bob');
    expect(profile?.facets.find((claim) => claim.value === 'Roma')).toMatchObject({
      state: 'active',
      confidence: 0.95,
      source: 'self_declared',
    });
    expect(profile?.facets.find((claim) => claim.value === 'Lazio')?.state).toBe('disputed');
  });

  it('retries optimistic version races without losing an observation', async () => {
    const { engine, store } = harness();
    store.failNextMemberSave = true;
    const result = await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@alice',
        facet: 'skill',
        key: 'editing',
        value: 'video editing',
        confidence: 0.8,
        source: 'self_declared',
      },
    ]);
    expect(result).toMatchObject({ accepted: 1, rejected: 0, memberProfilesChanged: 1 });
    expect((await engine.getMember(-100, '@alice'))?.facets[0]?.value).toBe('video editing');
  });

  it('rejects sensitive durable claims before they reach persistence', async () => {
    const { engine } = harness();
    const result = await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@alice',
        facet: 'preference',
        key: 'contact',
        value: 'call me at +39 333 1234567',
        confidence: 1,
        source: 'self_declared',
      },
    ]);
    expect(result).toMatchObject({ accepted: 0, rejected: 1 });
    expect(await engine.getMember(-100, '@alice')).toBeNull();
  });

  it('enforces confidence floors and rejects sensitive-category profiling deterministically', async () => {
    const { engine } = harness();
    const result = await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@alice',
        facet: 'interest',
        key: 'music',
        value: 'ambient',
        confidence: 0.2,
        source: 'inferred',
      },
      {
        kind: 'facet',
        subjectHandle: '@alice',
        facet: 'preference',
        key: 'political_affiliation',
        value: 'partito di esempio',
        confidence: 1,
        source: 'self_declared',
      },
    ]);
    expect(result).toMatchObject({ accepted: 0, rejected: 2 });
    expect(await engine.getMember(-100, '@alice')).toBeNull();
  });

  it('models directional trust, warmth and banter affinity', async () => {
    const { engine } = harness();
    await engine.recordPresence({ chatId: -100, handle: '@alice' });
    await engine.recordPresence({ chatId: -100, handle: '@bob' });
    await engine.observeBatch(-100, [
      {
        kind: 'relationship',
        fromHandle: '@alice',
        toHandle: '@bob',
        dimension: 'trust',
        delta: 0.9,
        confidence: 0.9,
        source: 'direct_observation',
      },
      {
        kind: 'relationship',
        fromHandle: '@bob',
        toHandle: '@alice',
        dimension: 'banter_affinity',
        delta: 0.8,
        confidence: 0.85,
        source: 'repeated_behavior',
      },
      {
        kind: 'relationship',
        fromHandle: '@bob',
        toHandle: '@alice',
        dimension: 'warmth',
        delta: 0.7,
        confidence: 0.8,
        source: 'direct_observation',
      },
    ]);
    const context = await engine.getContext(-100, {
      focusHandles: ['@alice', '@bob'],
    });
    expect(context.relationships).toHaveLength(3);
    expect(context.relationships).toContainEqual(
      expect.objectContaining({
        fromHandle: '@alice',
        toHandle: '@bob',
        dimension: 'trust',
      }),
    );
  });

  it('forgets both the profile and social references to a member', async () => {
    const { engine } = harness();
    await engine.recordPresence({ chatId: -100, handle: '@alice' });
    await engine.recordPresence({ chatId: -100, handle: '@bob' });
    await engine.observeBatch(-100, [
      {
        kind: 'relationship',
        fromHandle: '@alice',
        toHandle: '@bob',
        dimension: 'warmth',
        delta: 0.9,
        confidence: 0.9,
        source: 'direct_observation',
      },
      {
        kind: 'running_joke',
        canonicalKey: 'bob_excel',
        label: 'Bob vive nei fogli Excel',
        targetHandles: ['@bob'],
        confidence: 0.9,
        source: 'repeated_behavior',
      },
    ]);
    expect(await engine.forgetMember(-100, '@bob')).toBe(true);
    expect(await engine.getMember(-100, '@bob')).toBeNull();
    const context = await engine.getContext(-100, { focusHandles: ['@alice'] });
    expect(context.relationships).toEqual([]);
    expect(context.runningJokes).toEqual([]);
  });

  it('forgets social observations by source message while preserving independent evidence', async () => {
    const { engine } = harness();
    await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@alice',
        facet: 'skill',
        key: 'tools',
        value: 'Blender',
        confidence: 0.9,
        source: 'self_declared',
        sourceMessageId: 41,
      },
      {
        kind: 'facet',
        subjectHandle: '@alice',
        facet: 'skill',
        key: 'tools',
        value: 'Blender',
        confidence: 0.9,
        source: 'self_declared',
        sourceMessageId: 42,
      },
      {
        kind: 'relationship',
        fromHandle: '@alice',
        toHandle: '@bob',
        dimension: 'trust',
        delta: 0.8,
        confidence: 0.9,
        source: 'direct_observation',
        sourceMessageId: 41,
      },
      {
        kind: 'running_joke',
        canonicalKey: 'printer',
        label: 'La stampante maledetta',
        confidence: 0.9,
        source: 'repeated_behavior',
        sourceMessageId: 41,
      },
    ]);

    expect(await engine.forgetBySourceMessage(-100, 41)).toBe(3);
    const profile = await engine.getMember(-100, '@alice');
    expect(profile?.facets[0]?.sourceMessageIds).toEqual([42]);
    const state = await engine.getContext(-100, { focusHandles: ['@alice', '@bob'] });
    expect(state.relationships).toEqual([]);
    expect(state.runningJokes).toEqual([]);
  });

  it('does not write lifecycle maintenance when no state changed', async () => {
    const h = harness();
    await h.engine.recordPresence({ chatId: -100, handle: '@alice' });
    const version = (await h.engine.getMember(-100, '@alice'))?.version;
    expect(await h.engine.maintain(-100)).toEqual({ members: 0, chatState: false });
    expect((await h.engine.getMember(-100, '@alice'))?.version).toBe(version);
  });

  it('keeps a one-off alleged running joke out of reply context until independently confirmed', async () => {
    const h = harness();
    const observation = {
      kind: 'running_joke' as const,
      canonicalKey: 'bob_excel',
      label: 'Bob trasforma ogni problema in un foglio Excel',
      targetHandles: ['@bob'],
      confidence: 0.9,
      source: 'repeated_behavior' as const,
    };
    await h.engine.observeBatch(-100, [{ ...observation, sourceMessageId: 10 }]);
    expect((await h.engine.getContext(-100, { focusHandles: ['@bob'] })).runningJokes).toEqual([]);

    await h.engine.observeBatch(-100, [{ ...observation, sourceMessageId: 11 }]);
    expect((await h.engine.getContext(-100, { focusHandles: ['@bob'] })).runningJokes).toHaveLength(
      1,
    );
  });

  it('cools an overused running joke and excludes recently used variants', async () => {
    const h = harness();
    await h.engine.observeBatch(-100, [
      {
        kind: 'running_joke',
        canonicalKey: 'bob_excel',
        label: 'Bob trasforma ogni problema in un foglio Excel',
        targetHandles: ['@bob'],
        variant: 'pure il caffè finisce in una pivot',
        confidence: 0.9,
        source: 'repeated_behavior',
      },
      {
        kind: 'running_joke',
        canonicalKey: 'bob_excel',
        label: 'Bob trasforma ogni problema in un foglio Excel',
        targetHandles: ['@bob'],
        variant: 'ha una macro anche per respirare',
        confidence: 0.85,
        source: 'repeated_behavior',
      },
    ]);
    const before = await h.engine.getContext(-100, { focusHandles: ['@bob'] });
    expect(before.runningJokes).toHaveLength(1);
    const jokeId = before.runningJokes[0]?.id;
    expect(jokeId).toBeTruthy();

    await h.engine.recordJokeUse(-100, jokeId as string, 'pure il caffè finisce in una pivot');
    const immediate = await h.engine.getContext(-100, { focusHandles: ['@bob'] });
    expect(immediate.runningJokes).toEqual([]);

    h.advance(80 * 3_600_000);
    const refreshed = await h.engine.getContext(-100, { focusHandles: ['@bob'] });
    expect(refreshed.runningJokes[0]?.variants).toEqual(['ha una macro anche per respirare']);

    await h.engine.recordJokeUse(-100, jokeId as string);
    await h.engine.recordJokeUse(-100, jokeId as string);
    await h.engine.recordJokeUse(-100, jokeId as string);
    await h.engine.recordJokeUse(-100, jokeId as string);
    h.advance(13 * 3_600_000);
    expect((await h.engine.getContext(-100, { focusHandles: ['@bob'] })).runningJokes).toEqual([]);
  });
});

describe('SocialLearningPipeline mining budget', () => {
  it('focuses the social snapshot on window participants and hard-caps prompt context bytes', async () => {
    const getContext = vi.fn(async () => ({
      chatId: -100,
      members: Array.from({ length: 12 }, (_, index) => ({
        handle: index === 0 ? '@alice' : `@member${index}`,
        displayName: `Member ${index} ${'x'.repeat(300)}`,
        aliases: [],
        familiarity: 0.8,
        facets: [
          {
            kind: 'interest' as const,
            key: `interest_${index}`,
            value: 'doom metal '.repeat(40),
            confidence: 0.9,
            salience: 0.8,
          },
        ],
      })),
      relationships: [],
      runningJokes: [],
      norms: [],
    }));
    const extractDetailed = vi.fn(async () => ({ observations: [], degraded: false }));
    const pipeline = new SocialLearningPipeline(
      {
        getContext,
        listKnownHandles: vi.fn(async () => ['@alice', '@bob']),
        observeBatch: vi.fn(async () => ({
          accepted: 0,
          rejected: 0,
          memberProfilesChanged: 0,
          chatStateChanged: false,
        })),
      } as unknown as SocialProfileEngine,
      { extractDetailed } as unknown as SocialObservationMiner,
    );

    await pipeline.learn({
      chatId: -100,
      language: 'italian',
      messages: [
        {
          messageId: 1,
          handle: '@alice',
          replyToHandle: '@bob',
          isBot: false,
          message: { messageText: 'ciao', timestamp: new Date('2026-07-28T08:00:00Z') },
        },
      ],
    });

    expect(getContext).toHaveBeenCalledWith(
      -100,
      expect.objectContaining({
        focusHandles: ['@alice', '@bob'],
        maxMembers: 12,
        maxRelationships: 12,
        maxJokes: 6,
        maxNorms: 8,
      }),
    );
    const extractionInput = extractDetailed.mock.calls[0]?.[0];
    expect(
      Buffer.byteLength(extractionInput?.existingSocialContext ?? '', 'utf8'),
    ).toBeLessThanOrEqual(2_800);
  });
});

describe('social lifecycle and prompt context', () => {
  it('decays unconfirmed inference to stale while preserving strong self declarations longer', () => {
    const start = new Date('2024-01-01T00:00:00Z');
    const old = createMemberProfile(-100, '@alice', start);
    old.facets = [
      {
        id: 'inferred',
        kind: 'goal',
        key: 'next_project',
        normalizedKey: 'next_project',
        value: 'launch a podcast',
        normalizedValue: 'launch a podcast',
        state: 'active',
        confidence: 0.5,
        salience: 0.5,
        source: 'inferred',
        evidenceCount: 1,
        contradictionCount: 0,
        sourceMessageIds: [],
        firstObservedAt: start,
        lastObservedAt: start,
        lastConfirmedAt: start,
      },
      {
        id: 'declared',
        kind: 'interest',
        key: 'music',
        normalizedKey: 'music',
        value: 'jazz',
        normalizedValue: 'jazz',
        state: 'active',
        confidence: 0.9,
        salience: 0.7,
        source: 'self_declared',
        evidenceCount: 1,
        contradictionCount: 0,
        sourceMessageIds: [],
        firstObservedAt: start,
        lastObservedAt: start,
        lastConfirmedAt: start,
      },
    ];
    const now = new Date('2025-06-01T00:00:00Z');
    const options: SocialEvolutionOptions = {
      now,
      id: () => 'unused',
      maxFacetHistory: 80,
      maxJokes: 80,
      maxRelationships: 300,
      maxNormHistory: 40,
    };
    const maintained = maintainMemberProfile(old, options);
    expect(maintained.facets.find((claim) => claim.id === 'inferred')?.state).toBe('stale');
    expect(maintained.facets.find((claim) => claim.id === 'declared')?.state).toBe('active');
  });

  it('renders compact guidance instead of canned roast text', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const alice = createMemberProfile(-100, '@alice', now);
    alice.messageCount = 200;
    alice.displayName = 'Alice';
    alice.facets = [
      {
        id: 'x',
        kind: 'interest',
        key: 'music',
        normalizedKey: 'music',
        value: 'doom metal',
        normalizedValue: 'doom metal',
        state: 'active',
        confidence: 0.9,
        salience: 0.8,
        source: 'self_declared',
        evidenceCount: 2,
        contradictionCount: 0,
        sourceMessageIds: [1],
        firstObservedAt: now,
        lastObservedAt: now,
        lastConfirmedAt: now,
      },
    ];
    const context = buildSocialContext([alice], createChatSocialState(-100, now), {
      now,
      focusHandles: ['@alice'],
    });
    const rendered = renderSocialContext(context);
    expect(rendered).toContain('private working context');
    expect(rendered).toContain('MEMBER @alice');
    expect(rendered).toContain('doom metal');
    expect(rendered).toContain('Running jokes are themes, not scripts');
  });

  it('keeps social prompt focus-only and suppresses one-off identity-like biography', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const berry = createMemberProfile(-100, '@berry', now);
    berry.messageCount = 100;
    berry.displayName = 'Berry';
    const miguel = createMemberProfile(-100, '@miguel', now);
    miguel.messageCount = 100;
    miguel.displayName = 'Miguel';
    miguel.facets = [
      {
        id: 'roleplay-origin',
        kind: 'skill',
        key: 'origin',
        normalizedKey: 'origin',
        value: 'sardo',
        normalizedValue: 'sardo',
        state: 'active',
        confidence: 1,
        salience: 0.8,
        source: 'self_declared',
        evidenceCount: 1,
        contradictionCount: 0,
        sourceMessageIds: [10],
        firstObservedAt: now,
        lastObservedAt: now,
        lastConfirmedAt: now,
      },
    ];
    const johnny = createMemberProfile(-100, '@johnny', now);
    johnny.messageCount = 100;
    johnny.displayName = 'Johnny';
    johnny.facets = [
      {
        id: 'shopping',
        kind: 'habit',
        key: 'shopping',
        normalizedKey: 'shopping',
        value: 'confronta le offerte della spesa',
        normalizedValue: 'confronta le offerte della spesa',
        state: 'active',
        confidence: 0.9,
        salience: 0.8,
        source: 'self_declared',
        evidenceCount: 2,
        contradictionCount: 0,
        sourceMessageIds: [11, 12],
        firstObservedAt: now,
        lastObservedAt: now,
        lastConfirmedAt: now,
      },
    ];

    const berryOnly = buildSocialContext(
      [berry, miguel, johnny],
      createChatSocialState(-100, now),
      { now, focusHandles: ['@berry'], focusOnly: true },
    );
    expect(berryOnly.members.map((member) => member.handle)).toEqual(['@berry']);
    expect(renderSocialContext(berryOnly)).not.toContain('Johnny');

    const miguelContext = buildSocialContext([miguel], createChatSocialState(-100, now), {
      now,
      focusHandles: ['@miguel'],
      focusOnly: true,
    });
    expect(renderSocialContext(miguelContext)).not.toContain('origin=sardo');
    expect(renderSocialContext(miguelContext)).toContain('OWNERSHIP IS HARD');

    miguel.facets.push({
      ...miguel.facets[0]!,
      id: 'operator-nationality',
      kind: 'role',
      key: 'national_identity',
      normalizedKey: 'national_identity',
      value: 'spagnolo',
      normalizedValue: 'spagnolo',
      source: 'admin',
      evidenceCount: 1,
    });
    const corrected = buildSocialContext([miguel], createChatSocialState(-100, now), {
      now,
      focusHandles: ['@miguel'],
      focusOnly: true,
    });
    expect(renderSocialContext(corrected)).toContain('national_identity=spagnolo');
    expect(renderSocialContext(corrected)).not.toContain('origin=sardo');
  });

  it('makes a direct answer to a persisted bot question immediately usable as clarified_self', async () => {
    const { engine } = harness();
    await engine.recordPresence({ chatId: -100, handle: '@miguel', telegramId: 7 });
    const applied = await engine.observeBatch(-100, [
      {
        kind: 'facet',
        subjectHandle: '@miguel',
        facet: 'preference',
        key: 'national_identity',
        value: 'spagnolo',
        action: 'revise',
        confidence: 0.97,
        salience: 0.9,
        source: 'clarified_self',
        sourceMessageId: 99,
        authorHandle: '@miguel',
      },
    ]);
    expect(applied.accepted).toBe(1);
    const context = await engine.getContext(-100, {
      focusHandles: ['@miguel'],
      focusOnly: true,
    });
    expect(renderSocialContext(context)).toContain('national_identity=spagnolo');
  });

  it('validates bounded LLM observations', () => {
    expect(
      socialObservationBatchSchema.safeParse({
        observations: [
          {
            kind: 'relationship',
            fromHandle: '@alice',
            toHandle: '@bob',
            dimension: 'trust',
            delta: 2,
            confidence: 0.8,
            source: 'direct_observation',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('bounds social structured output for a non-streaming 31B mining gateway', async () => {
    let maxTokens: number | undefined;
    const llm = {
      async jsonCompletion(request: { maxTokens?: number }) {
        maxTokens = request.maxTokens;
        return { observations: [] };
      },
    } as unknown as LLMProvider;
    const miner = new SocialObservationMiner(llm);

    await miner.extract({
      language: 'italian',
      existingSocialContext: '',
      messages: [
        {
          messageId: 1,
          handle: '@alice',
          isBot: false,
          message: {
            messageText: 'Adoro il jazz.',
            timestamp: new Date('2026-01-02T03:04:05Z'),
          },
        },
      ],
    });

    expect(maxTokens).toBe(900);
  });

  it('mines automatic updates through a provenance firewall', async () => {
    const llm = {
      async jsonCompletion() {
        return {
          observations: [
            {
              kind: 'facet',
              subjectHandle: '@alice',
              facet: 'interest',
              key: 'music',
              value: 'jazz',
              confidence: 0.9,
              source: 'self_declared',
              sourceMessageId: 1,
              action: 'reinforce',
            },
            {
              kind: 'facet',
              subjectHandle: '@bob',
              facet: 'preference',
              key: 'food',
              value: 'sushi',
              confidence: 0.8,
              source: 'self_declared',
              sourceMessageId: 1,
              action: 'reinforce',
            },
            {
              kind: 'facet',
              subjectHandle: '@invented',
              facet: 'role',
              key: 'chat_role',
              value: 'admin',
              confidence: 1,
              source: 'admin',
              sourceMessageId: 1,
              action: 'reinforce',
            },
            {
              kind: 'running_joke',
              canonicalKey: 'one_off',
              label: 'one-off insult',
              targetHandles: ['@bob'],
              confidence: 0.9,
              source: 'direct_observation',
              sourceMessageId: 1,
              action: 'reinforce',
            },
            {
              kind: 'identity',
              subjectHandle: '@alice',
              displayName: 'LLM-invented alias',
              confidence: 0.99,
              source: 'self_declared',
              sourceMessageId: 1,
            },
          ],
        };
      },
    } as unknown as LLMProvider;
    const miner = new SocialObservationMiner(llm);
    const observations = await miner.extract({
      language: 'italian',
      existingSocialContext: '',
      knownHandles: ['@bob'],
      messages: [
        {
          messageId: 1,
          handle: '@alice',
          isBot: false,
          message: {
            messageText: 'Io adoro il jazz. Bob dice sempre che ama il sushi.',
            timestamp: new Date('2026-01-02T03:04:05Z'),
          },
        },
      ],
    });
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      subjectHandle: '@alice',
      source: 'self_declared',
      authorHandle: '@alice',
      observedAt: new Date('2026-01-02T03:04:05Z'),
    });
    expect(observations[1]).toMatchObject({
      subjectHandle: '@bob',
      source: 'peer_report',
      authorHandle: '@alice',
    });
  });

  it('downgrades one-off nationality/origin labels and ignores injected replied-media transcripts', async () => {
    const llm = {
      async jsonCompletion() {
        return {
          observations: [
            {
              kind: 'facet',
              subjectHandle: '@miguel',
              facet: 'skill',
              key: 'origin',
              value: 'sardo',
              action: 'reinforce',
              confidence: 1,
              salience: 0.9,
              source: 'self_declared',
              sourceMessageId: 50,
            },
          ],
        };
      },
    } as unknown as LLMProvider;
    const miner = new SocialObservationMiner(llm);
    const roleplay = await miner.extract({
      language: 'italian',
      existingSocialContext: '',
      messages: [
        {
          messageId: 50,
          handle: '@miguel',
          isBot: false,
          message: {
            messageText: 'Io sono sardo di Sardinia, sono sardinigger.',
            timestamp: new Date('2026-01-02T03:04:05Z'),
          },
        },
      ],
    });
    expect(roleplay).toEqual([
      expect.objectContaining({
        subjectHandle: '@miguel',
        key: 'origin',
        confidence: 0.55,
        salience: 0.6,
      }),
    ]);

    const transcriptMiner = new SocialObservationMiner({
      async jsonCompletion() {
        return {
          observations: [
            {
              kind: 'facet',
              subjectHandle: '@daniele',
              facet: 'role',
              key: 'work_role',
              value: 'tizio dei video del trattore',
              action: 'reinforce',
              confidence: 0.9,
              salience: 0.8,
              source: 'self_declared',
              sourceMessageId: 50,
            },
          ],
        };
      },
    } as unknown as LLMProvider);
    const transcriptOnly = await transcriptMiner.extract({
      language: 'italian',
      existingSocialContext: '',
      messages: [
        {
          messageId: 50,
          handle: '@daniele',
          isBot: false,
          message: {
            messageText:
              '[transcript of the replied audio/video]: io sono il tizio dei video del trattore',
            timestamp: new Date('2026-01-02T03:04:05Z'),
          },
        },
      ],
    });
    expect(transcriptOnly).toEqual([]);
  });

  it('never lets the automatic miner forge clarified_self provenance', async () => {
    const miner = new SocialObservationMiner({
      async jsonCompletion() {
        return {
          observations: [
            {
              kind: 'facet',
              subjectHandle: '@alice',
              facet: 'preference',
              key: 'music',
              value: 'jazz',
              action: 'reinforce',
              confidence: 0.95,
              salience: 0.7,
              source: 'clarified_self',
              sourceMessageId: 70,
            },
          ],
        };
      },
    } as unknown as LLMProvider);
    const observations = await miner.extract({
      language: 'italian',
      existingSocialContext: '',
      messages: [
        {
          messageId: 70,
          handle: '@alice',
          isBot: false,
          message: {
            messageText: 'jazz',
            timestamp: new Date('2026-01-02T03:04:05Z'),
          },
        },
      ],
    });
    expect(observations).toEqual([
      expect.objectContaining({
        subjectHandle: '@alice',
        source: 'direct_observation',
      }),
    ]);
  });

  it('losslessly normalizes common structured-output aliases before validation', () => {
    const normalized = normalizeSocialMiningCandidate(
      {
        observations: [
          {
            subject: 'alice',
            type: 'INTEREST',
            key: 'music',
            value: 'doom metal',
            action: 'REINFORCE',
            confidence: 0.9,
            source: 'SELF_DECLARED',
            sourceMessageId: '101',
          },
        ],
      },
      new Set([101]),
    );
    expect(socialObservationBatchSchema.parse(normalized)).toEqual({
      observations: [
        expect.objectContaining({
          kind: 'facet',
          subjectHandle: 'alice',
          facet: 'interest',
          action: 'reinforce',
          source: 'self_declared',
          sourceMessageId: 101,
        }),
      ],
    });
  });

  it('uses a conservative local declaration baseline when every LLM route fails', async () => {
    const llm = {
      async jsonCompletion() {
        throw new Error('all routes unavailable');
      },
    } as unknown as LLMProvider;
    const miner = new SocialObservationMiner(llm);
    const extraction = await miner.extractDetailed({
      language: 'italian',
      existingSocialContext: '',
      messages: [
        {
          messageId: 101,
          handle: '@alice',
          isBot: false,
          message: {
            messageText: 'Adoro il doom metal.',
            timestamp: new Date('2026-01-02T03:04:05Z'),
          },
        },
        {
          messageId: 102,
          handle: '@alice',
          isBot: false,
          message: {
            messageText: 'Sono appassionata di politica.',
            timestamp: new Date('2026-01-02T03:05:05Z'),
          },
        },
      ],
    });
    expect(extraction.degraded).toBe(true);
    expect(extraction.observations).toEqual([
      expect.objectContaining({
        kind: 'facet',
        subjectHandle: '@alice',
        facet: 'interest',
        value: 'il doom metal',
        sourceMessageId: 101,
      }),
    ]);
  });

  it('distinguishes a validated empty observation batch from provider degradation', async () => {
    const llm = {
      async jsonCompletion() {
        return { observations: [] };
      },
    } as unknown as LLMProvider;
    const miner = new SocialObservationMiner(llm);
    const extraction = await miner.extractDetailed({
      language: 'italian',
      existingSocialContext: '',
      messages: [
        {
          messageId: 1,
          handle: '@alice',
          isBot: false,
          message: {
            messageText: 'ok',
            timestamp: new Date('2026-01-02T03:04:05Z'),
          },
        },
      ],
    });
    expect(extraction).toEqual({ observations: [], degraded: false });
  });
});
