import { randomUUID } from 'node:crypto';
import { childLogger } from '../utils/logger.js';
import { buildSocialContext, type SocialContextOptions } from './context.js';
import {
  applyChatNormObservation,
  applyFacetObservation,
  applyIdentityObservation,
  applyRelationshipObservation,
  applyRunningJokeObservation,
  createChatSocialState,
  createMemberProfile,
  maintainChatSocialState,
  maintainMemberProfile,
  normalizeSocialHandle,
  normalizeSocialText,
  recordRunningJokeUse,
} from './evolution.js';
import { isValidSocialObservation } from './privacy.js';
import type {
  ChatSocialState,
  MemberSocialProfile,
  SocialContext,
  SocialEvolutionOptions,
  SocialObservation,
  SocialObservationResult,
  SocialProfileStore,
} from './types.js';

const log = childLogger('social-profile-engine');

function mergedFacetHistory(
  left: MemberSocialProfile['facets'],
  right: MemberSocialProfile['facets'],
  limit: number,
): MemberSocialProfile['facets'] {
  const byValue = new Map<string, MemberSocialProfile['facets'][number]>();
  for (const claim of [...left, ...right]) {
    const key = `${claim.kind}:${claim.normalizedKey}:${claim.normalizedValue}`;
    const previous = byValue.get(key);
    if (!previous) {
      byValue.set(key, claim);
      continue;
    }
    const newer =
      claim.lastObservedAt.getTime() >= previous.lastObservedAt.getTime() ? claim : previous;
    byValue.set(key, {
      ...newer,
      confidence: Math.max(previous.confidence, claim.confidence),
      salience: Math.max(previous.salience, claim.salience),
      evidenceCount: previous.evidenceCount + claim.evidenceCount,
      contradictionCount: previous.contradictionCount + claim.contradictionCount,
      sourceMessageIds: [
        ...new Set([...previous.sourceMessageIds, ...claim.sourceMessageIds]),
      ].slice(-24),
      firstObservedAt:
        previous.firstObservedAt.getTime() <= claim.firstObservedAt.getTime()
          ? previous.firstObservedAt
          : claim.firstObservedAt,
      lastObservedAt:
        previous.lastObservedAt.getTime() >= claim.lastObservedAt.getTime()
          ? previous.lastObservedAt
          : claim.lastObservedAt,
      lastConfirmedAt:
        previous.lastConfirmedAt.getTime() >= claim.lastConfirmedAt.getTime()
          ? previous.lastConfirmedAt
          : claim.lastConfirmedAt,
    });
  }
  return [...byValue.values()]
    .sort((a, b) => b.lastObservedAt.getTime() - a.lastObservedAt.getTime())
    .slice(0, limit);
}

export interface SocialProfileEngineConfig {
  maxRetries?: number;
  maxFacetHistory?: number;
  maxJokes?: number;
  maxRelationships?: number;
  maxNormHistory?: number;
  clock?: () => Date;
  idFactory?: () => string;
}

type MemberObservation = Extract<SocialObservation, { kind: 'facet' | 'identity' }>;
type ChatObservation = Exclude<SocialObservation, MemberObservation>;

