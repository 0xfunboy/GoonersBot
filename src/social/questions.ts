import { z } from 'zod';
import type { SceneAnalysis } from '../brain/types.js';
import type { Person, ChatContext } from '../domain/types.js';
import type { LLMProvider } from '../providers/llm/types.js';
import type {
  SocialQuestionsRepo,
  SocialQuestionDoc,
} from '../storage/repositories/socialQuestions.js';
import { isSetValuedFacet, normalizeSocialHandle } from './evolution.js';
import type { SocialFacetKind } from './types.js';
import type { SocialProfileEngine } from './engine.js';

const QUESTION_FACETS = [
  'interest',
  'preference',
  'aversion',
  'skill',
  'role',
  'communication_style',
  'goal',
  'habit',
] as const satisfies readonly SocialFacetKind[];

const planSchema = z.object({
  ask: z.boolean(),
  kind: z.enum(['clarification', 'curiosity']).nullable().default(null),
  targetHandle: z.string().max(80).nullable().default(null),
  subjectHandle: z.string().max(80).nullable().default(null),
  question: z.string().max(700).nullable().default(null),
  facet: z.enum(QUESTION_FACETS).nullable().default(null),
  key: z.string().max(100).nullable().default(null),
  candidates: z.array(z.string().max(180)).max(8).default([]),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().max(500).default(''),
});

const answerSchema = z.object({
  status: z.enum(['answered', 'declined', 'not_answer']),
  value: z.string().max(300).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().max(400).default(''),
});

const PLANNER_SYSTEM = [
  'You decide whether a Telegram community bot should ask ONE human-like follow-up question.',
  'Questions are for two purposes only:',
  '1) clarification: resolve a real ambiguity about who a fact belongs to or which value is correct;',
  '2) curiosity: occasionally learn one durable, non-sensitive detail about the current speaker.',
  'Never interrogate. Never ask a question just to keep engagement alive. If there is no natural useful question, ask=false.',
  'Curiosity must be directly connected to what the person is already discussing and must not ask for information already present in SOCIAL CONTEXT.',
  'Never ask about health/diagnoses, religion, political ideology/party, ethnicity/race, sexual orientation or sex life, exact location/address, credentials, finances, legal/criminal history or similarly sensitive data.',
  'For clarification, ask the current speaker a short concrete question. subjectHandle may be another visible member if the speaker is clarifying a peer report.',
  'A pure referent question such as "who is Piero / which one is the tractor-video person?" is conversational disambiguation: set facet=null and key=null so the answer resolves this turn state without creating fake biography.',
  'Only attach facet/key to clarification when the answer truly corrects a durable profile slot already under dispute.',
  'For curiosity, targetHandle=subjectHandle=current speaker and choose a durable facet/key such as music, anime, food, hobby, project, skill, goal, routine or communication preference.',
  'Do not invent handles. Use only handles supplied in ALLOWED HANDLES.',
  'Return only schema-valid JSON.',
].join('\n');

const ANSWER_SYSTEM = [
  'You evaluate whether the current Telegram message answers a specific previously asked bot question.',
  'Use ONLY the current answer and the exact stored question. Do not infer from unrelated chat lore.',
  'answered: the user provides a clear value, correction or selection. Return the concise value in value.',
  'declined: they explicitly refuse, dodge or say they do not want to answer.',
  'not_answer: the message is unrelated or too ambiguous to bind to this question.',
  'If candidates are supplied, preserve the user-selected candidate wording when possible.',
  'Return only schema-valid JSON.',
].join('\n');

const SENSITIVE_QUESTION_RE =
  /\b(?:health|salute|diagnos|malatt|relig|politic|ideolog|partito|ethni|etni|razza|race|sexual|sessual|orientamento|indirizzo|address|telefono|phone|password|credenzial|reddito|stipendio|salary|income|criminal|reato|fedina|legal history)\b/i;
const IDENTITY_CURIOSITY_RE =
  /\b(?:origin\w*|origine|national\w*|nazional\w*|citizenship|cittadin\w*|passport|passaporto|country|paese|nato|nata)\b/i;

export interface SocialQuestionConfig {
  enabled: boolean;
  curiosityProbability: number;
  userCooldownMinutes: number;
  ttlMinutes: number;
  unquotedAnswerWindowMinutes: number;
  model?: string | undefined;
}

export interface PreparedSocialQuestion {
  id: string;
  kind: 'clarification' | 'curiosity';
  questionText: string;
}

export interface SocialQuestionResolution {
  questionId: string;
  state: 'answered' | 'declined';
  value?: string | undefined;
  context: string;
}

export class SocialQuestionService {
  constructor(
    private readonly llm: LLMProvider,
    private readonly repo: SocialQuestionsRepo,
    private readonly social: SocialProfileEngine,
    private readonly config: SocialQuestionConfig,
    private readonly random: () => number = Math.random,
  ) {}

