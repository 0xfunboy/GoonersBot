import { z } from 'zod';

/** Zod schema for LLM-mined memory candidates (validated by jsonCompletion). */
export const memorySubjectTypeSchema = z.enum([
  'user',
  'group',
  'relationship',
  'meme',
  'quote',
  'event',
  'running_joke',
]);

export const memoryCategorySchema = z.enum([
  'nickname',
  'role',
  'running_joke',
  'meme',
  'preference',
  'quote',
  'group_lore',
  'relationship',
  'reputation',
  'recurring_topic',
  'chat_rule',
  'style_signal',
]);

export const memoryToxicitySchema = z.enum(['clean', 'vulgar', 'nsfw', 'risky', 'blocked']);

export const memoryCandidateSchema = z.object({
  subjectType: memorySubjectTypeSchema,
  subjectHandle: z.string().nullable().optional(),
  involvedHandles: z.array(z.string()).default([]),
  category: memoryCategorySchema,
  text: z.string().min(1).max(400),
  normalizedText: z.string().min(1).max(400),
  confidence: z.number().min(0).max(1),
  salience: z.number().min(0).max(1),
  toxicity: memoryToxicitySchema,
  sourceMessageIds: z.array(z.number()).default([]),
  reason: z.string().default(''),
});

export const memoryMiningResultSchema = z.object({
  candidates: z.array(memoryCandidateSchema).default([]),
});

export type MemoryMiningResult = z.infer<typeof memoryMiningResultSchema>;
