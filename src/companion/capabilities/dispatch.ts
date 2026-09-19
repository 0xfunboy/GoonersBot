import { z } from 'zod';
import {
  BUILTIN_CAPABILITY_IDS,
  runtimeCapabilityManifest,
  validateCapabilityInvocation,
} from './catalog.js';
import type { ProposedOperation, TurnUnderstanding } from '../context/contracts.js';
import type { AgentExecutionReport, ToolExecutionOutput } from '../../agent/types.js';

export const dependencyBindingSchema = z
  .object({
    fromOperationId: z.string().min(1).max(160),
    select: z.enum(['evidence_url', 'text', 'media_prompt', 'context']),
    target: z.enum(['args.url', 'args.sourceText', 'media_prompt', 'context']),
  })
  .strict();

/** Host-compiled request. inputProblems remain visible and prohibit execution. */
export const operationRequestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(160),
    capabilityId: z.enum(BUILTIN_CAPABILITY_IDS),
    capabilityVersion: z.literal(1),
    operationId: z.string().min(1).max(100),
    input: z
      .object({ query: z.string().max(2_000).optional(), args: z.record(z.unknown()) })
      .strict(),
    purpose: z.string().min(1).max(500),
    expectedOutputs: z
      .array(z.enum(['image', 'video', 'audio', 'document', 'link', 'text']))
      .max(6),
    dependencyBindings: z.array(dependencyBindingSchema).max(8),
    effect: z.enum(['read', 'compute', 'generate', 'draft', 'write', 'send', 'publish', 'delete']),
    effectKey: z.string().min(1).max(500).optional(),
    inputProblems: z.array(z.string().max(1_000)).max(30),
  })
  .strict();
export type OperationRequest = z.infer<typeof operationRequestSchema>;