  async hasPotentialAnswer(params: { person: Person; context: ChatContext }): Promise<boolean> {
    if (!this.config.enabled) return false;
    const question = await this.repo.findPendingForAnswer({
      chatId: params.context.chatId,
      threadId: params.context.threadId,
      targetHandle: normalizeSocialHandle(params.person.userHandle),
      replyToMessageId: params.context.repliedToMessageId,
    });
    if (!question) return false;
    if (params.context.repliedToMessageId === question.botMessageId) return true;
    return (
      Date.now() - question.createdAt.getTime() <= this.config.unquotedAnswerWindowMinutes * 60_000
    );
  }

  async maybePrepare(params: {
    person: Person;
    context: ChatContext;
    scene: SceneAnalysis;
    currentMessage: string;
    socialContext: string;
    attributionIssues?: string[] | undefined;
    language: string;
    model?: string | undefined;
    answerResolvedThisTurn?: boolean | undefined;
  }): Promise<PreparedSocialQuestion | null> {
    if (!this.config.enabled || params.answerResolvedThisTurn) return null;
    if (
      params.scene.socialSignal?.supportNeed === 'high' ||
      params.scene.socialSignal?.supportNeed === 'urgent'
    ) {
      return null;
    }
    if (params.scene.botIsBeingCriticized) return null;

    const forcedClarification = (params.attributionIssues?.length ?? 0) > 0;
    if (!forcedClarification && this.random() >= clamp01(this.config.curiosityProbability))
      return null;

    const recent = await this.repo.hasRecentQuestion({
      chatId: params.context.chatId,
      targetHandle: normalizeSocialHandle(params.person.userHandle),
      since: new Date(Date.now() - this.config.userCooldownMinutes * 60_000),
    });
    if (recent && !forcedClarification) return null;

    const allowedHandles = await this.social.resolveHandlesInText(
      params.context.chatId,
      [params.currentMessage, params.socialContext].join('\n'),
      10,
    );
    const allowed = [
      ...new Set([
        normalizeSocialHandle(params.person.userHandle),
        ...(params.context.repliedToUserHandle
          ? [normalizeSocialHandle(params.context.repliedToUserHandle)]
          : []),
        ...allowedHandles,
      ]),
    ].filter(Boolean);

    const result = await this.llm.jsonCompletion({
      system: PLANNER_SYSTEM,
      prompt: [
        `MODE: ${forcedClarification ? 'FORCED CLARIFICATION' : 'OPTIONAL CURIOSITY'}`,
        `CURRENT SPEAKER: ${params.person.userHandle}`,
        `CHAT LANGUAGE: ${params.language}`,
        `ALLOWED HANDLES: ${allowed.join(', ')}`,
        `CURRENT MESSAGE: ${params.currentMessage.slice(0, 2_000)}`,
        params.attributionIssues?.length
          ? `ATTRIBUTION PROBLEMS TO RESOLVE: ${params.attributionIssues.join(' | ')}`
          : '',
        `SCENE: topic=${params.scene.currentTopic}; intent=${params.scene.userIntent}; energy=${params.scene.energy}`,
        `SOCIAL CONTEXT:\n${params.socialContext.slice(0, 8_000) || '(none)'}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      schema: planSchema,
      temperature: forcedClarification ? 0.05 : 0.25,
      maxTokens: 600,
      ...((params.model ?? this.config.model) ? { model: params.model ?? this.config.model } : {}),
    });
    const planConfidence = result?.confidence ?? 0;
    if (!result?.ask || !result.question?.trim() || planConfidence < 0.72) return null;
    const kind = forcedClarification ? 'clarification' : result.kind;
    if (!kind) return null;
    const targetHandle = normalizeSocialHandle(result.targetHandle ?? params.person.userHandle);
    if (targetHandle !== normalizeSocialHandle(params.person.userHandle)) return null;
    const subjectHandle = normalizeSocialHandle(result.subjectHandle ?? targetHandle);
    if (!allowed.includes(subjectHandle)) return null;
    if (kind === 'curiosity' && subjectHandle !== targetHandle) return null;
    if (SENSITIVE_QUESTION_RE.test(`${result.key ?? ''} ${result.question}`)) return null;
    if (
      kind === 'curiosity' &&
      IDENTITY_CURIOSITY_RE.test(`${result.key ?? ''} ${result.question}`)
    ) {
      return null;
    }
    if (kind === 'curiosity' && (!result.facet || !result.key?.trim())) return null;
    if (kind === 'curiosity' && result.facet && result.key) {
      const slot = `${result.facet}:${result.key.trim().toLowerCase()}=`;
      if (params.socialContext.toLowerCase().includes(slot)) return null;
    }

    const now = new Date();
    const doc = await this.repo.create(
      {
        chatId: params.context.chatId,
        threadId: params.context.threadId,
        targetHandle,
        targetTelegramId: params.person.telegramId,
        subjectHandle,
        kind,
        questionText: result.question.trim().slice(0, 280),
        facet: result.facet,
        key: result.key,
        candidates: result.candidates,
        reason:
          result.reason || (forcedClarification ? 'attribution clarification' : 'social curiosity'),
        expiresAt: new Date(now.getTime() + this.config.ttlMinutes * 60_000),
      },
      now,
    );
    return { id: doc.id, kind: doc.kind, questionText: doc.questionText };
  }

  async attachMessage(questionId: string, botMessageId: number): Promise<void> {
    await this.repo.attachMessage(questionId, botMessageId);
  }

  async consumeAnswer(params: {
    person: Person;
    context: ChatContext;
    messageText: string;
    model?: string | undefined;
  }): Promise<SocialQuestionResolution | null> {
    if (!this.config.enabled || !params.messageText.trim()) return null;
    const question = await this.repo.findPendingForAnswer({
      chatId: params.context.chatId,
      threadId: params.context.threadId,
      targetHandle: normalizeSocialHandle(params.person.userHandle),
      replyToMessageId: params.context.repliedToMessageId,
    });
    if (!question) return null;

    const exactReply = params.context.repliedToMessageId === question.botMessageId;
    if (!exactReply) {
      const ageMs = Date.now() - question.createdAt.getTime();
      if (ageMs > this.config.unquotedAnswerWindowMinutes * 60_000) return null;
    }

    const result = await this.llm.jsonCompletion({
      system: ANSWER_SYSTEM,
      prompt: [
        `QUESTION KIND: ${question.kind}`,
        `QUESTION TARGET: ${question.targetHandle}`,
        `QUESTION SUBJECT: ${question.subjectHandle ?? question.targetHandle}`,
        `FACET/KEY: ${question.facet ?? 'none'} / ${question.key ?? 'none'}`,
        question.candidates.length ? `CANDIDATES: ${question.candidates.join(' | ')}` : '',
        `QUESTION: ${question.questionText}`,
        `CURRENT ANSWER from ${params.person.userHandle}: ${params.messageText.slice(0, 2_000)}`,
      ]
        .filter(Boolean)
        .join('\n'),
      schema: answerSchema,
      temperature: 0.02,
      maxTokens: 350,
      ...((params.model ?? this.config.model) ? { model: params.model ?? this.config.model } : {}),
    });
    if (!result || result.status === 'not_answer') return null;
    const answerConfidence = result.confidence ?? 0;
    if (result.status === 'declined') {
      await this.repo.resolve(question.id, 'declined', {
        answerMessageId: params.context.messageId,
        confidence: answerConfidence,
      });
      return {
        questionId: question.id,
        state: 'declined',
        context: `PENDING QUESTION RESOLVED: ${question.targetHandle} declined to answer "${question.questionText}". Acknowledge naturally; do not pressure them or ask it again this turn.`,
      };
    }

    const value = cleanValue(result.value);
    if (!value || answerConfidence < 0.68) return null;
    let observationApplied = false;
    if (question.facet && question.key && question.subjectHandle) {
      const selfAnswer = question.subjectHandle === question.targetHandle;
      const action =
        question.kind === 'clarification' || !isSetValuedFacet(question.facet)
          ? 'revise'
          : 'reinforce';
      const applied = await this.social.observeBatch(params.context.chatId, [
        {
          kind: 'facet',
          subjectHandle: question.subjectHandle,
          facet: question.facet,
          key: question.key,
          value,
          action,
          confidence: Math.max(0.75, Math.min(0.99, answerConfidence)),
          salience: question.kind === 'clarification' ? 0.85 : 0.65,
          source: selfAnswer ? 'clarified_self' : 'peer_report',
          sourceMessageId: params.context.messageId,
          authorHandle: question.targetHandle,
          observedAt: new Date(),
        },
      ]);
      observationApplied = applied.accepted > 0;
    }
    await this.repo.resolve(question.id, 'answered', {
      answerMessageId: params.context.messageId,
      resolvedValue: value,
      confidence: answerConfidence,
    });
    const provenance =
      question.subjectHandle === question.targetHandle
        ? 'direct answer from the subject'
        : 'peer report';
    return {
      questionId: question.id,
      state: 'answered',
      value,
      context: [
        'PENDING QUESTION RESOLVED (trusted turn state):',
        `You previously asked ${question.targetHandle}: "${question.questionText}"`,
        `Their answer resolved to: "${value}" (${provenance}).`,
        observationApplied
          ? `The structured social observation for ${question.subjectHandle ?? question.targetHandle} / ${question.key ?? 'this clarification'} has already been stored.`
          : 'No structured profile field was written; use the answer only as conversational clarification.',
        'Acknowledge naturally and continue. Do not ask the same question again this turn.',
      ].join('\n'),
    };
  }
}

function cleanValue(value: string | null | undefined): string | null {
  const clean = value?.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 300) return null;
  if (SENSITIVE_QUESTION_RE.test(clean)) return null;
  return clean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function socialQuestionPromptBlock(
  resolution: SocialQuestionResolution | null | undefined,
): string {
  return resolution?.context ?? '';
}

export type { SocialQuestionDoc };
