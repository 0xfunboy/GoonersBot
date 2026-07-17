import { z } from 'zod';

export const cortexIntentEnum = z.enum([
  'answer',
  'correct_claim',
  'web_lookup',
  'news_context',
  'identify_image',
  'summarize',
  'recall_group',
  'recall_knowledge',
  'banter',
  'support',
  'make_image',
  'draw_image',
  'make_video',
  'translate',
  'voice_note',
  'play_music',
  'download_media',
  'stay_quiet',
]);

export const cortexToolEnum = z.enum([
  'web_search',
  'news',
  'image_lookup',
  'group_rag',
  'knowledge_rag',
  'music',
  'link_media',
  'image_gen',
  'video_gen',
  'translate',
  'tts',
]);

export const cortexToolCallSchema = z.object({
  tool: cortexToolEnum,
  query: z.string().max(300).optional(),
  args: z.record(z.string()).optional(),
  reason: z.string().max(300),
});

export const cortexDecisionSchema = z.object({
  intents: z.array(cortexIntentEnum).min(1),
  toolCalls: z.array(cortexToolCallSchema).default([]),
  valueTarget: z.enum(['truth', 'context', 'technical_help', 'support', 'joke', 'social_glue']),
  roastBudget: z.enum(['none', 'light', 'medium', 'heavy']),
  socialRole: z.enum([
    'friend',
    'truth_checker',
    'technical_peer',
    'lorekeeper',
    'banter',
    'quiet_listener',
  ]),
  needsGrounding: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
});

export type CortexDecision = z.infer<typeof cortexDecisionSchema>;
export type CortexToolCall = z.infer<typeof cortexToolCallSchema>;
export type CortexIntent = z.infer<typeof cortexIntentEnum>;
export type CortexTool = z.infer<typeof cortexToolEnum>;
export type CortexSource = 'llm' | 'fallback';
export type SourcedCortexDecision = CortexDecision & { source: CortexSource };
