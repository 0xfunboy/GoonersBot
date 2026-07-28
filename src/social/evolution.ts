import { containsSensitive } from '../utils/secrets.js';
import type {
  ChatNormObservation,
  ChatSocialNorm,
  ChatSocialState,
  FacetObservation,
  IdentityObservation,
  MemberSocialProfile,
  RelationshipObservation,
  SocialRelationship,
  RunningJoke,
  RunningJokeObservation,
  RunningJokeState,
  SocialClaimState,
  SocialEvidenceSource,
  SocialEvolutionOptions,
  SocialFacetClaim,
  SocialFacetKind,
} from './types.js';

const DAY_MS = 86_400_000;
const MAX_SOURCE_IDS = 24;
const MAX_ALIASES = 12;
const MAX_JOKE_VARIANTS = 10;
const STRONG_SELF_DECLARATION_CONFIDENCE = 0.72;

/** These facets naturally contain more than one simultaneous truth per semantic key. */
const SET_VALUED_FACETS = new Set<SocialFacetKind>(['interest', 'skill', 'habit']);

export function isSetValuedFacet(kind: SocialFacetKind): boolean {
  return SET_VALUED_FACETS.has(kind);
}

const SOURCE_RELIABILITY: Record<SocialEvidenceSource, number> = {
  self_declared: 1,
  admin: 0.98,
  direct_observation: 0.82,
  repeated_behavior: 0.78,
  peer_report: 0.58,
  migration: 0.52,
  inferred: 0.35,
};

const FACET_HALF_LIFE_DAYS: Record<SocialFacetKind, number> = {
  interest: 360,
  preference: 300,
  aversion: 300,
  skill: 420,
  role: 270,
  communication_style: 120,
  goal: 60,
  habit: 90,
};

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeSocialText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_@+.-]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeSocialHandle(handle: string): string {
  const normalized = normalizeSocialText(handle).replace(/\s+/g, '');
  if (!normalized) return '';
  return normalized.startsWith('@') ? normalized : `@${normalized}`;
}

export function evidenceStrength(confidence: number, source: SocialEvidenceSource): number {
  return clamp(confidence) * SOURCE_RELIABILITY[source];
}

function addSourceId(existing: number[], sourceMessageId: number | null | undefined): number[] {
  if (sourceMessageId == null || !Number.isSafeInteger(sourceMessageId)) return existing;
  return [...new Set([...existing, sourceMessageId])].slice(-MAX_SOURCE_IDS);
}

/**
 * Mining windows intentionally overlap. The same Telegram message therefore reaches the evolution
 * layer more than once; provenance doubles as an idempotency key so repeated jobs cannot inflate
 * confidence, relationship scores or joke vitality from one piece of evidence.
 */
function alreadyObserved(existing: number[], sourceMessageId: number | null | undefined): boolean {
  return (
    sourceMessageId != null &&
    Number.isSafeInteger(sourceMessageId) &&
    existing.includes(sourceMessageId)
  );
}

function isPrivilegedEvidence(source: SocialEvidenceSource): boolean {
  return source === 'self_declared' || source === 'admin';
}

function isStrongSelfDeclaration(claim: SocialFacetClaim): boolean {
  return (
    claim.source === 'self_declared' &&
    claim.confidence >= STRONG_SELF_DECLARATION_CONFIDENCE &&
    (claim.state === 'active' || claim.state === 'disputed')
  );
}

function safeSocialText(value: string | null | undefined, maxLength: number): string | null {
  const text = value?.trim() ?? '';
  if (!text || text.length > maxLength || containsSensitive(text)) return null;
  return text;
}

function facetSlot(claim: Pick<SocialFacetClaim, 'kind' | 'normalizedKey'>): string {
  return `${claim.kind}:${claim.normalizedKey}`;
}

function reinforceConfidence(current: number, strength: number): number {
  // Evidence has diminishing returns: repetition helps, but never turns inference into certainty.
  return clamp(1 - (1 - current) * (1 - strength * 0.38));
}

function staleAdjustedConfidence(claim: SocialFacetClaim, now: Date): number {
  const ageDays = Math.max(0, now.getTime() - claim.lastConfirmedAt.getTime()) / DAY_MS;
  const halfLife = FACET_HALF_LIFE_DAYS[claim.kind];
  const decay = Math.pow(0.5, ageDays / halfLife);
  const sourceFloor = isPrivilegedEvidence(claim.source) ? 0.42 : 0;
  return Math.max(sourceFloor * claim.confidence, claim.confidence * decay);
}

