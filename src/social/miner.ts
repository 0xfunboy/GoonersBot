import type { LLMProvider } from '../providers/llm/types.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import { childLogger } from '../utils/logger.js';
import {
  compactMiningText,
  MINING_MEDIA_DESCRIPTION_CHARS,
  MINING_MESSAGE_TEXT_CHARS,
} from '../utils/miningPrompt.js';
import { normalizeSocialHandle } from './evolution.js';
import { isValidSocialObservation } from './privacy.js';
import { socialObservationBatchSchema } from './schemas.js';
import type { SocialEvidenceSource, SocialFacetKind, SocialObservation } from './types.js';

const log = childLogger('social-observation-miner');

export const SOCIAL_MINING_SYSTEM = [
  'You observe a group chat and extract compact, evidence-backed updates to its social graph.',
  'Your job is continuity and social awareness, not surveillance. Extract only details useful for future rapport.',
  'Good signals: durable interests/preferences/skills/roles, communication style, explicit goals, recurring habits, trust/warmth/banter affinity between members, genuine chat norms, and running jokes that visibly recur.',
  'A correction must use action="revise"; an explicit denial/removal uses action="retract". Never leave old and new claims pretending both are true.',
  'Interests, skills and habits are set-valued: use reinforce to add another genuine value; revise/retract only when the subject actually corrects or removes one.',
  'Use source="self_declared" only when the subject personally says it. Use peer_report for another member’s claim, direct_observation for visible interaction, repeated_behavior only with repeated evidence, and inferred sparingly.',
  'A peer report must never revise or retract a strong self-declaration. Prefer no observation over a low-confidence guess.',
  'Do not mine a one-off insult as identity or lore. Do not turn temporary mood, irony, roleplay, pasted text, quoted/replied media transcripts, or a bot response into a profile.',
  'Nationality/origin/citizenship/region is high-identity biography: a single joke or provocative self-label is never durable identity. Prefer no observation until serious evidence repeats.',
  'Never extract health, political/religious identity, sexuality, ethnicity, precise location, contact data, credentials, financial identifiers, legal allegations, or other sensitive personal data.',
  'Relationship deltas are directional and gradual (-1..1): trust, warmth, affinity, banter_affinity, support, rivalry, familiarity.',
  'For each observation, sourceMessageId must identify the strongest supporting user message.',
  'Return only schema-valid JSON: {"observations":[...]}. Return an empty list when nothing durable changed.',
].join('\n');

export const SOCIAL_MINING_SCHEMA_HINT = [
  'Root object: {"observations": SocialObservation[]}. Never return a bare array.',
  'Allowed automatic observation shapes:',
  '- facet: {"kind":"facet","subjectHandle":"@handle","facet":"interest|preference|aversion|skill|role|communication_style|goal|habit","key":"short_semantic_slot","value":"concise value or null","action":"reinforce|revise|retract","confidence":0..1,"salience":0..1,"source":"self_declared|direct_observation|repeated_behavior|peer_report|inferred","sourceMessageId":123}',
  '- relationship: {"kind":"relationship","fromHandle":"@a","toHandle":"@b","dimension":"affinity|warmth|trust|banter_affinity|support|rivalry|familiarity","delta":-1..1,"confidence":0..1,"source":"direct_observation|repeated_behavior|peer_report|inferred","sourceMessageId":123}',
  '- running_joke: {"kind":"running_joke","canonicalKey":"stable_key","label":"theme, not a canned insult","targetHandles":["@handle"],"variant":"observed wording or null","action":"reinforce|retire|revive","confidence":0..1,"source":"repeated_behavior","sourceMessageId":123}',
  '- chat_norm: {"kind":"chat_norm","key":"short_semantic_slot","value":"concise value or null","action":"reinforce|revise|retract","confidence":0..1,"source":"direct_observation|repeated_behavior|peer_report|inferred","sourceMessageId":123}',
  'Every observation must copy an integer sourceMessageId shown after # in the transcript.',
  'Do not emit identity observations, admin/migration sources, uppercase enum values, invented handles, or omitted confidence/source fields.',
].join('\n');