export const unmetOperationSchema = z
  .object({
    id: z.string().min(1).max(160),
    capabilityId: z.enum(BUILTIN_CAPABILITY_IDS),
    purpose: z.string().min(1).max(500),
    code: z.enum(['unavailable', 'invalid_input', 'budget_exceeded', 'dependency_unavailable']),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export const observationBundleSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().min(1).max(160),
    capabilityId: z.enum(BUILTIN_CAPABILITY_IDS),
    status: z.enum(['succeeded', 'failed', 'timed_out', 'skipped']),
    summary: z.string().max(12_000),
    observedAt: z.string().datetime(),
    evidence: z
      .array(
        z
          .object({
            source: z.string().min(1).max(2_000),
            title: z.string().max(300).optional(),
            excerpt: z.string().max(1_000).optional(),
          })
          .strict(),
      )
      .max(20),
    artifacts: z
      .array(
        z
          .object({
            kind: z.enum(['image', 'video', 'audio', 'document', 'link', 'text']),
            id: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .max(20),
    uncertainties: z.array(z.string().max(2_000)).max(30),
    errors: z
      .array(z.object({ code: z.string().max(100), message: z.string().max(2_000) }).strict())
      .max(30),
  })
  .strict();
export type ObservationBundle = z.infer<typeof observationBundleSchema>;

export function operationRequestsFromUnderstanding(
  understanding: TurnUnderstanding,
): OperationRequest[] {
  return compileOperationRequests(understanding.proposedOperations);
}

export function compileOperationRequests(
  proposals: readonly ProposedOperation[],
): OperationRequest[] {
  const previous = new Map<string, string>();
  const preceding: ProposedOperation[] = [];
  return proposals.map((proposal) => {
    const manifest = runtimeCapabilityManifest(proposal.capabilityId);
    const operation = manifest.operations.find((item) => item.id === proposal.operationId);
    const dependencyBindings: OperationRequest['dependencyBindings'] = [];
    const bind = (
      source: string | undefined,
      select: 'text' | 'evidence_url' | 'media_prompt',
      target: 'args.url' | 'args.sourceText' | 'media_prompt',
    ): void => {
      if (source) dependencyBindings.push({ fromOperationId: source, select, target });
    };
    if (proposal.capabilityId === 'page_scan' && !proposal.input.args['url']) {
      bind(previous.get('web_search'), 'evidence_url', 'args.url');
    }
    if (proposal.capabilityId === 'translate' && !proposal.input.args['sourceText']) {
      bind(previous.get('document_read'), 'text', 'args.sourceText');
    }
    if (
      proposal.capabilityId === 'tts' &&
      !proposal.input.args['sourceText'] &&
      !proposal.input.args['voiceText']
    ) {
      bind(previous.get('translate') ?? previous.get('document_read'), 'text', 'args.sourceText');
    }
    if (proposal.capabilityId === 'image_gen' || proposal.capabilityId === 'video_gen') {
      bind(previous.get('media_prompt'), 'media_prompt', 'media_prompt');
    }
    if (proposal.capabilityId === 'document_create') {
      dependencyBindings.push(
        ...preceding
          .filter(
            (item) =>
              ['read', 'compute'].includes(item.effect) && item.capabilityId !== 'media_prompt',
          )
          .slice(-8)
          .map((item) => ({
            fromOperationId: item.id,
            select: 'context' as const,
            target: 'context' as const,
          })),
      );
    }
    const inputProblems = validateCapabilityInvocation(proposal.capabilityId, {
      ...proposal.input,
      dependsOn: dependencyBindings.map((binding) => binding.fromOperationId),
    });
    if (!operation) inputProblems.push(`Unknown operation: ${proposal.operationId}`);
    previous.set(proposal.capabilityId, proposal.id);
    preceding.push(proposal);
    return operationRequestSchema.parse({
      version: 1,
      id: proposal.id,
      capabilityId: proposal.capabilityId,
      capabilityVersion: manifest.version,
      operationId: proposal.operationId,
      input: proposal.input,
      purpose: proposal.purpose,
      expectedOutputs: proposal.expectedOutputs,
      dependencyBindings,
      effect: operation?.effect ?? proposal.effect,
      inputProblems,
    });
  });
}

/** Shared with ordinary context providers; contains references, never binary payloads. */
export function providerObservation(input: {
  operationId: string;
  capabilityId: OperationRequest['capabilityId'];
  output?: ToolExecutionOutput;
  status: ObservationBundle['status'];
  observedAt?: Date;
  error?: string;
  errorCode?: string;
  uncertainties?: string[];
}): ObservationBundle {
  return observationBundleSchema.parse({
    version: 1,
    operationId: input.operationId,
    capabilityId: input.capabilityId,
    status: input.status,
    summary: (input.output?.summary ?? '').slice(0, 12_000),
    observedAt: (input.observedAt ?? new Date()).toISOString(),
    evidence: (input.output?.evidence ?? []).slice(0, 20).map((item) => ({
      source: item.source.slice(0, 2_000),
      ...(item.title ? { title: item.title.slice(0, 300) } : {}),
      ...(item.claim ? { excerpt: item.claim.slice(0, 1_000) } : {}),
    })),
    artifacts: (input.output?.artifacts ?? []).slice(0, 20).map(({ kind, id }) => ({ kind, id })),
    uncertainties: (input.uncertainties ?? []).slice(0, 30).map((item) => item.slice(0, 2_000)),
    errors: input.error
      ? [{ code: input.errorCode ?? input.status, message: input.error.slice(0, 2_000) }]
      : [],
  });
}

export function executionObservations(report: AgentExecutionReport): ObservationBundle[] {
  return [
    ...report.results.map((result) =>
      providerObservation({
        operationId: result.action.requestId ?? result.action.id,
        capabilityId: result.action.tool,
        status: result.status,
        output: result.output,
        observedAt: result.startedAt,
        error: result.error,
        uncertainties: result.verificationProblems,
      }),
    ),
    ...(report.plan.unmetOperations ?? []).map((unmet) =>
      providerObservation({
        operationId: unmet.id,
        capabilityId: unmet.capabilityId,
        status: 'skipped',
        error: unmet.reason,
        errorCode: unmet.code,
      }),
    ),
  ];
}
