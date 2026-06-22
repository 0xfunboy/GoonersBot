import { z } from 'zod';

/** Zod schemas for LLM-produced brain JSON (scene, plan, ranker). */

export const sceneSchema = z.object({
  currentTopic: z.string().default(''),
  energy: z.enum(['dead', 'low', 'medium', 'high', 'chaotic']).default('medium'),
  humorStyle: z
    .array(
      z.enum([
        'roast',
        'self_deprecation',
        'nsfw',
        'absurd',
        'dry',
        'degen',
        'lore_callback',
        'argument',
      ]),
    )
    .default([]),
  activeUsers: z.array(z.string()).default([]),
  mentionedUsers: z.array(z.string()).default([]),
  openThreads: z.array(z.string()).default([]),
  botIsBeingAddressed: z.boolean().default(false),
  botIsBeingCriticized: z.boolean().default(false),
  userIntent: z
    .enum([
      'ask_bot',
      'insult_bot',
      'continue_banter',
      'request_summary',
      'request_memory',
      'command_like',
      'random_chatter',
      'dangerous_request',
      'unknown',
    ])
    .default('unknown'),
  shouldUseMemory: z.boolean().default(false),
  shouldBeDefensive: z.boolean().default(false),
  bestAngle: z.string().default(''),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
});

export const planSchema = z.object({
  replyIntent: z
    .enum([
      'answer_question',
      'roast_user',
      'roast_self',
      'summarize',
      'hype',
      'lore_callback',
      'ignore_memory_and_answer_directly',
      'deadpan',
      'chaos_reply',
    ])
    .default('ignore_memory_and_answer_directly'),
  action: z
    .enum([
      'answer',
      'challenge_claim',
      'ground_search',
      'bring_news_context',
      'download_music',
      'summarize_thread',
      'use_group_lore',
      'banter_only',
      'stay_quiet',
    ])
    .default('answer'),
  valueTarget: z
    .enum(['truth', 'context', 'joke', 'support', 'technical_help', 'social_glue'])
    .default('truth'),
  roastBudget: z.enum(['none', 'light', 'medium', 'heavy']).default('light'),
  socialRole: z
    .enum(['friend', 'truth_checker', 'banter', 'lorekeeper', 'quiet_listener', 'technical_peer'])
    .default('friend'),
  mustBringValue: z.boolean().default(true),
  targetHandles: z.array(z.string()).default([]),
  tone: z.string().default('group-native'),
  maxLines: z.number().int().min(1).max(8).default(2),
  memoryUseMode: z.enum(['none', 'implicit_style', 'explicit_callback']).default('none'),
  memoryIdsToUse: z.array(z.string()).default([]),
  noveltyInstruction: z.string().default(''),
  mustAnswer: z.boolean().default(true),
});

export type ScenePayload = z.infer<typeof sceneSchema>;
export type PlanPayload = z.infer<typeof planSchema>;

export const rankerSchema = z.object({
  best: z.number().int().min(0),
  reason: z.string().default(''),
});

export const turnEvaluationSchema = z.object({
  shouldAct: z.boolean().default(true),
  action: z
    .enum([
      'answer',
      'challenge_claim',
      'ground_search',
      'bring_news_context',
      'download_music',
      'summarize_thread',
      'use_group_lore',
      'banter_only',
      'stay_quiet',
    ])
    .default('answer'),
  providerRequests: z
    .array(z.enum(['group_rag', 'knowledge_rag', 'web_search', 'news', 'image_lookup', 'music']))
    .default([]),
  valueTarget: z
    .enum(['truth', 'context', 'joke', 'support', 'technical_help', 'social_glue'])
    .default('truth'),
  roastBudget: z.enum(['none', 'light', 'medium', 'heavy']).default('light'),
  socialRole: z
    .enum(['friend', 'truth_checker', 'banter', 'lorekeeper', 'quiet_listener', 'technical_peer'])
    .default('friend'),
  confidence: z.number().min(0).max(1).default(0.5),
  reason: z.string().default(''),
  searchQuery: z.string().optional(),
  musicQuery: z.string().optional(),
});

export type TurnEvaluationPayload = z.infer<typeof turnEvaluationSchema>;
