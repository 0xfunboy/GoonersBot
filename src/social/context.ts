import {
  clamp,
  effectiveFacetConfidence,
  effectiveJokeFatigue,
  effectiveNormConfidence,
  effectiveRelationshipConfidence,
  isSetValuedFacet,
  normalizeSocialHandle,
  normalizeSocialText,
} from './evolution.js';
import type {
  ChatSocialState,
  MemberSocialProfile,
  SocialContext,
  SocialFacetClaim,
  SocialMemberContext,
} from './types.js';

const DAY_MS = 86_400_000;

export interface SocialContextOptions {
  now: Date;
  focusHandles?: string[];
  /** Safety-first mode: only people explicitly resolved for this turn may enter the prompt. */
  focusOnly?: boolean;
  maxMembers?: number;
  maxFacetsPerFocusedMember?: number;
  maxFacetsPerOtherMember?: number;
  maxRelationships?: number;
  maxJokes?: number;
  maxNorms?: number;
}

function isIdentityLikeFacet(claim: SocialFacetClaim): boolean {
  const semantic = normalizeSocialText(`${claim.key} ${claim.value}`);
  return /\b(origin|origine|national|nazional|citizenship|cittadin|country|paese|birthplace|nato|nata|regional origin|etni|ethnic)\b/i.test(
    semantic,
  );
}

function facetScore(claim: SocialFacetClaim, now: Date): number {
  const confidence = effectiveFacetConfidence(claim, now);
  const ageDays = Math.max(0, now.getTime() - claim.lastConfirmedAt.getTime()) / DAY_MS;
  const freshness = 0.65 + 0.35 * Math.pow(0.5, ageDays / 90);
  return confidence * (0.45 + claim.salience * 0.55) * freshness;
}

function selectedFacets(
  profile: MemberSocialProfile,
  now: Date,
  limit: number,
): SocialMemberContext['facets'] {
  const bestBySlot = new Map<string, SocialFacetClaim>();
  for (const claim of profile.facets) {
    if (claim.state !== 'active') continue;
    // Identity-like biography is uniquely damaging when wrong. A single banter line or peer report
    // must never become prompt-visible nationality/origin/identity. Admin corrections are allowed
    // immediately; automatic/self evidence needs repetition before it can become social context.
    if (isIdentityLikeFacet(claim)) {
      if (claim.source !== 'admin' && claim.source !== 'migration') {
        const minEvidence = claim.source === 'self_declared' ? 2 : 3;
        if (claim.evidenceCount < minEvidence) continue;
      }
    }
    const confidence = effectiveFacetConfidence(claim, now);
    if (confidence < 0.24) continue;
    const slot = isSetValuedFacet(claim.kind)
      ? `${claim.kind}:${claim.normalizedKey}:${claim.normalizedValue}`
      : `${claim.kind}:${claim.normalizedKey}`;
    const existing = bestBySlot.get(slot);
    if (!existing || facetScore(claim, now) > facetScore(existing, now)) {
      bestBySlot.set(slot, claim);
    }
  }
  return [...bestBySlot.values()]
    .sort((a, b) => facetScore(b, now) - facetScore(a, now))
    .slice(0, limit)
    .map((claim) => ({
      kind: claim.kind,
      key: claim.key,
      value: claim.value,
      confidence: effectiveFacetConfidence(claim, now),
      salience: claim.salience,
    }));
}

