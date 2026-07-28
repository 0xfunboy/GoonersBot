import { z } from 'zod';

/**
 * Deliberately closed list of capabilities the autonomous coordinator may invoke.
 *
 * There is no shell, eval, filesystem-write or arbitrary HTTP tool here. New capabilities have
 * to be implemented and registered explicitly before the planner can select them.
 */
export const agentToolNameSchema = z.enum([
  'group_rag',
  'knowledge_rag',
  'web_search',
  'news',
  'page_scan',
  'document_read',
  'image_lookup',
  'media_prompt',
  'image_gen',
  'video_gen',
  'music',
  'link_media',
  'translate',
  'tts',
  'capability_forge',
]);

export const actionEvidenceSchema = z.object({
  source: z.string().min(1).max(2_000),
  title: z.string().min(1).max(300).optional(),
  claim: z.string().min(1).max(1_000).optional(),
});

export const actionArtifactSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'document', 'link', 'text']),
  id: z.string().min(1).max(2_000),
  mime: z.string().max(150).optional(),
  label: z.string().max(300).optional(),
});

export const actionAcceptanceSchema = z.object({
  requireOutput: z.boolean().default(true),
  minEvidence: z.number().int().min(0).max(20).default(0),
  requiredArtifactKinds: z
    .array(actionArtifactSchema.shape.kind)
    .max(6)
    .default([])
    .refine((kinds) => new Set(kinds).size === kinds.length, {
      message: 'required artifact kinds must be unique; this contract does not imply quantities',
    }),
});

export const plannedActionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/),
  tool: agentToolNameSchema,
  purpose: z.string().min(1).max(500),
  query: z.string().min(1).max(2_000).optional(),
  args: z.record(z.unknown()).default({}),
  dependsOn: z.array(z.string()).max(8).default([]),
  optional: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(900_000).default(30_000),
  acceptance: actionAcceptanceSchema.default({
    requireOutput: true,
    minEvidence: 0,
    requiredArtifactKinds: [],
  }),
});

export const finalResponseContractSchema = z.object({
  language: z.string().min(2).max(50).default('same as the user'),
  format: z.enum(['text', 'caption', 'voice', 'mixed']).default('text'),
  mustInclude: z.array(z.string().min(1).max(300)).max(10).default([]),
  tone: z.string().min(1).max(300).default('helpful, direct and group-native'),
});

export const agentActionPlanSchema = z
  .object({
    goal: z.string().min(1).max(1_000),
    actions: z.array(plannedActionSchema).max(10).default([]),
    finalResponse: finalResponseContractSchema.default({
      language: 'same as the user',
      format: 'text',
      mustInclude: [],
      tone: 'helpful, direct and group-native',
    }),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const [index, action] of plan.actions.entries()) {
      if (ids.has(action.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'id'],
          message: `duplicate action id: ${action.id}`,
        });
      }
      ids.add(action.id);
    }

    for (const [index, action] of plan.actions.entries()) {
      for (const dependency of action.dependsOn) {
        if (dependency === action.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['actions', index, 'dependsOn'],
            message: `action ${action.id} cannot depend on itself`,
          });
        } else if (!ids.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['actions', index, 'dependsOn'],
            message: `unknown dependency: ${dependency}`,
          });
        }
      }
    }

    if (hasDependencyCycle(plan.actions)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actions'],
        message: 'action dependency graph contains a cycle',
      });
    }
  });

export const composedAnswerDraftSchema = z.object({
  message: z.string().min(1).max(12_000),
  usedActionIds: z.array(z.string()).max(10).default([]),
  uncertainties: z.array(z.string().min(1).max(500)).max(10).default([]),
});

export type AgentToolName = z.infer<typeof agentToolNameSchema>;
export type ActionEvidence = z.infer<typeof actionEvidenceSchema>;
export type ActionArtifact = z.infer<typeof actionArtifactSchema>;
export type ActionAcceptance = z.infer<typeof actionAcceptanceSchema>;
export type PlannedAction = z.infer<typeof plannedActionSchema>;
export type FinalResponseContract = z.infer<typeof finalResponseContractSchema>;
export type AgentActionPlan = z.infer<typeof agentActionPlanSchema>;
export type ComposedAnswerDraft = z.infer<typeof composedAnswerDraftSchema>;

function hasDependencyCycle(actions: Array<{ id: string; dependsOn: string[] }>): boolean {
  const graph = new Map(actions.map((action) => [action.id, action.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return actions.some((action) => visit(action.id));
}
