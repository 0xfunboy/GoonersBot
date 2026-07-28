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

export interface CapabilityExecution {
  handled: boolean;
  text: string;
  /** Stable identity of the durable manifest, independent from its Telegram route. */
  capabilityId?: string;
  command?: string;
  installed?: boolean;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
  model: string | null;
  sources: string[];
}
