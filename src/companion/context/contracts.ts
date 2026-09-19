import { z } from 'zod';
import type {
  ChatContext,
  IncomingMessage,
  Person,
  TranscribedMessage,
} from '../../domain/types.js';
import type { SourcedCortexDecision } from '../../brain/cortex/schema.js';
import type { SocialSignal, TurnEvaluation } from '../../brain/types.js';
import { socialSignalSchema } from '../../brain/schemas.js';
import {
  operationRequestsFromUnderstanding,
  type OperationRequest,
} from '../capabilities/dispatch.js';
import {
  BUILTIN_CAPABILITY_IDS,
  legacyProviderFor,
  operationIdForInvocation,
  runtimeCapabilityManifest,
  type BuiltinCapabilityId,
  type RuntimeCapabilitySnapshotItem,
} from '../capabilities/catalog.js';

export const TURN_CONTEXT_VERSION = 1 as const;
export const TURN_UNDERSTANDING_VERSION = 1 as const;

export const interactionKindSchema = z.enum([
  'conversation',
  'new_work',
  'continue_work',
  'amend_work',
  'status',
  'cancel',
  'pause',
  'resume',
  'clarification_answer',
  'stay_quiet',
]);
export type InteractionKind = z.infer<typeof interactionKindSchema>;

export const referentProvenanceSchema = z.enum([
  'current_message',
  'telegram_reply',
  'current_attachment',
  'reply_attachment',
  'explicit_mention',
  'transcript',
  'thread_focus',
  'visible_work',
]);