function authoredSocialText(raw: string | null | undefined): string {
  const text = raw ?? '';
  if (!text) return '';
  const markers = ['[transcript of the replied audio/video]:', '[media context]:'];
  let cut = text.length;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0) cut = Math.min(cut, index);
  }
  return text.slice(0, cut).trim();
}

function renderTranscript(messages: StoredMessage[]): string {
  return messages
    .map((message) => {
      const id = message.messageId != null ? `#${message.messageId}` : '#unknown';
      const reply = message.replyToHandle ? ` reply-to=${message.replyToHandle}` : '';
      const textParts = [
        compactMiningText(
          authoredSocialText(message.message.messageText),
          MINING_MESSAGE_TEXT_CHARS,
        ),
        message.message.imageDescription
          ? `[image: ${compactMiningText(message.message.imageDescription, MINING_MEDIA_DESCRIPTION_CHARS)}]`
          : null,
        message.message.voiceDescription
          ? `[voice: ${compactMiningText(message.message.voiceDescription, MINING_MEDIA_DESCRIPTION_CHARS)}]`
          : null,
      ].filter(Boolean);
      return `${id} ${message.isBot ? 'BOT' : normalizeSocialHandle(message.handle)}${reply}: ${textParts.join(' ')}`;
    })
    .join('\n');
}

export function buildSocialMiningPrompt(params: {
  messages: StoredMessage[];
  existingSocialContext: string;
  language: string;
  maxObservations: number;
}): string {
  return [
    `Chat language: ${params.language}. Extract at most ${params.maxObservations} updates.`,
    '',
    'CURRENT SOCIAL MODEL (use it to detect reinforcement, corrections and genuinely new details):',
    params.existingSocialContext || '(empty: be conservative)',
    '',
    'NEW CHAT WINDOW:',
    renderTranscript(params.messages),
    '',
    'Output JSON now.',
  ].join('\n');
}

export interface SocialObservationMinerConfig {
  temperature?: number;
  maxObservations?: number;
}

export interface SocialMiningExtraction {
  observations: SocialObservation[];
  /** True when the LLM was unavailable/invalid and only conservative local rules ran. */
  degraded: boolean;
}

const FACET_KINDS = new Set<SocialFacetKind>([
  'interest',
  'preference',
  'aversion',
  'skill',
  'role',
  'communication_style',
  'goal',
  'habit',
]);

const ENUM_FIELDS = new Set(['kind', 'facet', 'action', 'source', 'dimension']);

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalize common structured-output aliases without inventing facts. Only key aliases, known enum
 * casing and an evidence id already present in the transcript may change.
 */
export function normalizeSocialMiningCandidate(
  candidate: unknown,
  validMessageIds: ReadonlySet<number>,
): unknown {
  const root = Array.isArray(candidate) ? { observations: candidate } : objectRecord(candidate);
  if (!root) return candidate;
  const rawObservations = Array.isArray(root['observations'])
    ? root['observations']
    : root['kind'] || root['type'] || root['subject'] || root['subjectHandle']
      ? [root]
      : null;
  if (!rawObservations) return candidate;
  const observations = rawObservations.map((value) => {
    const raw = objectRecord(value);
    if (!raw) return value;
    const normalized: Record<string, unknown> = { ...raw };
    if (normalized['subjectHandle'] === undefined && typeof raw['subject'] === 'string') {
      normalized['subjectHandle'] = raw['subject'];
    }
    if (normalized['fromHandle'] === undefined && typeof raw['from'] === 'string') {
      normalized['fromHandle'] = raw['from'];
    }
    if (normalized['toHandle'] === undefined && typeof raw['to'] === 'string') {
      normalized['toHandle'] = raw['to'];
    }
    const rawType = typeof raw['type'] === 'string' ? raw['type'].toLowerCase() : null;
    const rawKind = typeof raw['kind'] === 'string' ? raw['kind'].toLowerCase() : null;
    const facetAlias = rawType && FACET_KINDS.has(rawType as SocialFacetKind) ? rawType : null;
    if (facetAlias && (!rawKind || FACET_KINDS.has(rawKind as SocialFacetKind))) {
      normalized['kind'] = 'facet';
      if (normalized['facet'] === undefined) normalized['facet'] = facetAlias;
    } else if (rawKind && FACET_KINDS.has(rawKind as SocialFacetKind)) {
      normalized['kind'] = 'facet';
      if (normalized['facet'] === undefined) normalized['facet'] = rawKind;
    }
    for (const field of ENUM_FIELDS) {
      if (typeof normalized[field] === 'string') {
        normalized[field] = normalized[field].toLowerCase();
      }
    }
    const sourceMessageId = normalized['sourceMessageId'];
    if (typeof sourceMessageId === 'string' && /^\d+$/.test(sourceMessageId)) {
      const parsed = Number(sourceMessageId);
      if (Number.isSafeInteger(parsed) && validMessageIds.has(parsed)) {
        normalized['sourceMessageId'] = parsed;
      }
    }
    return normalized;
  });
  return { observations };
}