/** Build a bounded social snapshot. It only emits active, sufficiently fresh evidence. */
export function buildSocialContext(
  profiles: MemberSocialProfile[],
  chatState: ChatSocialState,
  options: SocialContextOptions,
): SocialContext {
  const focused = new Set((options.focusHandles ?? []).map(normalizeSocialHandle).filter(Boolean));
  const maxMembers = options.maxMembers ?? 12;
  const eligibleProfiles =
    options.focusOnly && focused.size > 0
      ? profiles.filter((profile) => focused.has(profile.handle))
      : profiles;
  const rankedProfiles = [...eligibleProfiles].sort((a, b) => {
    const focusDelta = Number(focused.has(b.handle)) - Number(focused.has(a.handle));
    if (focusDelta !== 0) return focusDelta;
    const seenDelta = b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
    if (seenDelta !== 0) return seenDelta;
    return b.messageCount - a.messageCount;
  });

  const members = rankedProfiles.slice(0, maxMembers).map((profile) => {
    const isFocused = focused.has(profile.handle);
    return {
      handle: profile.handle,
      displayName: profile.displayName,
      aliases: profile.aliases.slice(0, 4),
      familiarity: clamp(Math.log1p(profile.messageCount) / Math.log(501)),
      facets: selectedFacets(
        profile,
        options.now,
        isFocused
          ? (options.maxFacetsPerFocusedMember ?? 8)
          : (options.maxFacetsPerOtherMember ?? 4),
      ),
    };
  });
  const visibleHandles = new Set(members.map((member) => member.handle));

  const relationships = chatState.relationships
    .filter(
      (relationship) =>
        effectiveRelationshipConfidence(relationship, options.now) >= 0.28 &&
        visibleHandles.has(relationship.fromHandle) &&
        visibleHandles.has(relationship.toHandle) &&
        (focused.size === 0 ||
          focused.has(relationship.fromHandle) ||
          focused.has(relationship.toHandle)),
    )
    .sort((a, b) => {
      const aScore = Math.abs(a.score) * effectiveRelationshipConfidence(a, options.now);
      const bScore = Math.abs(b.score) * effectiveRelationshipConfidence(b, options.now);
      return bScore - aScore;
    })
    .slice(0, options.maxRelationships ?? 10)
    .map((relationship) => ({
      fromHandle: relationship.fromHandle,
      toHandle: relationship.toHandle,
      dimension: relationship.dimension,
      score: relationship.score,
      confidence: effectiveRelationshipConfidence(relationship, options.now),
    }));

  const runningJokes = chatState.runningJokes
    .filter((joke) => {
      if (joke.state !== 'active' || joke.confidence < 0.34) return false;
      if (effectiveJokeFatigue(joke, options.now) >= 0.78) return false;
      if (joke.lastUsedAt && options.now.getTime() - joke.lastUsedAt.getTime() < 12 * 3_600_000) {
        return false;
      }
      return (
        focused.size === 0 ||
        joke.targetHandles.length === 0 ||
        joke.targetHandles.some((handle) => focused.has(handle))
      );
    })
    .map((joke) => {
      const fatigue = effectiveJokeFatigue(joke, options.now);
      const targetRelevance = joke.targetHandles.some((handle) => focused.has(handle)) ? 0.2 : 0;
      const score =
        joke.vitality * joke.confidence * (1 - fatigue) +
        targetRelevance +
        Math.min(0.12, joke.evidenceCount * 0.01);
      const variants = joke.variants
        .filter((variant) => !joke.recentVariants.includes(normalizeSocialText(variant)))
        .slice(0, 3);
      return {
        id: joke.id,
        label: joke.label,
        targetHandles: joke.targetHandles,
        variants,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxJokes ?? 3);

  const norms = chatState.norms
    .filter((norm) => norm.state === 'active' && effectiveNormConfidence(norm, options.now) >= 0.38)
    .sort((a, b) => {
      const confidenceDelta =
        effectiveNormConfidence(b, options.now) - effectiveNormConfidence(a, options.now);
      if (confidenceDelta !== 0) return confidenceDelta;
      return b.lastObservedAt.getTime() - a.lastObservedAt.getTime();
    })
    .slice(0, options.maxNorms ?? 6)
    .map((norm) => ({
      key: norm.key,
      value: norm.value,
      confidence: effectiveNormConfidence(norm, options.now),
    }));

  return {
    chatId: chatState.chatId,
    members,
    relationships,
    runningJokes,
    norms,
  };
}

function confidenceWord(confidence: number): string {
  if (confidence >= 0.78) return 'solid';
  if (confidence >= 0.52) return 'likely';
  return 'tentative';
}

/**
 * Render prompt-ready evidence without turning it into canned dialogue.
 * The rules at the top are intentional: the model should internalize this context, not recite it.
 */
export function renderSocialContext(context: SocialContext): string {
  if (
    context.members.length === 0 &&
    context.relationships.length === 0 &&
    context.runningJokes.length === 0 &&
    context.norms.length === 0
  ) {
    return '';
  }
  const lines = [
    'SOCIAL AWARENESS (private working context; never mention profiles, scores or stored memory):',
    '- OWNERSHIP IS HARD: every MEMBER line belongs only to that exact handle. Never transfer a',
    '  trait, anecdote, preference, identity or joke from one member to another.',
    '- Use only when relevant. Treat tentative details as uncertain; never invent missing biography.',
    '- communication_style/content-sharing describes what someone says/posts; it is NOT evidence of',
    '  occupation, nationality, residence, appearance or the identity of people shown in their media.',
    '- A running joke/reputation is not biography. Never turn a comic label into a literal personal fact.',
    '- Match each person’s rapport. Affectionate banter must not erase practical help or empathy.',
    '- Running jokes are themes, not scripts: at most one organically, with a fresh phrasing.',
  ];

  for (const member of context.members) {
    const identity = [member.displayName, ...member.aliases].filter(Boolean).join(' / ');
    const facets = member.facets
      .map(
        (facet) =>
          `${facet.kind}:${facet.key}=${facet.value} (${confidenceWord(facet.confidence)})`,
      )
      .join('; ');
    const familiarity =
      member.familiarity >= 0.72 ? 'core regular' : member.familiarity >= 0.35 ? 'known' : 'newer';
    lines.push(
      `- MEMBER ${member.handle}${identity ? ` [${identity}]` : ''} (${familiarity})${facets ? `: ${facets}` : ''}`,
    );
  }
  for (const relationship of context.relationships) {
    const direction = relationship.score >= 0 ? 'positive/high' : 'low/negative';
    lines.push(
      `- RAPPORT ${relationship.fromHandle} → ${relationship.toHandle}: ${relationship.dimension} ${direction}`,
    );
  }
  if (context.runningJokes.length > 0) {
    lines.push('- AVAILABLE JOKE THEMES (optional; do not quote mechanically):');
    for (const joke of context.runningJokes) {
      const targets =
        joke.targetHandles.length > 0 ? ` targets ${joke.targetHandles.join(', ')}` : '';
      const examples =
        joke.variants.length > 0 ? `; past angles: ${joke.variants.join(' | ')}` : '';
      lines.push(`  • ${joke.id}: ${joke.label}${targets}${examples}`);
    }
  }
  for (const norm of context.norms) {
    lines.push(`- CHAT NORM ${norm.key}: ${norm.value}`);
  }
  return lines.join('\n');
}