export class SocialProfileEngine {
  private readonly maxRetries: number;
  private readonly maxFacetHistory: number;
  private readonly maxJokes: number;
  private readonly maxRelationships: number;
  private readonly maxNormHistory: number;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: SocialProfileStore,
    config: SocialProfileEngineConfig = {},
  ) {
    this.maxRetries = config.maxRetries ?? 5;
    this.maxFacetHistory = config.maxFacetHistory ?? 80;
    this.maxJokes = config.maxJokes ?? 80;
    this.maxRelationships = config.maxRelationships ?? 300;
    this.maxNormHistory = config.maxNormHistory ?? 40;
    this.clock = config.clock ?? (() => new Date());
    this.idFactory = config.idFactory ?? randomUUID;
  }

  private options(now = this.clock()): SocialEvolutionOptions {
    return {
      now,
      id: this.idFactory,
      maxFacetHistory: this.maxFacetHistory,
      maxJokes: this.maxJokes,
      maxRelationships: this.maxRelationships,
      maxNormHistory: this.maxNormHistory,
    };
  }

  private observationTime(observation: SocialObservation): Date {
    const now = this.clock();
    const candidate = observation.observedAt;
    if (!(candidate instanceof Date) || !Number.isFinite(candidate.getTime())) return now;
    // Protect decay/lifecycle logic from corrupt timestamps far in the future.
    if (candidate.getTime() > now.getTime() + 5 * 60_000) return now;
    return candidate;
  }

  /**
   * Telegram id is the durable identity; usernames are mutable labels. When the platform reports a
   * new handle for an already-known id, move/merge the social history before recording presence.
   */
  private async reconcileStableIdentity(
    chatId: number,
    handle: string,
    telegramId: number | null | undefined,
    now: Date,
  ): Promise<string> {
    const normalizedHandle = normalizeSocialHandle(handle);
    if (telegramId == null || !this.store.getMemberByTelegramId) return normalizedHandle;
    const targetAtRequestedHandle = await this.store.getMember(chatId, normalizedHandle);
    const previous = await this.store.getMemberByTelegramId(chatId, telegramId);
    if (
      targetAtRequestedHandle?.telegramId != null &&
      targetAtRequestedHandle.telegramId !== telegramId
    ) {
      const stableHandle = previous?.handle ?? `@id${telegramId}`;
      log.warn(
        {
          chatId,
          telegramId,
          stableHandle,
          occupiedHandle: normalizedHandle,
        },
        'keeping Telegram-id identity separate from an occupied social handle',
      );
      return stableHandle;
    }
    if (!previous || previous.handle === normalizedHandle) return normalizedHandle;
    // Historical membership rows are replayed on boot to recover aliases. A delayed/older row must
    // never rename a Telegram identity back to a stale username; recordPresence will retain that
    // requested handle as an alias instead.
    if (previous.lastSeenAt.getTime() > now.getTime()) return previous.handle;

    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const target = await this.store.getMember(chatId, normalizedHandle);
      if (target?.telegramId != null && target.telegramId !== telegramId) {
        log.warn(
          {
            chatId,
            telegramId,
            previousHandle: previous.handle,
            occupiedHandle: normalizedHandle,
          },
          'refusing to merge social identities with different Telegram ids',
        );
        return previous.handle;
      }
      const expectedVersion = target?.version ?? 0;
      const merged: MemberSocialProfile = {
        ...(target ?? previous),
        chatId,
        handle: normalizedHandle,
        telegramId,
        displayName: target?.displayName ?? previous.displayName ?? null,
        aliases: [
          ...new Set([...(target?.aliases ?? []), ...previous.aliases, previous.handle]),
        ].slice(0, 12),
        firstSeenAt:
          target && target.firstSeenAt.getTime() < previous.firstSeenAt.getTime()
            ? target.firstSeenAt
            : previous.firstSeenAt,
        lastSeenAt:
          target && target.lastSeenAt.getTime() > previous.lastSeenAt.getTime()
            ? target.lastSeenAt
            : previous.lastSeenAt,
        messageCount: (target?.messageCount ?? 0) + previous.messageCount,
        facets: mergedFacetHistory(target?.facets ?? [], previous.facets, this.maxFacetHistory),
        createdAt:
          target && target.createdAt.getTime() < previous.createdAt.getTime()
            ? target.createdAt
            : previous.createdAt,
        updatedAt: now,
        version: expectedVersion + 1,
      };
      if (!(await this.store.saveMember(merged, expectedVersion))) continue;
      await this.store.deleteMember(chatId, previous.handle);
      await this.renameChatReferences(chatId, previous.handle, normalizedHandle, now);
      log.info(
        { chatId, telegramId, from: previous.handle, to: normalizedHandle },
        'merged social profile after Telegram handle change',
      );
      return normalizedHandle;
    }
    return previous.handle;
  }

  private async renameChatReferences(
    chatId: number,
    oldHandle: string,
    newHandle: string,
    now: Date,
  ): Promise<void> {
    await this.mutateChat(chatId, (current) => {
      let changed = false;
      const relationships = current.relationships.map((relationship) => {
        const fromHandle =
          relationship.fromHandle === oldHandle ? newHandle : relationship.fromHandle;
        const toHandle = relationship.toHandle === oldHandle ? newHandle : relationship.toHandle;
        if (fromHandle === relationship.fromHandle && toHandle === relationship.toHandle) {
          return relationship;
        }
        changed = true;
        return { ...relationship, fromHandle, toHandle };
      });
      const runningJokes = current.runningJokes.map((joke) => {
        if (!joke.targetHandles.includes(oldHandle)) return joke;
        changed = true;
        return {
          ...joke,
          targetHandles: [
            ...new Set(
              joke.targetHandles.map((target) => (target === oldHandle ? newHandle : target)),
            ),
          ],
        };
      });
      return changed ? { ...current, relationships, runningJokes, updatedAt: now } : null;
    });
  }

  private async mutateMember(
    chatId: number,
    handle: string,
    mutate: (current: MemberSocialProfile) => MemberSocialProfile | null,
  ): Promise<boolean> {
    const normalizedHandle = normalizeSocialHandle(handle);
    if (!normalizedHandle) return false;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const now = this.clock();
      const current =
        (await this.store.getMember(chatId, normalizedHandle)) ??
        createMemberProfile(chatId, normalizedHandle, now);
      const changed = mutate(current);
      if (!changed) return false;
      const next: MemberSocialProfile = {
        ...changed,
        chatId,
        handle: normalizedHandle,
        updatedAt: changed.updatedAt ?? now,
        version: current.version + 1,
      };
      if (await this.store.saveMember(next, current.version)) return true;
    }
    log.warn({ chatId, handle: normalizedHandle }, 'member social profile version race exhausted');
    return false;
  }

  private async mutateChat(
    chatId: number,
    mutate: (current: ChatSocialState) => ChatSocialState | null,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const now = this.clock();
      const current = (await this.store.getChatState(chatId)) ?? createChatSocialState(chatId, now);
      const changed = mutate(current);
      if (!changed) return false;
      const next: ChatSocialState = {
        ...changed,
        chatId,
        updatedAt: changed.updatedAt ?? now,
        version: current.version + 1,
      };
      if (await this.store.saveChatState(next, current.version)) return true;
    }
    log.warn({ chatId }, 'chat social state version race exhausted');
    return false;
  }

  /**
   * Record every seen member, even when there is no durable lore in the message. This is what makes
   * the bot gradually know the whole room rather than only the loudest lore targets.
   */
  async recordPresence(params: {
    chatId: number;
    handle: string;
    telegramId?: number | null;
    displayName?: string | null;
    alias?: string | null;
    seenAt?: Date;
    /** Defaults to one live message; boot migrations can use zero plus minimumMessageCount. */
    messageCountDelta?: number;
    minimumMessageCount?: number;
  }): Promise<boolean> {
    const now = params.seenAt ?? this.clock();
    const stableHandle = await this.reconcileStableIdentity(
      params.chatId,
      params.handle,
      params.telegramId,
      now,
    );
    return this.mutateMember(params.chatId, stableHandle, (current) => {
      const stalePresence = current.lastSeenAt.getTime() > now.getTime();
      const identity = applyIdentityObservation(
        current,
        {
          kind: 'identity',
          subjectHandle: stableHandle,
          telegramId: params.telegramId,
          // Keep historical handles as aliases below, but do not let an old row overwrite the
          // newest platform display name or first-name alias.
          displayName: stalePresence ? undefined : params.displayName,
          alias: stalePresence ? undefined : params.alias,
          confidence: 1,
          source: 'direct_observation',
          observedAt: now,
        },
        this.options(now),
      );
      const updated = identity ?? current;
      const currentHandleAlias =
        stableHandle !== normalizeSocialHandle(params.handle)
          ? normalizeSocialHandle(params.handle)
          : null;
      return {
        ...updated,
        aliases: currentHandleAlias
          ? [
              currentHandleAlias,
              ...updated.aliases.filter((alias) => alias !== currentHandleAlias),
            ].slice(0, 12)
          : updated.aliases,
        lastSeenAt: current.lastSeenAt.getTime() >= now.getTime() ? current.lastSeenAt : now,
        messageCount: Math.max(
          current.messageCount + Math.max(0, params.messageCountDelta ?? 1),
          Math.max(0, params.minimumMessageCount ?? 0),
        ),
        updatedAt: now,
      };
    });
  }

  /** Apply an LLM- or rule-mined batch with conflict resolution and optimistic retries. */
  async observeBatch(
    chatId: number,
    observations: SocialObservation[],
  ): Promise<SocialObservationResult> {
    const memberGroups = new Map<string, MemberObservation[]>();
    const chatObservations: ChatObservation[] = [];
    let rejected = 0;
    for (const observation of observations) {
      if (!isValidSocialObservation(observation)) {
        rejected += 1;
        continue;
      }
      if (observation.kind === 'facet' || observation.kind === 'identity') {
        const handle = normalizeSocialHandle(observation.subjectHandle);
        if (!handle) {
          rejected += 1;
          continue;
        }
        const group = memberGroups.get(handle) ?? [];
        group.push({ ...observation, subjectHandle: handle });
        memberGroups.set(handle, group);
      } else {
        chatObservations.push(observation);
      }
    }

    let accepted = 0;
    let memberProfilesChanged = 0;
    for (const [handle, group] of memberGroups) {
      let groupAccepted = 0;
      let groupRejected = 0;
      const changed = await this.mutateMember(chatId, handle, (current) => {
        groupAccepted = 0;
        groupRejected = 0;
        let next = current;
        for (const observation of group) {
          const options = this.options(this.observationTime(observation));
          const updated =
            observation.kind === 'facet'
              ? applyFacetObservation(next, observation, options)
              : applyIdentityObservation(next, observation, options);
          if (updated) {
            next = updated;
            groupAccepted += 1;
          } else {
            groupRejected += 1;
          }
        }
        return groupAccepted > 0 ? next : null;
      });
      rejected += groupRejected;
      if (changed) {
        accepted += groupAccepted;
        memberProfilesChanged += 1;
      } else if (groupAccepted > 0) {
        // A version race that exhausted retries means none of this group's observations persisted.
        rejected += groupAccepted;
      }
    }

    let chatAccepted = 0;
    let chatRejected = 0;
    const chatStateChanged =
      chatObservations.length > 0
        ? await this.mutateChat(chatId, (current) => {
            chatAccepted = 0;
            chatRejected = 0;
            let next = current;
            for (const observation of chatObservations) {
              const options = this.options(this.observationTime(observation));
              let updated: ChatSocialState | null;
              if (observation.kind === 'relationship') {
                updated = applyRelationshipObservation(next, observation, options);
              } else if (observation.kind === 'running_joke') {
                updated = applyRunningJokeObservation(next, observation, options);
              } else {
                updated = applyChatNormObservation(next, observation, options);
              }
              if (updated) {
                next = updated;
                chatAccepted += 1;
              } else {
                chatRejected += 1;
              }
            }
            return chatAccepted > 0 ? next : null;
          })
        : false;
    rejected += chatRejected;
    if (chatStateChanged) accepted += chatAccepted;
    else if (chatAccepted > 0) rejected += chatAccepted;

    return {
      accepted,
      rejected,
      memberProfilesChanged,
      chatStateChanged,
    };
  }

  async recordJokeUse(chatId: number, jokeId: string, variant?: string | null): Promise<boolean> {
    return this.mutateChat(chatId, (current) =>
      recordRunningJokeUse(current, jokeId, variant ?? null, this.options()),
    );
  }

  /** Run decay and lifecycle maintenance. Safe and idempotent apart from version timestamps. */
  async maintain(chatId: number): Promise<{ members: number; chatState: boolean }> {
    const profiles = await this.store.listMembers(chatId, 500);
    let members = 0;
    for (const profile of profiles) {
      const changed = await this.mutateMember(chatId, profile.handle, (current) => {
        const maintained = maintainMemberProfile(current, this.options());
        return maintained === current ? null : maintained;
      });
      if (changed) members += 1;
    }
    const chatState = await this.mutateChat(chatId, (current) => {
      const maintained = maintainChatSocialState(current, this.options());
      return maintained === current ? null : maintained;
    });
    return { members, chatState };
  }

  async getMember(chatId: number, handle: string): Promise<MemberSocialProfile | null> {
    return this.store.getMember(chatId, normalizeSocialHandle(handle));
  }

  async listKnownHandles(chatId: number, limit = 500): Promise<string[]> {
    const profiles = await this.store.listMembers(chatId, limit);
    return profiles.map((profile) => profile.handle);
  }

  /**
   * Resolve plain display names/aliases that literally occur in the current human-authored text.
   * This is identity lookup, not intent parsing: it only maps an already-seen label to the stable
   * Telegram-backed profile so later context can stay focus-only without losing names like Johnny.
   */
  async resolveHandlesInText(chatId: number, text: string, limit = 8): Promise<string[]> {
    const haystack = ` ${normalizeSocialText(text)} `;
    if (haystack.trim().length < 2) return [];
    const profiles = await this.store.listMembers(chatId, 500);
    const matches: Array<{ handle: string; score: number }> = [];
    for (const profile of profiles) {
      const labels = [
        profile.handle.replace(/^@/, ''),
        profile.displayName ?? '',
        ...profile.aliases,
      ];
      let best = 0;
      for (const label of labels) {
        const normalized = normalizeSocialText(label).trim();
        if (normalized.length < 3) continue;
        if (haystack.includes(` ${normalized} `)) best = Math.max(best, normalized.length);
      }
      if (best > 0) matches.push({ handle: profile.handle, score: best });
    }
    return matches
      .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
      .slice(0, Math.max(1, Math.min(16, Math.trunc(limit) || 1)))
      .map((match) => match.handle);
  }

  /** Remove a member profile and every structured social edge/joke targeting that member. */
  async forgetMember(chatId: number, handle: string): Promise<boolean> {
    const normalizedHandle = normalizeSocialHandle(handle);
    if (!normalizedHandle) return false;
    const deleted = await this.store.deleteMember(chatId, normalizedHandle);
    await this.mutateChat(chatId, (current) => {
      const relationships = current.relationships.filter(
        (relationship) =>
          relationship.fromHandle !== normalizedHandle &&
          relationship.toHandle !== normalizedHandle,
      );
      const runningJokes = current.runningJokes.filter(
        (joke) => !joke.targetHandles.includes(normalizedHandle),
      );
      if (
        relationships.length === current.relationships.length &&
        runningJokes.length === current.runningJokes.length
      ) {
        return null;
      }
      return { ...current, relationships, runningJokes, updatedAt: this.clock() };
    });
    return deleted;
  }

  /**
   * Erase every social observation backed by one Telegram message. Evidence shared with other
   * messages survives; claims that existed only because of this message disappear, and a
   * superseded predecessor is restored when its replacement is removed.
   */
  async forgetBySourceMessage(chatId: number, sourceMessageId: number): Promise<number> {
    if (!Number.isSafeInteger(sourceMessageId)) return 0;
    const profiles = await this.store.listMembers(chatId, 500);
    let removed = 0;
    for (const profile of profiles) {
      let groupRemoved = 0;
      const changed = await this.mutateMember(chatId, profile.handle, (current) => {
        groupRemoved = 0;
        const deletedClaimIds = new Set<string>();
        const facets = current.facets.flatMap((claim) => {
          const evidenceMatch = claim.sourceMessageIds.includes(sourceMessageId);
          const lifecycleMatch = claim.stateChangedBySourceMessageId === sourceMessageId;
          if (!evidenceMatch && !lifecycleMatch) return [claim];
          groupRemoved += 1;
          let updated = claim;
          if (evidenceMatch) {
            const sourceMessageIds = claim.sourceMessageIds.filter((id) => id !== sourceMessageId);
            if (sourceMessageIds.length === 0) {
              deletedClaimIds.add(claim.id);
              return [];
            }
            updated = {
              ...updated,
              sourceMessageIds,
              evidenceCount: Math.max(sourceMessageIds.length, claim.evidenceCount - 1),
            };
          }
          if (lifecycleMatch) {
            updated = {
              ...updated,
              state: claim.stateBeforeLastChange ?? 'active',
              supersededAt: null,
              supersededBy: null,
              stateChangedBySourceMessageId: null,
              stateBeforeLastChange: null,
            };
          }
          return [updated];
        });
        if (groupRemoved === 0) return null;
        const repaired = facets.map((claim) =>
          claim.supersededBy && deletedClaimIds.has(claim.supersededBy)
            ? {
                ...claim,
                state: 'active' as const,
                supersededAt: null,
                supersededBy: null,
              }
            : claim,
        );
        return { ...current, facets: repaired, updatedAt: this.clock() };
      });
      if (changed) removed += groupRemoved;
    }

    let chatRemoved = 0;
    const chatChanged = await this.mutateChat(chatId, (current) => {
      chatRemoved = 0;
      const relationships = current.relationships.flatMap((relationship) => {
        if (!relationship.sourceMessageIds.includes(sourceMessageId)) return [relationship];
        chatRemoved += 1;
        const sourceMessageIds = relationship.sourceMessageIds.filter(
          (id) => id !== sourceMessageId,
        );
        return sourceMessageIds.length === 0
          ? []
          : [
              {
                ...relationship,
                sourceMessageIds,
                evidenceCount: Math.max(sourceMessageIds.length, relationship.evidenceCount - 1),
              },
            ];
      });
      const runningJokes = current.runningJokes.flatMap((joke) => {
        const evidenceMatch = joke.sourceMessageIds.includes(sourceMessageId);
        const lifecycleMatch = joke.stateChangedBySourceMessageId === sourceMessageId;
        if (!evidenceMatch && !lifecycleMatch) return [joke];
        chatRemoved += 1;
        let updated = joke;
        if (evidenceMatch) {
          const sourceMessageIds = joke.sourceMessageIds.filter((id) => id !== sourceMessageId);
          if (sourceMessageIds.length === 0) return [];
          updated = {
            ...updated,
            sourceMessageIds,
            evidenceCount: Math.max(sourceMessageIds.length, joke.evidenceCount - 1),
          };
        }
        if (lifecycleMatch) {
          updated = {
            ...updated,
            state: joke.stateBeforeLastChange ?? 'active',
            stateChangedBySourceMessageId: null,
            stateBeforeLastChange: null,
          };
        }
        return [updated];
      });
      const deletedNormIds = new Set<string>();
      const norms = current.norms.flatMap((norm) => {
        const evidenceMatch = norm.sourceMessageIds.includes(sourceMessageId);
        const lifecycleMatch = norm.stateChangedBySourceMessageId === sourceMessageId;
        if (!evidenceMatch && !lifecycleMatch) return [norm];
        chatRemoved += 1;
        let updated = norm;
        if (evidenceMatch) {
          const sourceMessageIds = norm.sourceMessageIds.filter((id) => id !== sourceMessageId);
          if (sourceMessageIds.length === 0) {
            deletedNormIds.add(norm.id);
            return [];
          }
          updated = {
            ...updated,
            sourceMessageIds,
            evidenceCount: Math.max(sourceMessageIds.length, norm.evidenceCount - 1),
          };
        }
        if (lifecycleMatch) {
          updated = {
            ...updated,
            state: norm.stateBeforeLastChange ?? 'active',
            supersededBy: null,
            stateChangedBySourceMessageId: null,
            stateBeforeLastChange: null,
          };
        }
        return [updated];
      });
      if (chatRemoved === 0) return null;
      const repairedNorms = norms.map((norm) =>
        norm.supersededBy && deletedNormIds.has(norm.supersededBy)
          ? { ...norm, state: 'active' as const, supersededBy: null }
          : norm,
      );
      return {
        ...current,
        relationships,
        runningJokes,
        norms: repairedNorms,
        updatedAt: this.clock(),
      };
    });
    if (chatChanged) removed += chatRemoved;
    return removed;
  }

  async getContext(
    chatId: number,
    options: Omit<SocialContextOptions, 'now'> = {},
  ): Promise<SocialContext> {
    const now = this.clock();
    const [profiles, storedState] = await Promise.all([
      this.store.listMembers(chatId, Math.max(20, options.maxMembers ?? 12)),
      this.store.getChatState(chatId),
    ]);
    const state = storedState ?? createChatSocialState(chatId, now);
    return buildSocialContext(profiles, state, { ...options, now });
  }
}
