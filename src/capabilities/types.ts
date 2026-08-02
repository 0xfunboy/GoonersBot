import { z } from 'zod';

export const capabilityManifestSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9_-]{2,48}$/),
  command: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
  description: z.string().min(8).max(240),
  kind: z.literal('research_recipe'),
  searchQueryTemplate: z.string().min(3).max(300),
  answerInstruction: z.string().min(8).max(800),
  createdFrom: z.string().min(3).max(500),
  createdAt: z.string().datetime(),
  enabled: z.boolean(),
});

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

export const capabilityPlanSchema = z.object({
  classification: z.enum([
    'research_recipe',
    'external_integration',
    'local_automation',
    'not_a_capability_gap',
  ]),
  id: z.string().regex(/^[a-z][a-z0-9_-]{2,48}$/),
  command: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
  description: z.string().min(8).max(240),
  searchQueryTemplate: z.string().max(300).default('{input}'),
  answerInstruction: z.string().max(800).default('Answer the request precisely from the sources.'),
  requiredConfig: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/))
    .max(12)
    .default([]),
  reason: z.string().min(3).max(500),
});

export type CapabilityPlan = z.infer<typeof capabilityPlanSchema>;

export type CapabilityExecutionStatus =
  | 'executed'
  | 'installed'
  | 'reused'
  | 'proposal_saved'
  | 'awaiting_approval'
  | 'not_applicable'
  | 'blocked_dependency'
  | 'validation_failed'
  | 'planning_failed';

export interface CapabilityDiagnostic {
  code:
    | 'forge_disabled'
    | 'chat_model_unavailable'
    | 'web_grounding_unavailable'
    | 'web_grounding_no_results'
    | 'auto_install_disabled'
    | 'external_integration_required'
    | 'local_automation_required'
    | 'planner_unavailable'
    | 'smoke_test_failed';
  /** Configuration/development requirements, never credentials or their values. */
  requirements: string[];
  /** False when requirements came only from the model-authored design and were not probed. */
  requirementsVerified: boolean;
  retryable: boolean;
}

export interface CapabilityExecution {
  handled: boolean;
  text: string;
  /** Explicit lifecycle outcome; `installed` alone cannot distinguish reuse from failed execution. */
  status: CapabilityExecutionStatus;
  diagnostic?: CapabilityDiagnostic;
  /** Stable identity of the durable manifest, independent from its Telegram route. */
  capabilityId?: string;
  command?: string;
  installed?: boolean;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
  model: string | null;
  sources: string[];
}

/**
 * True only when the requested capability actually produced a usable result. A durable manifest
 * may still be present on blocked executions, so the legacy `installed` flag is not sufficient.
 */
export function isVerifiedCapabilityExecution(execution: CapabilityExecution): boolean {
  return (
    execution.handled &&
    (execution.status === 'executed' ||
      execution.status === 'installed' ||
      execution.status === 'reused')
  );
}

/** True only for a capability published by the current acquisition, never for reuse or failure. */
export function isNewCapabilityInstallation(execution: CapabilityExecution): boolean {
  return (
    isVerifiedCapabilityExecution(execution) &&
    execution.status === 'installed' &&
    Boolean(execution.capabilityId) &&
    Boolean(execution.command)
  );
}

/** True when an already-durable capability was successfully exercised for this request. */
export function isVerifiedCapabilityReuse(execution: CapabilityExecution): boolean {
  return (
    isVerifiedCapabilityExecution(execution) &&
    execution.status === 'reused' &&
    Boolean(execution.capabilityId) &&
    Boolean(execution.command)
  );
}