export function effectiveFacetConfidence(claim: SocialFacetClaim, now: Date): number {
  if (claim.state !== 'active' && claim.state !== 'disputed') return 0;
  return staleAdjustedConfidence(claim, now);
}

export function effectiveRelationshipConfidence(
  relationship: SocialRelationship,
  now: Date,
): number {
  const ageDays = Math.max(0, now.getTime() - relationship.lastObservedAt.getTime()) / DAY_MS;
  return clamp(relationship.confidence * Math.pow(0.5, ageDays / 240));
}

export function effectiveNormConfidence(norm: ChatSocialNorm, now: Date): number {
  if (norm.state !== 'active' && norm.state !== 'disputed') return 0;
  const ageDays = Math.max(0, now.getTime() - norm.lastObservedAt.getTime()) / DAY_MS;
  const decayed = norm.confidence * Math.pow(0.5, ageDays / 360);
  const floor = isPrivilegedEvidence(norm.source) ? norm.confidence * 0.4 : 0;
  return Math.max(floor, decayed);
}

export function createMemberProfile(
  chatId: number,
  handle: string,
  now: Date,
): MemberSocialProfile {
  return {
    chatId,
    handle: normalizeSocialHandle(handle),
    aliases: [],
    firstSeenAt: now,
    lastSeenAt: now,
    messageCount: 0,
    facets: [],
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

export function createChatSocialState(chatId: number, now: Date): ChatSocialState {
  return {
    chatId,
    relationships: [],
    runningJokes: [],
    norms: [],
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

export function applyIdentityObservation(
  input: MemberSocialProfile,
  observation: IdentityObservation,
  options: SocialEvolutionOptions,
): MemberSocialProfile | null {
  const subjectHandle = normalizeSocialHandle(observation.subjectHandle);
  if (!subjectHandle || subjectHandle !== input.handle) return null;
  if (
    input.telegramId != null &&
    observation.telegramId != null &&
    input.telegramId !== observation.telegramId
  ) {
    return null;
  }
  const displayName = safeSocialText(observation.displayName, 120);
  const alias = safeSocialText(observation.alias, 80);
  if (
    !displayName &&
    !alias &&
    observation.telegramId == null &&
    observation.sourceMessageId == null
  ) {
    return null;
  }

  const aliases = alias
    ? [
        alias,
        ...input.aliases.filter(
          (candidate) => normalizeSocialText(candidate) !== normalizeSocialText(alias),
        ),
      ].slice(0, MAX_ALIASES)
    : input.aliases;
  const lastSeenAt =
    input.lastSeenAt.getTime() >= options.now.getTime() ? input.lastSeenAt : options.now;

  return {
    ...input,
    ...(displayName ? { displayName } : {}),
    ...(observation.telegramId != null ? { telegramId: observation.telegramId } : {}),
    aliases,
    lastSeenAt,
    updatedAt: options.now,
  };
}

function supersedeClaims(
  facets: SocialFacetClaim[],
  slot: string,
  replacementId: string | null,
  now: Date,
  onlyNormalizedValue?: string,
  preserve?: (claim: SocialFacetClaim) => boolean,
  sourceMessageId?: number | null,
): SocialFacetClaim[] {
  return facets.map((claim) => {
    const matchesValue =
      onlyNormalizedValue == null || claim.normalizedValue === onlyNormalizedValue;
    if (
      facetSlot(claim) !== slot ||
      !matchesValue ||
      preserve?.(claim) === true ||
      (claim.state !== 'active' && claim.state !== 'disputed')
    ) {
      return claim;
    }
    return {
      ...claim,
      state: replacementId ? ('superseded' as const) : ('retracted' as const),
      supersededAt: now,
      supersededBy: replacementId,
      lastObservedAt: now,
      stateChangedBySourceMessageId:
        sourceMessageId != null && Number.isSafeInteger(sourceMessageId) ? sourceMessageId : null,
      stateBeforeLastChange: claim.state,
    };
  });
}

function newFacetClaim(
  observation: FacetObservation,
  value: string,
  options: SocialEvolutionOptions,
  state: SocialClaimState,
): SocialFacetClaim {
  return {
    id: options.id(),
    kind: observation.facet,
    key: observation.key.trim(),
    normalizedKey: normalizeSocialText(observation.key),
    value,
    normalizedValue: normalizeSocialText(value),
    state,
    confidence: evidenceStrength(observation.confidence, observation.source),
    salience: clamp(observation.salience ?? 0.55),
    source: observation.source,
    evidenceCount: 1,
    contradictionCount: 0,
    sourceMessageIds: addSourceId([], observation.sourceMessageId),
    firstObservedAt: options.now,
    lastObservedAt: options.now,
    lastConfirmedAt: options.now,
    supersededAt: null,
    supersededBy: null,
  };
}

function resolveFacetSlot(facets: SocialFacetClaim[], slot: string, now: Date): SocialFacetClaim[] {
  if (facets.some((claim) => facetSlot(claim) === slot && isSetValuedFacet(claim.kind))) {
    return facets;
  }
  const contenders = facets.filter(
    (claim) =>
      facetSlot(claim) === slot && (claim.state === 'active' || claim.state === 'disputed'),
  );
  if (contenders.length < 2) return facets;

  const ranked = [...contenders].sort((a, b) => {
    const aScore = staleAdjustedConfidence(a, now) * SOURCE_RELIABILITY[a.source];
    const bScore = staleAdjustedConfidence(b, now) * SOURCE_RELIABILITY[b.source];
    return bScore - aScore;
  });
  const winner = ranked[0];
  const runnerUp = ranked[1];
  if (!winner || !runnerUp) return facets;
  const winnerScore = staleAdjustedConfidence(winner, now) * SOURCE_RELIABILITY[winner.source];
  const runnerUpScore =
    staleAdjustedConfidence(runnerUp, now) * SOURCE_RELIABILITY[runnerUp.source];
  const decisive =
    isPrivilegedEvidence(winner.source) ||
    (winner.evidenceCount >= 2 && winnerScore >= runnerUpScore + 0.14);
  if (!decisive) return facets;

  return facets.map((claim) => {
    if (claim.id === winner.id) return { ...claim, state: 'active' };
    if (facetSlot(claim) === slot && (claim.state === 'active' || claim.state === 'disputed')) {
      return {
        ...claim,
        state: 'superseded',
        supersededAt: now,
        supersededBy: winner.id,
      };
    }
    return claim;
  });
}

export function applyFacetObservation(
  input: MemberSocialProfile,
  observation: FacetObservation,
  options: SocialEvolutionOptions,
): MemberSocialProfile | null {
  const subjectHandle = normalizeSocialHandle(observation.subjectHandle);
  const key = safeSocialText(observation.key, 100);
  const value = safeSocialText(observation.value, 240);
  const action = observation.action ?? 'reinforce';
  if (!subjectHandle || subjectHandle !== input.handle || !key) return null;
  if (action !== 'retract' && !value) return null;

  const normalizedKey = normalizeSocialText(key);
  const normalizedValue = value ? normalizeSocialText(value) : undefined;
  const slot = `${observation.facet}:${normalizedKey}`;
  const current = input.facets.filter(
    (claim) =>
      facetSlot(claim) === slot && (claim.state === 'active' || claim.state === 'disputed'),
  );

  if (action === 'retract') {
    if (current.length === 0) return null;
    const preserveStrongSelf =
      observation.source === 'peer_report'
        ? (claim: SocialFacetClaim) => isStrongSelfDeclaration(claim)
        : undefined;
    const facets = supersedeClaims(
      input.facets,
      slot,
      null,
      options.now,
      normalizedValue,
      preserveStrongSelf,
      observation.sourceMessageId,
    );
    if (facets.every((claim, index) => claim === input.facets[index])) return null;
    return { ...input, facets, updatedAt: options.now };
  }

  const exact = current.find((claim) => claim.normalizedValue === normalizedValue);
  const strength = evidenceStrength(observation.confidence, observation.source);
  if (exact) {
    if (alreadyObserved(exact.sourceMessageIds, observation.sourceMessageId)) return null;
    let facets = input.facets.map((claim) =>
      claim.id === exact.id
        ? {
            ...claim,
            state: claim.state,
            confidence: reinforceConfidence(claim.confidence, strength),
            salience: clamp(Math.max(claim.salience, observation.salience ?? 0.55) + 0.015),
            source:
              SOURCE_RELIABILITY[observation.source] > SOURCE_RELIABILITY[claim.source]
                ? observation.source
                : claim.source,
            evidenceCount: claim.evidenceCount + 1,
            sourceMessageIds: addSourceId(claim.sourceMessageIds, observation.sourceMessageId),
            lastObservedAt: options.now,
            lastConfirmedAt: options.now,
          }
        : claim,
    );
    facets = resolveFacetSlot(facets, slot, options.now);
    return { ...input, facets, updatedAt: options.now };
  }

  const newClaim = newFacetClaim({ ...observation, key }, value as string, options, 'active');
  const setValuedReinforcement = isSetValuedFacet(observation.facet) && action === 'reinforce';
  if (setValuedReinforcement) {
    return {
      ...input,
      facets: trimFacetHistory([...input.facets, newClaim], options.maxFacetHistory),
      updatedAt: options.now,
    };
  }
  const incumbentScore = current.reduce(
    (max, claim) =>
      Math.max(max, staleAdjustedConfidence(claim, options.now) * SOURCE_RELIABILITY[claim.source]),
    0,
  );
  const protectedSelfDeclaration =
    observation.source === 'peer_report' && current.some(isStrongSelfDeclaration);
  const decisiveCorrection =
    !protectedSelfDeclaration &&
    (action === 'revise' ||
      isPrivilegedEvidence(observation.source) ||
      strength >= incumbentScore + 0.2);

  let facets: SocialFacetClaim[];
  if (current.length === 0 || decisiveCorrection) {
    facets = supersedeClaims(
      input.facets,
      slot,
      newClaim.id,
      options.now,
      undefined,
      undefined,
      observation.sourceMessageId,
    );
    facets.push(newClaim);
  } else {
    // Keep the incumbent usable while preserving the contradiction for future evidence to resolve.
    facets = input.facets.map((claim) =>
      facetSlot(claim) === slot && claim.state === 'active'
        ? {
            ...claim,
            contradictionCount: claim.contradictionCount + 1,
            confidence: isStrongSelfDeclaration(claim)
              ? claim.confidence
              : clamp(claim.confidence - strength * 0.08),
            lastObservedAt: options.now,
          }
        : claim,
    );
    facets.push({ ...newClaim, state: 'disputed' });
  }

  return {
    ...input,
    facets: trimFacetHistory(facets, options.maxFacetHistory),
    updatedAt: options.now,
  };
}

function trimFacetHistory(facets: SocialFacetClaim[], limit: number): SocialFacetClaim[] {
  if (facets.length <= limit) return facets;
  const stateWeight: Record<SocialClaimState, number> = {
    active: 5,
    disputed: 4,
    superseded: 3,
    retracted: 2,
    stale: 1,
  };
  return [...facets]
    .sort((a, b) => {
      const stateDelta = stateWeight[b.state] - stateWeight[a.state];
      if (stateDelta !== 0) return stateDelta;
      return b.lastObservedAt.getTime() - a.lastObservedAt.getTime();
    })
    .slice(0, Math.max(1, limit));
}

export function maintainMemberProfile(
  input: MemberSocialProfile,
  options: SocialEvolutionOptions,
): MemberSocialProfile {
  let changed = false;
  const facets = trimFacetHistory(
    input.facets.map((claim) => {
      if (
        (claim.state === 'active' || claim.state === 'disputed') &&
        staleAdjustedConfidence(claim, options.now) < 0.18
      ) {
        changed = true;
        return { ...claim, state: 'stale' as const };
      }
      return claim;
    }),
    options.maxFacetHistory,
  );
  if (facets.length !== input.facets.length) changed = true;
  if (!changed) return input;
  return { ...input, facets, updatedAt: options.now };
}

export function applyRelationshipObservation(
  input: ChatSocialState,
  observation: RelationshipObservation,
  options: SocialEvolutionOptions,
): ChatSocialState | null {
  const fromHandle = normalizeSocialHandle(observation.fromHandle);
  const toHandle = normalizeSocialHandle(observation.toHandle);
  if (!fromHandle || !toHandle || fromHandle === toHandle) return null;
  const delta = clamp(observation.delta, -1, 1);
  const index = input.relationships.findIndex(
    (relationship) =>
      relationship.fromHandle === fromHandle &&
      relationship.toHandle === toHandle &&
      relationship.dimension === observation.dimension,
  );
  const strength = evidenceStrength(observation.confidence, observation.source);
  const relationships = [...input.relationships];
  if (index < 0) {
    relationships.push({
      id: options.id(),
      fromHandle,
      toHandle,
      dimension: observation.dimension,
      score: clamp(delta * (0.35 + strength * 0.35), -1, 1),
      confidence: clamp(strength),
      evidenceCount: 1,
      sourceMessageIds: addSourceId([], observation.sourceMessageId),
      firstObservedAt: options.now,
      lastObservedAt: options.now,
    });
  } else {
    const current = relationships[index];
    if (!current) return null;
    if (alreadyObserved(current.sourceMessageIds, observation.sourceMessageId)) return null;
    const alpha = 0.12 + strength * 0.3;
    relationships[index] = {
      ...current,
      score: clamp(current.score * (1 - alpha) + delta * alpha, -1, 1),
      confidence: reinforceConfidence(current.confidence, strength),
      evidenceCount: current.evidenceCount + 1,
      sourceMessageIds: addSourceId(current.sourceMessageIds, observation.sourceMessageId),
      lastObservedAt: options.now,
    };
  }
  return {
    ...input,
    relationships: relationships
      .sort((a, b) => b.lastObservedAt.getTime() - a.lastObservedAt.getTime())
      .slice(0, options.maxRelationships),
    updatedAt: options.now,
  };
}

function jokeFatigueAt(joke: RunningJoke, now: Date): number {
  const hours = Math.max(0, now.getTime() - joke.fatigueUpdatedAt.getTime()) / 3_600_000;
  // Fatigue halves every 72 hours without use.
  return clamp(joke.fatigue * Math.pow(0.5, hours / 72));
}

export function effectiveJokeFatigue(joke: RunningJoke, now: Date): number {
  return jokeFatigueAt(joke, now);
}

export function applyRunningJokeObservation(
  input: ChatSocialState,
  observation: RunningJokeObservation,
  options: SocialEvolutionOptions,
): ChatSocialState | null {
  const canonicalKey = normalizeSocialText(observation.canonicalKey);
  const label = safeSocialText(observation.label, 180);
  const variant = safeSocialText(observation.variant, 220);
  if (!canonicalKey || !label) return null;
  const targetHandles = [...new Set((observation.targetHandles ?? []).map(normalizeSocialHandle))]
    .filter(Boolean)
    .slice(0, 12);
  const index = input.runningJokes.findIndex((joke) => joke.canonicalKey === canonicalKey);
  const jokes = [...input.runningJokes];
  const action = observation.action ?? 'reinforce';
  const strength = evidenceStrength(observation.confidence, observation.source);

  if (index < 0) {
    if (action === 'retire') return null;
    jokes.push({
      id: options.id(),
      canonicalKey,
      label,
      targetHandles,
      variants: variant ? [variant] : [],
      // One model-labelled occurrence is only a pending hypothesis. Retrieval sees the joke after
      // independent provenance confirms it at least once more.
      state: 'cooling',
      confidence: clamp(strength),
      vitality: clamp(0.42 + strength * 0.38),
      evidenceCount: 1,
      sourceMessageIds: addSourceId([], observation.sourceMessageId),
      firstObservedAt: options.now,
      lastObservedAt: options.now,
      lastUsedAt: null,
      useCount: 0,
      recentVariants: [],
      fatigue: 0,
      fatigueUpdatedAt: options.now,
    });
  } else {
    const current = jokes[index];
    if (!current) return null;
    if (
      alreadyObserved(current.sourceMessageIds, observation.sourceMessageId) &&
      (action !== 'retire' || current.state === 'retired')
    ) {
      return null;
    }
    if (action === 'retire') {
      jokes[index] = {
        ...current,
        state: 'retired',
        lastObservedAt: options.now,
        stateChangedBySourceMessageId:
          observation.sourceMessageId != null && Number.isSafeInteger(observation.sourceMessageId)
            ? observation.sourceMessageId
            : null,
        stateBeforeLastChange: current.state,
      };
    } else {
      const variants =
        variant &&
        !current.variants.some(
          (candidate) => normalizeSocialText(candidate) === normalizeSocialText(variant),
        )
          ? [variant, ...current.variants].slice(0, MAX_JOKE_VARIANTS)
          : current.variants;
      jokes[index] = {
        ...current,
        label,
        targetHandles: [...new Set([...current.targetHandles, ...targetHandles])].slice(0, 12),
        variants,
        state: current.evidenceCount + 1 >= 2 ? 'active' : 'cooling',
        ...(current.state !== (current.evidenceCount + 1 >= 2 ? 'active' : 'cooling')
          ? {
              stateChangedBySourceMessageId:
                observation.sourceMessageId != null &&
                Number.isSafeInteger(observation.sourceMessageId)
                  ? observation.sourceMessageId
                  : null,
              stateBeforeLastChange: current.state,
            }
          : {}),
        confidence: reinforceConfidence(current.confidence, strength),
        vitality: clamp(current.vitality + strength * 0.09),
        evidenceCount: current.evidenceCount + 1,
        sourceMessageIds: addSourceId(current.sourceMessageIds, observation.sourceMessageId),
        lastObservedAt: options.now,
        fatigue: jokeFatigueAt(current, options.now),
        fatigueUpdatedAt: options.now,
      };
    }
  }

  return {
    ...input,
    runningJokes: jokes
      .sort((a, b) => {
        if (a.state !== b.state) return a.state === 'active' ? -1 : 1;
        return b.lastObservedAt.getTime() - a.lastObservedAt.getTime();
      })
      .slice(0, options.maxJokes),
    updatedAt: options.now,
  };
}

export function recordRunningJokeUse(
  input: ChatSocialState,
  jokeId: string,
  variant: string | null,
  options: SocialEvolutionOptions,
): ChatSocialState | null {
  const index = input.runningJokes.findIndex((joke) => joke.id === jokeId);
  if (index < 0) return null;
  const jokes = [...input.runningJokes];
  const current = jokes[index];
  if (!current || current.state === 'retired') return null;
  const normalizedVariant = variant ? normalizeSocialText(variant) : '';
  const fatigue = clamp(jokeFatigueAt(current, options.now) + 0.2);
  jokes[index] = {
    ...current,
    state: fatigue >= 0.78 ? 'cooling' : current.state,
    lastUsedAt: options.now,
    useCount: current.useCount + 1,
    recentVariants: normalizedVariant
      ? [normalizedVariant, ...current.recentVariants.filter((v) => v !== normalizedVariant)].slice(
          0,
          5,
        )
      : current.recentVariants,
    fatigue,
    fatigueUpdatedAt: options.now,
  };
  return { ...input, runningJokes: jokes, updatedAt: options.now };
}

function normSlot(norm: Pick<ChatSocialNorm, 'normalizedKey'>): string {
  return norm.normalizedKey;
}

export function applyChatNormObservation(
  input: ChatSocialState,
  observation: ChatNormObservation,
  options: SocialEvolutionOptions,
): ChatSocialState | null {
  const key = safeSocialText(observation.key, 100);
  const value = safeSocialText(observation.value, 220);
  const action = observation.action ?? 'reinforce';
  if (!key || (action !== 'retract' && !value)) return null;
  const normalizedKey = normalizeSocialText(key);
  const normalizedValue = value ? normalizeSocialText(value) : undefined;
  const current = input.norms.filter(
    (norm) =>
      normSlot(norm) === normalizedKey && (norm.state === 'active' || norm.state === 'disputed'),
  );
  if (action === 'retract') {
    if (current.length === 0) return null;
    return {
      ...input,
      norms: input.norms.map((norm) =>
        normSlot(norm) === normalizedKey &&
        (normalizedValue == null || norm.normalizedValue === normalizedValue) &&
        (norm.state === 'active' || norm.state === 'disputed')
          ? {
              ...norm,
              state: 'retracted' as const,
              lastObservedAt: options.now,
              stateChangedBySourceMessageId:
                observation.sourceMessageId != null &&
                Number.isSafeInteger(observation.sourceMessageId)
                  ? observation.sourceMessageId
                  : null,
              stateBeforeLastChange: norm.state,
            }
          : norm,
      ),
      updatedAt: options.now,
    };
  }

  const exact = current.find((norm) => norm.normalizedValue === normalizedValue);
  const strength = evidenceStrength(observation.confidence, observation.source);
  if (exact) {
    if (alreadyObserved(exact.sourceMessageIds, observation.sourceMessageId)) return null;
    return {
      ...input,
      norms: input.norms.map((norm) =>
        norm.id === exact.id
          ? {
              ...norm,
              confidence: reinforceConfidence(norm.confidence, strength),
              evidenceCount: norm.evidenceCount + 1,
              sourceMessageIds: addSourceId(norm.sourceMessageIds, observation.sourceMessageId),
              lastObservedAt: options.now,
            }
          : norm,
      ),
      updatedAt: options.now,
    };
  }

  const replacement: ChatSocialNorm = {
    id: options.id(),
    key,
    normalizedKey,
    value: value as string,
    normalizedValue: normalizedValue as string,
    state: 'active',
    confidence: clamp(strength),
    source: observation.source,
    evidenceCount: 1,
    sourceMessageIds: addSourceId([], observation.sourceMessageId),
    firstObservedAt: options.now,
    lastObservedAt: options.now,
    supersededBy: null,
  };
  const decisive =
    action === 'revise' ||
    isPrivilegedEvidence(observation.source) ||
    current.every((norm) => strength >= norm.confidence + 0.2);
  const norms = input.norms.map((norm) =>
    normSlot(norm) === normalizedKey && (norm.state === 'active' || norm.state === 'disputed')
      ? decisive
        ? {
            ...norm,
            state: 'superseded' as const,
            supersededBy: replacement.id,
            stateChangedBySourceMessageId:
              observation.sourceMessageId != null &&
              Number.isSafeInteger(observation.sourceMessageId)
                ? observation.sourceMessageId
                : null,
            stateBeforeLastChange: norm.state,
          }
        : norm
      : norm,
  );
  norms.push({ ...replacement, state: decisive || current.length === 0 ? 'active' : 'disputed' });
  return {
    ...input,
    norms: norms
      .sort((a, b) => {
        if (a.state !== b.state) return a.state === 'active' ? -1 : 1;
        return b.lastObservedAt.getTime() - a.lastObservedAt.getTime();
      })
      .slice(0, options.maxNormHistory),
    updatedAt: options.now,
  };
}

export function maintainChatSocialState(
  input: ChatSocialState,
  options: SocialEvolutionOptions,
): ChatSocialState {
  let changed = false;
  const runningJokes = input.runningJokes.map((joke) => {
    if (joke.state === 'retired') return joke;
    const fatigue = jokeFatigueAt(joke, options.now);
    const idleDays = Math.max(0, options.now.getTime() - joke.lastObservedAt.getTime()) / DAY_MS;
    let state: RunningJokeState = joke.state;
    if (joke.evidenceCount < 2) {
      state = idleDays > 45 ? 'retired' : 'cooling';
    } else if (idleDays > 180 || (idleDays > 90 && joke.confidence < 0.5)) state = 'retired';
    else if (fatigue >= 0.78 || idleDays > 45) state = 'cooling';
    else if (fatigue < 0.42 && idleDays <= 45) state = 'active';
    // Persist meaningful fatigue movement, but do not version-bump zero-fatigue/no-state-change
    // records on every maintenance tick.
    if (state === joke.state && Math.abs(fatigue - joke.fatigue) < 0.005) return joke;
    changed = true;
    return {
      ...joke,
      state,
      fatigue,
      fatigueUpdatedAt: options.now,
    };
  });
  const relationships = input.relationships.filter(
    (relationship) => effectiveRelationshipConfidence(relationship, options.now) >= 0.12,
  );
  if (relationships.length !== input.relationships.length) changed = true;
  const norms = input.norms
    .map((norm) => {
      if (
        (norm.state === 'active' || norm.state === 'disputed') &&
        effectiveNormConfidence(norm, options.now) < 0.18
      ) {
        changed = true;
        return { ...norm, state: 'stale' as const };
      }
      return norm;
    })
    .slice(0, options.maxNormHistory);
  if (norms.length !== input.norms.length) changed = true;
  if (!changed) return input;
  return { ...input, relationships, runningJokes, norms, updatedAt: options.now };
}