export const turnReferentSchema = z
  .object({
    id: z.string().min(1).max(160),
    kind: z.enum(['message', 'person', 'attachment', 'url', 'task', 'text']),
    label: z.string().min(1).max(500),
    provenance: referentProvenanceSchema,
    messageId: z.number().int().positive().optional(),
    telegramId: z.number().int().positive().optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type TurnReferent = z.infer<typeof turnReferentSchema>;

export const visibleWorkReferenceSchema = z
  .object({
    id: z.string().min(1).max(160),
    kind: z.enum(['anime_archive', 'local_development', 'companion_task']),
    state: z.string().min(1).max(80),
    label: z.string().min(1).max(500),
    revision: z.number().int().nonnegative().optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type VisibleWorkReference = z.infer<typeof visibleWorkReferenceSchema>;

const capabilitySnapshotSchema = z
  .object({
    id: z.enum(BUILTIN_CAPABILITY_IDS),
    version: z.literal(1),
    description: z.string(),
    readiness: z.enum([
      'installed',
      'disabled',
      'needs_configuration',
      'ready',
      'degraded',
      'unavailable',
    ]),
    reason: z.string().nullable(),
    checkedAt: z.string().datetime(),
    operations: z.array(
      z.object({
        id: z.string().min(1),
        effect: z.enum([
          'read',
          'compute',
          'generate',
          'draft',
          'write',
          'send',
          'publish',
          'delete',
        ]),
      }),
    ),
  })
  .strict();

export const turnContextSchema = z
  .object({
    version: z.literal(TURN_CONTEXT_VERSION),
    botId: z.number().int().positive(),
    updateId: z.number().int().nonnegative(),
    actor: z
      .object({
        telegramId: z.number().int().positive(),
        handle: z.string().min(1).max(80),
      })
      .strict(),
    scope: z
      .object({
        chatId: z.number().int(),
        threadId: z.number().int().optional(),
        messageId: z.number().int().positive().optional(),
        isGroup: z.boolean(),
        addressed: z.boolean(),
        isGroupAdmin: z.boolean(),
      })
      .strict(),
    originalText: z.string().max(16_000),
    transcript: z.string().max(16_000).nullable(),
    attachmentRefs: z.array(turnReferentSchema).max(20),
    replyRefs: z.array(turnReferentSchema).max(10),
    referents: z.array(turnReferentSchema).max(40),
    visibleWork: z.array(visibleWorkReferenceSchema).max(30),
    capabilitySnapshot: z.array(capabilitySnapshotSchema).max(BUILTIN_CAPABILITY_IDS.length),
    createdAt: z.string().datetime(),
  })
  .strict();
export type TurnContext = z.infer<typeof turnContextSchema>;

export const proposedOperationSchema = z
  .object({
    id: z.string().min(1).max(160),
    capabilityId: z.enum(BUILTIN_CAPABILITY_IDS),
    operationId: z.string().min(1).max(100),
    input: z
      .object({
        query: z.string().max(2_000).optional(),
        args: z.record(z.unknown()),
      })
      .strict(),
    purpose: z.string().min(1).max(500),
    expectedOutputs: z.array(z.enum(['image', 'video', 'audio', 'document', 'link', 'text'])),
    effect: z.enum(['read', 'compute', 'generate', 'draft', 'write', 'send', 'publish', 'delete']),
    referentIds: z.array(z.string().min(1).max(160)).max(20),
  })
  .strict();
export type ProposedOperation = z.infer<typeof proposedOperationSchema>;

export const turnUnderstandingSchema = z
  .object({
    version: z.literal(TURN_UNDERSTANDING_VERSION),
    origin: z.enum(['cortex', 'evaluator', 'fallback']),
    interactions: z
      .array(
        z
          .object({
            kind: interactionKindSchema,
            objectiveIds: z.array(z.string().min(1).max(160)).max(20),
            referentIds: z.array(z.string().min(1).max(160)).max(20),
          })
          .strict(),
      )
      .min(1),
    intents: z.array(z.string().min(1).max(100)).min(1).max(30),
    speechActs: z
      .array(
        z.enum([
          'request',
          'negation',
          'quotation',
          'joke',
          'correction',
          'status',
          'capability_question',
          'answer',
          'statement',
        ]),
      )
      .min(1),
    objectives: z
      .array(
        z
          .object({
            id: z.string().min(1).max(160),
            goal: z.string().min(1).max(1_000),
            operationIds: z.array(z.string().min(1).max(160)).max(20),
          })
          .strict(),
      )
      .max(30),
    proposedOperations: z.array(proposedOperationSchema).max(30),
    referents: z.array(turnReferentSchema).max(40),
    missingSlots: z.array(
      z
        .object({
          id: z.string().min(1).max(160),
          key: z.string().min(1).max(100),
          prompt: z.string().min(1).max(500),
          candidates: z.array(z.string().min(1).max(500)).max(20),
          blocksOperationIds: z.array(z.string().min(1).max(160)).max(20),
        })
        .strict(),
    ),
    grounding: z
      .object({
        required: z.boolean(),
        reasons: z.array(z.string().min(1).max(500)).max(20),
      })
      .strict(),
    socialPosture: z
      .object({
        valueTarget: z.enum([
          'truth',
          'context',
          'technical_help',
          'support',
          'joke',
          'social_glue',
        ]),
        roastBudget: z.enum(['none', 'light', 'medium', 'heavy']),
        socialRole: z.enum([
          'friend',
          'truth_checker',
          'technical_peer',
          'lorekeeper',
          'banter',
          'quiet_listener',
        ]),
        socialSignal: socialSignalSchema.optional(),
      })
      .strict(),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(1_000),
    pendingInteraction: z
      .object({
        kind: z.literal('clarification'),
        slotIds: z.array(z.string().min(1).max(160)).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TurnUnderstanding = z.infer<typeof turnUnderstandingSchema>;

export interface BuildTurnContextInput {
  botId: number;
  updateId: number;
  person: Person;
  context: ChatContext;
  message: IncomingMessage;
  /** Human-authored caption/text before transport transcript markers were appended. */
  originalText?: string;
  transcribed: TranscribedMessage;
  capabilitySnapshot: readonly RuntimeCapabilitySnapshotItem[];
  visibleWork?: readonly VisibleWorkReference[];
  now?: Date;
}

/** Build the bounded, buffer-free context exposed to semantic decision layers. */
export function buildTurnContext(input: BuildTurnContextInput): TurnContext {
  const messageId = input.context.messageId;
  const attachments: TurnReferent[] = (input.message.attachments ?? []).map(
    (attachment, index) => ({
      id: `attachment:${messageId ?? input.updateId}:${index}`,
      kind: 'attachment',
      label: `${attachment.fileName} (${attachment.mime}, ${attachment.size} bytes)`.slice(0, 500),
      provenance: attachment.source === 'reply' ? 'reply_attachment' : 'current_attachment',
      ...(attachment.source === 'reply' && input.context.repliedToMessageId
        ? { messageId: input.context.repliedToMessageId }
        : messageId
          ? { messageId }
          : {}),
      confidence: 1,
    }),
  );
  const replies: TurnReferent[] = input.context.repliedToMessageId
    ? [
        {
          id: `message:${input.context.chatId}:${input.context.repliedToMessageId}`,
          kind: 'message',
          label: (input.context.repliedToText ?? 'replied Telegram message').slice(0, 500),
          provenance: 'telegram_reply',
          messageId: input.context.repliedToMessageId,
          ...(input.context.repliedToTelegramId
            ? { telegramId: input.context.repliedToTelegramId }
            : {}),
          confidence: 1,
        },
      ]
    : [];
  const mentions: TurnReferent[] = (input.context.mentionedHandles ?? []).map((handle, index) => ({
    id: `mention:${index}:${handle.toLowerCase()}`,
    kind: 'person',
    label: handle,
    provenance: 'explicit_mention',
    confidence: 1,
  }));
  const workReferents: TurnReferent[] = (input.visibleWork ?? []).map((work) => ({
    id: `work:${work.id}`,
    kind: 'task',
    label: `${work.label} [${work.state}]`.slice(0, 500),
    provenance: 'visible_work',
    confidence: 1,
  }));
  return turnContextSchema.parse({
    version: TURN_CONTEXT_VERSION,
    botId: input.botId,
    updateId: input.updateId,
    actor: { telegramId: input.person.telegramId, handle: input.person.userHandle },
    scope: {
      chatId: input.context.chatId,
      ...(input.context.threadId !== undefined ? { threadId: input.context.threadId } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
      isGroup: input.context.isGroup,
      addressed:
        !input.context.isGroup || input.context.isBotMentioned || input.context.isReplyToBot,
      isGroupAdmin: input.context.isGroupAdmin,
    },
    originalText: (input.originalText ?? input.message.messageText).slice(0, 16_000),
    transcript: transcriptFrom(input.message.messageText, input.transcribed),
    attachmentRefs: attachments,
    replyRefs: replies,
    referents: dedupeReferents([...replies, ...attachments, ...mentions, ...workReferents]),
    visibleWork: input.visibleWork ?? [],
    capabilitySnapshot: input.capabilitySnapshot,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
}

function transcriptFrom(messageText: string, transcribed: TranscribedMessage): string | null {
  if (transcribed.voiceDescription?.trim())
    return transcribed.voiceDescription.trim().slice(0, 16_000);
  const matches = [
    ...messageText.matchAll(/\[(?:CURRENT|REPLIED) [^\]]+ TRANSCRIPT\]:\s*([^\n]+)/giu),
  ]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return matches.length > 0 ? matches.join('\n').slice(0, 16_000) : null;
}

export function turnUnderstandingFromCortex(
  decision: SourcedCortexDecision,
  context: TurnContext,
  contextualCalls: readonly ContextualCapabilityCall[] = [],
): TurnUnderstanding {
  const operations = [
    ...contextualCalls,
    ...decision.toolCalls.map((call) => ({
      capabilityId: call.tool,
      query: call.query,
      args: call.args ?? {},
      reason: call.reason,
    })),
  ].map((call, index) =>
    operationFromCall(call.capabilityId, call.query, call.args ?? {}, call.reason, index, context),
  );
  return assembleUnderstanding({
    origin: decision.source === 'llm' ? 'cortex' : 'fallback',
    intents: decision.intents,
    explicitInteractions: decision.intents.flatMap(intentInteraction),
    operations,
    context,
    needsGrounding: decision.needsGrounding,
    groundingReasons: decision.needsGrounding ? [decision.reason] : [],
    valueTarget: decision.valueTarget,
    roastBudget: decision.roastBudget,
    socialRole: decision.socialRole,
    confidence: decision.confidence,
    reason: decision.reason,
  });
}

export function turnUnderstandingFromEvaluation(
  evaluation: TurnEvaluation,
  context: TurnContext,
  contextualCalls: readonly ContextualCapabilityCall[] = [],
): TurnUnderstanding {
  const calls = [
    ...contextualCalls,
    ...(evaluation.toolCalls ?? []).map((call) => ({
      capabilityId: call.tool,
      query: call.query,
      args: call.args,
      reason: call.reason ?? evaluation.reason,
    })),
    ...evaluation.providerRequests
      .filter(
        (provider) =>
          !(evaluation.toolCalls ?? []).some((call) => legacyProviderFor(call.tool) === provider),
      )
      .map((provider) => {
        const capabilityId = capabilityForLegacyProvider(provider);
        return {
          capabilityId,
          query: queryForEvaluation(capabilityId, evaluation, context),
          args: argsForEvaluation(capabilityId, evaluation),
          reason: evaluation.reason,
        };
      }),
  ].map((call, index) =>
    operationFromCall(call.capabilityId, call.query, call.args ?? {}, call.reason, index, context),
  );
  return assembleUnderstanding({
    origin: 'evaluator',
    intents: [evaluation.action],
    explicitInteractions:
      evaluation.interactions ?? (evaluation.action === 'stay_quiet' ? ['stay_quiet'] : []),
    operations: calls,
    context,
    needsGrounding:
      evaluation.providerRequests.includes('web_search') ||
      evaluation.providerRequests.includes('page_scan') ||
      evaluation.providerRequests.includes('news'),
    groundingReasons: evaluation.providerRequests.includes('web_search') ? [evaluation.reason] : [],
    valueTarget: evaluation.valueTarget,
    roastBudget: evaluation.roastBudget,
    socialRole: evaluation.socialRole,
    socialSignal: evaluation.socialSignal,
    confidence: evaluation.confidence,
    reason: evaluation.reason,
  });
}

export interface ContextualCapabilityCall {
  capabilityId: BuiltinCapabilityId;
  query?: string;
  args?: Record<string, unknown>;
  reason: string;
}

export function requestedActionsFromUnderstanding(understanding: TurnUnderstanding): Array<{
  tool: BuiltinCapabilityId;
  query?: string;
  args?: Record<string, unknown>;
  reason: string;
  operationRequest: OperationRequest;
}> {
  return operationRequestsFromUnderstanding(understanding).map((operation) => ({
    tool: operation.capabilityId,
    ...(operation.input.query ? { query: operation.input.query } : {}),
    ...(Object.keys(operation.input.args).length ? { args: operation.input.args } : {}),
    reason: operation.purpose,
    operationRequest: operation,
  }));
}

interface AssembleInput {
  origin: TurnUnderstanding['origin'];
  intents: readonly string[];
  explicitInteractions: readonly InteractionKind[];
  operations: ProposedOperation[];
  context: TurnContext;
  needsGrounding: boolean;
  groundingReasons: string[];
  valueTarget: TurnEvaluation['valueTarget'];
  roastBudget: TurnEvaluation['roastBudget'];
  socialRole: TurnEvaluation['socialRole'];
  socialSignal?: SocialSignal;
  confidence: number;
  reason: string;
}

function assembleUnderstanding(input: AssembleInput): TurnUnderstanding {
  const objectives = input.operations.map((operation, index) => ({
    id: `objective:${index + 1}`,
    goal: operation.purpose,
    operationIds: [operation.id],
  }));
  const operationReferents = input.operations.flatMap((operation) => operation.referentIds);
  const visibleWorkReferents = input.context.referents
    .filter((referent) => referent.provenance === 'visible_work')
    .map((referent) => referent.id);
  const objectiveIds = objectives.map((objective) => objective.id);
  const explicit = [...new Set(input.explicitInteractions)];
  const hasControl = explicit.some((kind) =>
    ['continue_work', 'amend_work', 'status', 'cancel', 'pause', 'resume'].includes(kind),
  );
  const operational = input.operations.some((operation) => isWorkOperation(operation));
  let interactions = [...explicit];
  if (input.operations.length > 0 && !hasControl) {
    interactions.push(operational ? 'new_work' : 'conversation');
  } else if (input.operations.length === 0 && interactions.length === 0) {
    interactions.push('conversation');
  }
  // A passive silence suggestion may coexist in raw model JSON, but it can never erase an
  // independently valid operation from the same turn.
  if (input.operations.length > 0)
    interactions = interactions.filter((kind) => kind !== 'stay_quiet');
  interactions = [...new Set(interactions)];
  const missingSlots = missingSlotsFor(input.operations, input.context);
  const draft = {
    version: TURN_UNDERSTANDING_VERSION,
    origin: input.origin,
    interactions: interactions.map((kind) => ({
      kind,
      objectiveIds,
      referentIds: [
        ...new Set(isControlInteraction(kind) ? visibleWorkReferents : operationReferents),
      ],
    })),
    intents: [...new Set(input.intents.length ? input.intents : ['answer'])],
    speechActs: speechActsFor(input.intents, input.operations),
    objectives,
    proposedOperations: input.operations,
    referents: input.context.referents,
    missingSlots,
    grounding: { required: input.needsGrounding, reasons: input.groundingReasons },
    socialPosture: {
      valueTarget: input.valueTarget,
      roastBudget: input.roastBudget,
      socialRole: input.socialRole,
      ...(input.socialSignal ? { socialSignal: input.socialSignal } : {}),
    },
    confidence: input.confidence,
    reason: input.reason.slice(0, 1_000),
    ...(missingSlots.length
      ? {
          pendingInteraction: {
            kind: 'clarification' as const,
            slotIds: missingSlots.map((slot) => slot.id),
          },
        }
      : {}),
  };
  return turnUnderstandingSchema.parse(draft);
}

function speechActsFor(
  intents: readonly string[],
  operations: readonly ProposedOperation[],
): TurnUnderstanding['speechActs'] {
  const acts: TurnUnderstanding['speechActs'] = [];
  if (operations.length > 0) acts.push('request');
  if (intents.includes('negation')) acts.push('negation');
  if (intents.includes('quotation')) acts.push('quotation');
  if (intents.includes('banter')) acts.push('joke');
  if (intents.includes('correct_claim') || intents.includes('disagree')) acts.push('correction');
  if (intents.includes('status')) acts.push('status');
  if (intents.includes('capability_question')) acts.push('capability_question');
  if (intents.includes('clarification_answer')) acts.push('answer');
  if (acts.length === 0) acts.push('statement');
  return [...new Set(acts)];
}

function isControlInteraction(kind: InteractionKind): boolean {
  return ['continue_work', 'amend_work', 'status', 'cancel', 'pause', 'resume'].includes(kind);
}

function operationFromCall(
  capabilityId: BuiltinCapabilityId,
  query: string | undefined,
  args: Record<string, unknown>,
  reason: string,
  index: number,
  context: TurnContext,
): ProposedOperation {
  const manifest = runtimeCapabilityManifest(capabilityId);
  const operationId = operationIdFor(capabilityId, args);
  const operation =
    manifest.operations.find((candidate) => candidate.id === operationId) ?? manifest.operations[0];
  if (!operation) throw new Error(`Capability ${capabilityId} has no operations`);
  return proposedOperationSchema.parse({
    id: `operation:${index + 1}:${capabilityId}:${operationId}`,
    capabilityId,
    operationId,
    input: { ...(query?.trim() ? { query: query.trim() } : {}), args },
    purpose: reason.trim() || operation.description,
    expectedOutputs: [...manifest.outputKinds],
    effect: operation.effect,
    referentIds: relevantReferentIds(capabilityId, context),
  });
}

function operationIdFor(capabilityId: BuiltinCapabilityId, args: Record<string, unknown>): string {
  return operationIdForInvocation(capabilityId, args) ?? 'unknown';
}

function intentInteraction(intent: string): InteractionKind[] {
  if (intent === 'stay_quiet') return ['stay_quiet'];
  if (intent === 'continue_work') return ['continue_work'];
  if (intent === 'amend_work') return ['amend_work'];
  if (intent === 'status') return ['status'];
  if (intent === 'cancel') return ['cancel'];
  if (intent === 'pause') return ['pause'];
  if (intent === 'resume') return ['resume'];
  if (intent === 'clarification_answer') return ['clarification_answer'];
  return [];
}

function isWorkOperation(operation: ProposedOperation): boolean {
  return (
    operation.effect !== 'read' ||
    runtimeCapabilityManifest(operation.capabilityId).terminal ||
    operation.capabilityId === 'document_read'
  );
}

function relevantReferentIds(capabilityId: BuiltinCapabilityId, context: TurnContext): string[] {
  if (capabilityId === 'document_read') {
    return context.attachmentRefs.map((referent) => referent.id);
  }
  if (capabilityId === 'image_lookup') {
    return context.referents
      .filter((referent) => referent.kind === 'attachment' || referent.kind === 'message')
      .map((referent) => referent.id);
  }
  if (['anime_archive', 'link_media', 'tts', 'translate'].includes(capabilityId)) {
    return context.replyRefs.map((referent) => referent.id);
  }
  return [];
}

function missingSlotsFor(
  operations: readonly ProposedOperation[],
  context: TurnContext,
): TurnUnderstanding['missingSlots'] {
  const missing: TurnUnderstanding['missingSlots'] = [];
  for (const operation of operations) {
    if (operation.capabilityId === 'workflow' && operation.input.args['intent'] === 'create') {
      const delay = Number(operation.input.args['delayMinutes']);
      const at = operation.input.args['runAt'];
      const monitor = operation.input.args['kind'] === 'monitor';
      const weekly =
        Boolean(operation.input.args['weekdays']) && operation.input.args['hour'] !== undefined;
      if (
        !monitor &&
        !weekly &&
        !(Number.isFinite(delay) && delay > 0) &&
        !(typeof at === 'string' && at.trim())
      )
        missing.push(slot('schedule_time', 'Quando vuoi che te lo ricordi?', operation.id));
      if (
        (weekly ||
          (typeof at === 'string' && at.trim()) ||
          operation.input.args['quietStartHour'] !== undefined) &&
        !operation.input.args['timezone']
      )
        missing.push(slot('timezone', 'Quale fuso orario devo usare?', operation.id));
    }
    if (
      operation.capabilityId === 'page_scan' &&
      !operation.input.query &&
      typeof operation.input.args['url'] !== 'string' &&
      !operations.some((candidate) => candidate.capabilityId === 'web_search')
    ) {
      missing.push(slot('public_url', 'Quale pagina pubblica devo analizzare?', operation.id));
    }
    if (
      operation.capabilityId === 'music' &&
      !operation.input.query &&
      typeof operation.input.args['track'] !== 'string'
    ) {
      missing.push(slot('track', 'Quale brano vuoi?', operation.id));
    }
    if (
      operation.capabilityId === 'document_read' &&
      operation.input.args['hostDocumentContext'] !== true &&
      !context.attachmentRefs.some((referent) => referent.kind === 'attachment')
    ) {
      missing.push(slot('document', 'Quale documento devo leggere?', operation.id));
    }
  }
  return missing;
}

function slot(
  key: string,
  prompt: string,
  operationId: string,
): TurnUnderstanding['missingSlots'][number] {
  return {
    id: `slot:${operationId}:${key}`,
    key,
    prompt,
    candidates: [],
    blocksOperationIds: [operationId],
  };
}

function capabilityForLegacyProvider(
  provider: TurnEvaluation['providerRequests'][number],
): BuiltinCapabilityId {
  const id = BUILTIN_CAPABILITY_IDS.find((candidate) => legacyProviderFor(candidate) === provider);
  if (!id) throw new Error(`No runtime capability maps legacy provider ${provider}`);
  return id;
}

function queryForEvaluation(
  capabilityId: BuiltinCapabilityId,
  evaluation: TurnEvaluation,
  context: TurnContext,
): string | undefined {
  if (capabilityId === 'web_search' || capabilityId === 'page_scan') {
    return evaluation.searchQuery ?? context.originalText;
  }
  if (capabilityId === 'music') return evaluation.musicQuery;
  if (capabilityId === 'link_media') return evaluation.mediaUrl ?? evaluation.mediaQuery;
  if (capabilityId === 'image_gen') return evaluation.imagePrompt;
  if (capabilityId === 'video_gen') return evaluation.videoPrompt;
  if (capabilityId === 'translate') return evaluation.sourceText;
  if (capabilityId === 'tts') return evaluation.voiceText;
  return undefined;
}

function argsForEvaluation(
  capabilityId: BuiltinCapabilityId,
  evaluation: TurnEvaluation,
): Record<string, unknown> {
  if (capabilityId === 'link_media' && evaluation.mediaUrl) return { url: evaluation.mediaUrl };
  if (capabilityId === 'translate' && evaluation.targetLanguage) {
    return { targetLanguage: evaluation.targetLanguage };
  }
  if (capabilityId === 'tts' && evaluation.voiceText) return { voiceText: evaluation.voiceText };
  return {};
}

function dedupeReferents(items: TurnReferent[]): TurnReferent[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
