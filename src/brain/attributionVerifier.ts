import { z } from 'zod';
import type { LLMProvider } from '../providers/llm/types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('attribution-verifier');

const attributionIssueSchema = z.object({
  subject: z.string().max(120),
  claim: z.string().max(500),
  reason: z.enum([
    'wrong_owner',
    'unsupported_biography',
    'joke_as_fact',
    'style_as_biography',
    'contradicted_by_human',
  ]),
});

const attributionDecisionSchema = z.object({
  safe: z.boolean(),
  issues: z.array(attributionIssueSchema).max(8).default([]),
  /** Same answer/tone with only unsupported personal claims removed or correctly attributed. */
  rewrite: z.string().max(6_000).optional(),
});

export type AttributionDecision = z.infer<typeof attributionDecisionSchema>;

export interface AttributionVerifierInput {
  candidate: string;
  currentHandle: string;
  currentMessage: string;
  replyToHandle?: string | null;
  replyToText?: string | null;
  recentMessages: Array<{ handle: string; text: string; isBot?: boolean }>;
  socialContext?: string;
  groupContext?: string;
  threadContext?: string;
  language: string;
  model?: string;
}

const SYSTEM = [
  'You are a strict identity/attribution verifier for a Telegram group reply.',
  'Return ONLY schema-valid JSON. Your job is not style critique; inspect personal factual claims.',
  '',
  'HARD RULES:',
  '- Every human fact/trait/action/identity belongs only to the exact person supported by evidence.',
  '- Previous BOT messages are NEVER evidence for facts about humans; they may contain hallucinations.',
  '- A current human correction/denial overrides contradictory old bot wording and blocks that claim.',
  '- SOCIAL MEMBER fields belong only to that OWNER/handle. Never transfer between members.',
  '- communication_style/content-sharing means what a person says/posts, NOT their job, nationality,',
  '  residence, appearance, family or identity of people shown in their media.',
  '- running jokes, reputation, meme/group lore and insults are NOT literal biography.',
  '- Do not infer biography from cultural references, language, food, agriculture, media or jokes.',
  '- A metaphorical insult is fine if clearly a joke; a concrete unsupported biography is not.',
  '- If evidence is ambiguous, remove the personal factual claim. Omission is better than invention.',
  '',
  'If unsafe, rewrite the candidate in the same language and roughly the same tone/value, preserving',
  'the useful answer and jokes that do not depend on the bad attribution. Introduce NO new human facts.',
].join('\n');

export class AttributionVerifier {
  constructor(private readonly llm: LLMProvider) {}

  async verify(input: AttributionVerifierInput): Promise<AttributionDecision | null> {
    if (!input.candidate.trim() || !this.llm.capabilities.chat) return null;
    try {
      const result = await this.llm.jsonCompletion({
        system: SYSTEM,
        prompt: buildPrompt(input),
        schema: attributionDecisionSchema,
        temperature: 0,
        maxTokens: 900,
        ...(input.model ? { model: input.model } : {}),
      });
      return result ? { ...result, issues: result.issues ?? [] } : null;
    } catch (error) {
      log.warn({ error }, 'attribution verification failed');
      return null;
    }
  }
}

export function shouldVerifyAttribution(input: {
  candidate: string;
  currentHandle: string;
  socialContext?: string;
  currentMessage: string;
  replyToHandle?: string | null;
}): boolean {
  const candidate = input.candidate.trim();
  if (!candidate) return false;
  // Any explicit handle or a prompt with multiple MEMBER identities deserves verification. Plain
  // names are handled by focus-only alias resolution before the context is rendered.
  const memberCount = (input.socialContext?.match(/^- MEMBER /gmu) ?? []).length;
  if (memberCount >= 2) return true;
  if (/@[A-Za-z0-9_]{3,}/u.test(candidate)) return true;
  if (input.replyToHandle && input.replyToHandle !== input.currentHandle) return true;
  // Identity-style assertions are high-cost when wrong, even in a one-person turn.
  return /(?:\bsei\b|\bsono\b|\bis\b|\bare\b|\beres\b|\bes\b|(?:^|\s)è\s|(?:^|\s)e'\s)[^.!?\n]{0,80}\b(?:sard[oa]|spagnol[oa]|sicilian[oa]|italian[oa]|frances[ea]|tedesc[oa]|farmer|contadin[oa]|agricoltor[ea]|avvocat[oa]|medic[oa]|ingegner[ea])\b/iu.test(
    candidate,
  );
}

function buildPrompt(input: AttributionVerifierInput): string {
  const recent = input.recentMessages
    .slice(-10)
    .map((message) => `${message.isBot ? 'BOT' : message.handle}: ${message.text.slice(0, 1_500)}`)
    .join('\n');
  return [
    `LANGUAGE: ${input.language}`,
    `CURRENT HUMAN: ${input.currentHandle}`,
    `CURRENT HUMAN MESSAGE: ${input.currentMessage.slice(0, 3_000)}`,
    input.replyToHandle ? `REPLY TARGET: ${input.replyToHandle}` : '',
    input.replyToText ? `REPLIED MESSAGE: ${input.replyToText.slice(0, 2_000)}` : '',
    '',
    'RECENT CHAT (BOT rows are context only, never human-fact evidence):',
    recent || '(none)',
    '',
    input.threadContext ? `THREAD CONTEXT:\n${input.threadContext.slice(0, 5_000)}` : '',
    input.socialContext ? `SOCIAL OWNER LEDGER:\n${input.socialContext.slice(0, 10_000)}` : '',
    input.groupContext ? `SUBJECT-BOUND MEMORY:\n${input.groupContext.slice(0, 6_000)}` : '',
    '',
    `CANDIDATE TO VERIFY:\n${input.candidate.slice(0, 6_000)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
