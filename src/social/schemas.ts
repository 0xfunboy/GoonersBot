import { z } from 'zod';

export const socialEvidenceSourceSchema = z.enum([
  'self_declared',
  'clarified_self',
  'admin',
  'direct_observation',
  'repeated_behavior',
  'peer_report',
  'inferred',
  'migration',
]);

export const socialFacetKindSchema = z.enum([
  'interest',
  'preference',
  'aversion',
  'skill',
  'role',
  'communication_style',
  'goal',
  'habit',
]);

export const relationshipDimensionSchema = z.enum([
  'affinity',
  'warmth',
  'trust',
  'banter_affinity',
  'support',
  'rivalry',
  'familiarity',
]);

const base = {
  confidence: z.number().min(0).max(1),
  salience: z.number().min(0).max(1).optional(),
  source: socialEvidenceSourceSchema,
  sourceMessageId: z.number().int().nullable().optional(),
  authorHandle: z.string().max(80).nullable().optional(),
};

const facetObservationSchema = z.object({
  kind: z.literal('facet'),
  subjectHandle: z.string().min(1).max(80),
  facet: socialFacetKindSchema,
  key: z.string().min(1).max(100),
  value: z.string().max(240).nullable().optional(),
  action: z.enum(['reinforce', 'revise', 'retract']).default('reinforce'),
  ...base,
});

const identityObservationSchema = z.object({
  kind: z.literal('identity'),
  subjectHandle: z.string().min(1).max(80),
  displayName: z.string().max(120).nullable().optional(),
  alias: z.string().max(80).nullable().optional(),
  telegramId: z.number().int().nullable().optional(),
  ...base,
});

const relationshipObservationSchema = z.object({
  kind: z.literal('relationship'),
  fromHandle: z.string().min(1).max(80),
  toHandle: z.string().min(1).max(80),
  dimension: relationshipDimensionSchema,
  delta: z.number().min(-1).max(1),
  ...base,
});

const runningJokeObservationSchema = z.object({
  kind: z.literal('running_joke'),
  canonicalKey: z.string().min(1).max(100),
  label: z.string().min(1).max(180),
  targetHandles: z.array(z.string().min(1).max(80)).max(12).default([]),
  variant: z.string().max(220).nullable().optional(),
  action: z.enum(['reinforce', 'retire', 'revive']).default('reinforce'),
  ...base,
});

const chatNormObservationSchema = z.object({
  kind: z.literal('chat_norm'),
  key: z.string().min(1).max(100),
  value: z.string().max(220).nullable().optional(),
  action: z.enum(['reinforce', 'revise', 'retract']).default('reinforce'),
  ...base,
});

export const socialObservationSchema = z.discriminatedUnion('kind', [
  facetObservationSchema,
  identityObservationSchema,
  relationshipObservationSchema,
  runningJokeObservationSchema,
  chatNormObservationSchema,
]);

export const socialObservationBatchSchema = z.object({
  observations: z.array(socialObservationSchema).max(40).default([]),
});

export type SocialObservationBatch = z.infer<typeof socialObservationBatchSchema>;