interface DeclarationPattern {
  facet: SocialFacetKind;
  key: string;
  expression: RegExp;
}

const DECLARATION_PATTERNS: DeclarationPattern[] = [
  {
    facet: 'aversion',
    key: 'declared_aversion',
    expression:
      /\b(?:non\s+mi\s+piace|odio|detesto|non\s+sopporto|i\s+(?:hate|dislike|cannot\s+stand))\s+([^\n.!?;]{2,120})/giu,
  },
  {
    facet: 'interest',
    key: 'declared_interest',
    expression:
      /\b(?:mi\s+piace(?:\s+molto)?|amo|adoro|sono\s+appassionat[oa]\s+(?:di|del|della|dei|delle)|i\s+(?:really\s+)?(?:like|love|enjoy)|i(?:'m|\s+am)\s+into)\s+([^\n.!?;]{2,120})/giu,
  },
  {
    facet: 'skill',
    key: 'declared_skill',
    expression:
      /\b(?:sono\s+brav[oa]\s+(?:a|in)|so\s+(?:usare|fare|programmare)|i(?:'m|\s+am)\s+good\s+at)\s+([^\n.!?;]{2,120})/giu,
  },
  {
    facet: 'goal',
    key: 'declared_goal',
    expression:
      /\b(?:voglio\s+imparare|vorrei\s+imparare|sto\s+imparando|i\s+want\s+to\s+learn|my\s+goal\s+is)\s+([^\n.!?;]{2,120})/giu,
  },
  {
    facet: 'role',
    key: 'declared_role',
    expression: /\b(?:lavoro\s+come|faccio\s+(?:il|la)|i\s+work\s+as)\s+([^\n.!?;]{2,120})/giu,
  },
];

function cleanDeclaredValue(value: string): string | null {
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(/^[,:\s]+|[,:\s]+$/g, '')
    .trim();
  if (
    cleaned.length < 2 ||
    cleaned.length > 120 ||
    cleaned.split(/\s+/).length > 18 ||
    /(?:https?:\/\/|www\.|@\w+|^\s*\/|\[(?:file|image|voice|media)\b)/i.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

function deterministicDeclarations(messages: StoredMessage[]): SocialObservation[] {
  const observations: SocialObservation[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.isBot || message.messageId == null || !message.message.messageText) continue;
    const text = message.message.messageText;
    for (const pattern of DECLARATION_PATTERNS) {
      const expression = new RegExp(pattern.expression.source, pattern.expression.flags);
      for (const match of text.matchAll(expression)) {
        const rawValue = match[1];
        if (!rawValue || match.index == null) continue;
        const prefix = text.slice(Math.max(0, match.index - 40), match.index).toLowerCase();
        // Do not attribute quoted/reported speech or negated positive declarations to the author.
        if (
          /(?:ha\s+detto|dice(?:va)?|scrive(?:va)?|cit(?:azione)?|quote)\s*[:“"' ]*$/.test(prefix)
        )
          continue;
        if (pattern.facet === 'interest' && /(?:\bnon|\bmai)\s*$/.test(prefix)) continue;
        const value = cleanDeclaredValue(rawValue);
        if (!value) continue;
        const observation: SocialObservation = {
          kind: 'facet',
          subjectHandle: message.handle,
          facet: pattern.facet,
          key: pattern.key,
          value,
          action: 'reinforce',
          confidence: 0.88,
          salience: 0.68,
          source: 'self_declared',
          sourceMessageId: message.messageId,
        };
        if (!isValidSocialObservation(observation)) continue;
        const identity = `${message.messageId}:${pattern.facet}:${value.toLowerCase()}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        observations.push(observation);
      }
    }
  }
  return observations;
}

function referencedHandles(observation: SocialObservation): string[] {
  if (observation.kind === 'facet' || observation.kind === 'identity') {
    return [observation.subjectHandle];
  }
  if (observation.kind === 'relationship') {
    return [observation.fromHandle, observation.toHandle];
  }
  if (observation.kind === 'running_joke') return observation.targetHandles ?? [];
  return [];
}

function isIdentityLikeObservation(observation: SocialObservation): boolean {
  if (observation.kind !== 'facet') return false;
  const semantic = `${observation.key} ${observation.value ?? ''}`.toLowerCase();
  return /\b(origin|origine|national|nazional|citizenship|cittadin|country|paese|birthplace|regional origin|etni|ethnic)\b/i.test(
    semantic,
  );
}

function hardenIdentityLikeObservation(observation: SocialObservation): SocialObservation {
  if (!isIdentityLikeObservation(observation)) return observation;
  if (observation.source === 'admin' || observation.source === 'migration') return observation;
  // One LLM-extracted sentence can be irony/roleplay. Keep it as tentative evidence so repeated
  // serious declarations may reinforce it later, but never let one message become confidence=1.
  return {
    ...observation,
    confidence: Math.min(observation.confidence, 0.55),
    salience: Math.min(observation.salience ?? 0.5, 0.6),
  };
}

function withSafeAutomaticSource(
  observation: SocialObservation,
  sourceAuthor: string,
): SocialObservation {
  let normalized = observation;
  if (observation.source === 'admin' || observation.source === 'migration') {
    normalized = { ...normalized, source: 'direct_observation' };
  }
  if (
    normalized.source === 'self_declared' &&
    (normalized.kind === 'facet' || normalized.kind === 'identity') &&
    normalizeSocialHandle(normalized.subjectHandle) !== sourceAuthor
  ) {
    normalized = { ...normalized, source: 'peer_report' };
  }
  // Telegram ids come from the platform adapter, never from model-generated text.
  if (normalized.kind === 'identity' && normalized.telegramId != null) {
    normalized = { ...normalized, telegramId: null };
  }
  return normalized;
}

/**
 * LLM extraction with a deterministic provenance firewall. The model can suggest observations, but
 * it cannot invent members, cite a missing message or grant itself admin-level certainty.
 */
export class SocialObservationMiner {
  private readonly temperature: number;
  private readonly maxObservations: number;

  constructor(
    private readonly llm: LLMProvider,
    config: SocialObservationMinerConfig = {},
  ) {
    this.temperature = config.temperature ?? 0.08;
    this.maxObservations = config.maxObservations ?? 16;
  }

  async extract(params: {
    messages: StoredMessage[];
    existingSocialContext: string;
    language: string;
    knownHandles?: string[];
    /** Only these new message ids may become provenance; older window messages are context only. */
    eligibleSourceMessageIds?: number[];
    /** Used by a backfill after one upstream failure to finish its local baseline without hammering. */
    skipLlm?: boolean;
  }): Promise<SocialObservation[]> {
    return (await this.extractDetailed(params)).observations;
  }

  async extractDetailed(params: {
    messages: StoredMessage[];
    existingSocialContext: string;
    language: string;
    knownHandles?: string[];
    eligibleSourceMessageIds?: number[];
    skipLlm?: boolean;
  }): Promise<SocialMiningExtraction> {
    const userMessages = params.messages.filter((message) => !message.isBot);
    if (userMessages.length === 0) return { observations: [], degraded: false };
    const messageEvidence = new Map<
      number,
      { author: string; observedAt: Date; authoredText: string }
    >();
    const knownHandles = new Set<string>(
      (params.knownHandles ?? []).map(normalizeSocialHandle).filter(Boolean),
    );
    for (const message of userMessages) {
      const handle = normalizeSocialHandle(message.handle);
      if (handle) knownHandles.add(handle);
      if (message.messageId != null) {
        messageEvidence.set(message.messageId, {
          author: handle,
          observedAt: new Date(message.message.timestamp),
          authoredText: authoredSocialText(message.message.messageText),
        });
      }
    }
    const eligibleEvidence = new Set(
      params.eligibleSourceMessageIds ?? [...messageEvidence.keys()],
    );
    let degraded = Boolean(params.skipLlm);
    let proposed: SocialObservation[] = [];
    if (!params.skipLlm) {
      try {
        const result = await this.llm.jsonCompletion({
          system: SOCIAL_MINING_SYSTEM,
          prompt: buildSocialMiningPrompt({
            messages: params.messages,
            existingSocialContext: params.existingSocialContext,
            language: params.language,
            maxObservations: this.maxObservations,
          }),
          schema: socialObservationBatchSchema,
          schemaHint: SOCIAL_MINING_SCHEMA_HINT,
          // Keep the Gemma prompt compact; the detailed hint is authoritative and the returned
          // value is still normalized and validated against the full Zod schema.
          includeGeneratedSchema: false,
          normalizeCandidate: (candidate) =>
            normalizeSocialMiningCandidate(candidate, new Set(messageEvidence.keys())),
          temperature: this.temperature,
          // The window and observation count are bounded upstream. Keeping this at 900 prevents
          // sparse background learning from reserving an oversized share of Gemma's token budget.
          maxTokens: 900,
        });
        if (result) proposed = result.observations ?? [];
        else degraded = true;
      } catch (err) {
        degraded = true;
        log.warn({ err }, 'structured social extraction unavailable; using local safe baseline');
      }
    }
    if (degraded) {
      proposed = deterministicDeclarations(
        userMessages.filter(
          (message) => message.messageId != null && eligibleEvidence.has(message.messageId),
        ),
      );
    }
    const accepted: SocialObservation[] = [];
    for (const raw of proposed.slice(0, this.maxObservations)) {
      const messageId = raw.sourceMessageId;
      const evidence = messageId != null ? messageEvidence.get(messageId) : undefined;
      if (!evidence || messageId == null || !eligibleEvidence.has(messageId)) continue;
      const handles = referencedHandles(raw).map(normalizeSocialHandle).filter(Boolean);
      if (handles.some((handle) => !knownHandles.has(handle))) continue;
      let normalized = withSafeAutomaticSource(raw, evidence.author);
      normalized = hardenIdentityLikeObservation(normalized);
      // If the only content in a human row came from an injected replied-media transcript, it is
      // not evidence authored by that person and cannot back a social observation.
      if (!evidence.authoredText.trim()) continue;
      if (!isValidSocialObservation(normalized)) continue;
      // Platform identity is maintained by recordPresence from Telegram's stable user id. An
      // LLM-authored display name/alias has no reversible identity history, so accepting it would
      // make reply-based /forget incomplete and could overwrite a newer platform value.
      if (normalized.kind === 'identity') continue;
      const source: SocialEvidenceSource = normalized.source;
      if (
        normalized.kind === 'running_joke' &&
        source !== 'repeated_behavior' &&
        normalized.action !== 'retire'
      ) {
        continue;
      }
      accepted.push({
        ...normalized,
        authorHandle: evidence.author,
        observedAt: evidence.observedAt,
      });
    }
    log.debug(
      { proposed: proposed.length, accepted: accepted.length, degraded },
      'social observations mined',
    );
    return { observations: accepted, degraded };
  }
}
