import type { LLMProvider, ChatRequest, ChatResult } from '../providers/llm/types.js';
import type { Person, TranscribedMessage } from '../domain/types.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import type { RetrievedMemory } from '../memory/types.js';
import {
  buildGeneratorSystem,
  buildGeneratorUserPrompt,
  buildRegenerationNote,
} from '../prompts/generator.js';
import type { ReplyPlan, SceneAnalysis, StyleProfile } from './types.js';
import type { StyleEngine } from './styleEngine.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('response-generator');

const EMPTY_REPLY_RETRIES = 2;

export interface ResponseGeneratorConfig {
  model: string | undefined;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  candidateCount: number;
  maxReplyChars: number;
}

export interface GenerateReplyInput {
  botUsername: string;
  chatName: string | undefined;
  language: string;
  modeName: string;
  modeDescription: string;
  nsfwEnabled: boolean;
  scene: SceneAnalysis;
  plan: ReplyPlan;
  style: StyleProfile;
  history: StoredMessage[];
  currentUser: Person;
  currentMessage: TranscribedMessage;
  retrievedMemories: RetrievedMemory[];
  botLabel: string;
  /** per-turn model override (from the NSFW router); falls back to cfg.model */
  model?: string | undefined;
  /** optional web/image grounding block (fresh facts) injected into the prompt */
  grounding?: string | undefined;
  /** who to address (the current speaker) */
  addressee?: string | undefined;
  /** attached media to react to, with who posted it */
  media?: { kind: 'photo' | 'video'; description: string; poster: string } | undefined;
  /** live thread/entity attribution block */
  threadContext?: string | undefined;
  /** per-user hostility directive (escalation system) */
  hostility?: string | undefined;
  /** on-demand knowledge block (RAG) */
  knowledge?: string | undefined;
}

export interface GeneratedCandidates {
  candidates: string[];
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
  model: string | null;
  system: string;
  userPrompt: string;
}

export class ResponseGenerator {
  constructor(
    private readonly llm: LLMProvider,
    private readonly styleEngine: StyleEngine,
    private readonly cfg: ResponseGeneratorConfig,
  ) {}

  private maxTokens(): number {
    // Generous cap: reasoning models (e.g. gpt-oss) spend tokens on a hidden reasoning channel
    // before the visible reply, so a tight cap yields empty content. The prompt enforces brevity.
    return Math.max(900, this.cfg.maxReplyChars * 2);
  }

  async generate(input: GenerateReplyInput): Promise<GeneratedCandidates> {
    const system = buildGeneratorSystem({
      botUsername: input.botUsername,
      chatName: input.chatName,
      language: input.language,
      modeName: input.modeName,
      modeDescription: input.modeDescription,
      nsfwEnabled: input.nsfwEnabled,
    });
    const userPrompt = buildGeneratorUserPrompt({
      scene: input.scene,
      plan: input.plan,
      styleDescription: this.styleEngine.describe(input.style),
      history: input.history,
      memories: input.retrievedMemories,
      bannedPhrases: input.plan.bannedPhrases,
      person: input.currentUser,
      message: input.currentMessage,
      botLabel: input.botLabel,
      ...(input.grounding ? { grounding: input.grounding } : {}),
      ...(input.addressee ? { addressee: input.addressee } : {}),
      ...(input.media ? { media: input.media } : {}),
      ...(input.threadContext ? { threadContext: input.threadContext } : {}),
      ...(input.hostility ? { hostility: input.hostility } : {}),
      ...(input.knowledge ? { knowledge: input.knowledge } : {}),
    });

    const n = Math.max(1, this.cfg.candidateCount);
    const model = input.model ?? this.cfg.model;
    const results = await Promise.allSettled(
      Array.from({ length: n }, () => this.callOne(system, userPrompt, model)),
    );
    const ok = results
      .filter((r): r is PromiseFulfilledResult<ChatResult> => r.status === 'fulfilled')
      .map((r) => r.value);
    return this.aggregate(ok, system, userPrompt);
  }

  /** Regenerate candidates with a stricter anti-repetition note appended. */
  async regenerate(params: {
    system: string;
    userPrompt: string;
    model: string | undefined;
    bannedPhrases: string[];
    overusedMemory: string[];
    count?: number;
  }): Promise<GeneratedCandidates> {
    const note = buildRegenerationNote(params.bannedPhrases, params.overusedMemory);
    const augmented = `${params.userPrompt}\n\n${note}`;
    const results = await Promise.allSettled(
      Array.from({ length: Math.max(1, params.count ?? 1) }, () =>
        this.callOne(params.system, augmented, params.model),
      ),
    );
    const ok = results
      .filter((r): r is PromiseFulfilledResult<ChatResult> => r.status === 'fulfilled')
      .map((r) => r.value);
    return this.aggregate(ok, params.system, augmented);
  }

  private async callOne(
    system: string,
    userPrompt: string,
    model: string | undefined,
  ): Promise<ChatResult> {
    const first = await this.chatCompletionWithEmptyRetry({
      system,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: this.cfg.temperature,
      topP: this.cfg.topP,
      frequencyPenalty: this.cfg.frequencyPenalty,
      presencePenalty: this.cfg.presencePenalty,
      maxTokens: this.maxTokens(),
      ...(model ? { model } : {}),
    }, 'reply candidate', model);
    if (first.finishReason !== 'length') return first;

    // A partial message is worse than a fresh one in a group chat. Re-write it once
    // only when the upstream explicitly says it stopped for its output limit.
    const repair = await this.chatCompletionWithEmptyRetry({
      system,
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: first.text },
        {
          role: 'user',
          content:
            'Your previous candidate was cut off by the output limit. Rewrite it as one complete, natural Telegram reply. ' +
            'Keep the same point and tone, finish the thought, and never mention the interruption or this instruction.',
        },
      ],
      temperature: this.cfg.temperature,
      topP: this.cfg.topP,
      frequencyPenalty: this.cfg.frequencyPenalty,
      presencePenalty: this.cfg.presencePenalty,
      maxTokens: this.maxTokens(),
      ...(model ? { model } : {}),
    }, 'reply repair', model);
    return {
      ...repair,
      usage: {
        inputTokens: (first.usage.inputTokens ?? 0) + (repair.usage.inputTokens ?? 0),
        outputTokens: (first.usage.outputTokens ?? 0) + (repair.usage.outputTokens ?? 0),
        estimated: first.usage.estimated || repair.usage.estimated,
      },
    };
  }

  private async chatCompletionWithEmptyRetry(
    req: ChatRequest,
    label: string,
    requestedModel: string | undefined,
  ): Promise<ChatResult> {
    let last: ChatResult | undefined;
    let request = req;
    for (let attempt = 0; attempt <= EMPTY_REPLY_RETRIES; attempt += 1) {
      const result = await this.llm.chatCompletion(request);
      this.logCompletionDiagnostics(label, result, requestedModel);
      if (result.text.trim().length > 0) return result;
      last = result;
      const nextMaxTokens = bumpedMaxTokens(request.maxTokens, result.finishReason);
      log.warn(
        {
          label,
          attempt,
          attemptsLeft: EMPTY_REPLY_RETRIES - attempt,
          requestedModel,
          returnedModel: result.model,
          finishReason: result.finishReason ?? null,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          estimatedUsage: result.usage.estimated,
          nextMaxTokens: nextMaxTokens ?? null,
        },
        'LLM returned an empty visible reply',
      );
      if (nextMaxTokens !== undefined) request = { ...request, maxTokens: nextMaxTokens };
    }
    throw new Error(
      `LLM returned empty visible reply after ${EMPTY_REPLY_RETRIES + 1} attempts` +
        (last?.model ? ` (${last.model})` : ''),
    );
  }

  private logCompletionDiagnostics(label: string, result: ChatResult, requestedModel: string | undefined): void {
    const suspicious = looksPossiblyCutOff(result.text);
    if (result.finishReason !== 'length' && !suspicious) return;
    log.warn(
      {
        label,
        requestedModel,
        returnedModel: result.model,
        finishReason: result.finishReason ?? null,
        chars: result.text.length,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedUsage: result.usage.estimated,
        tail: tail(result.text),
      },
      result.finishReason === 'length'
        ? 'LLM reply hit output limit'
        : 'LLM reply looks possibly cut off',
    );
  }

  private aggregate(
    results: ChatResult[],
    system: string,
    userPrompt: string,
  ): GeneratedCandidates {
    const candidates = results.map((r) => r.text.trim()).filter((t) => t.length > 0);
    let inputTokens = 0;
    let outputTokens = 0;
    let estimated = false;
    for (const r of results) {
      inputTokens += r.usage.inputTokens ?? 0;
      outputTokens += r.usage.outputTokens ?? 0;
      estimated = estimated || r.usage.estimated;
    }
    return {
      candidates,
      usage: { inputTokens, outputTokens, estimated },
      model: results[0]?.model ?? null,
      system,
      userPrompt,
    };
  }
}

function bumpedMaxTokens(
  current: number | undefined,
  finishReason: ChatResult['finishReason'],
): number | undefined {
  if (finishReason !== 'length' || current === undefined) return undefined;
  return Math.min(4096, Math.max(current + 512, Math.ceil(current * 1.75)));
}

function tail(text: string, max = 180): string {
  return text.replace(/\s+/g, ' ').trim().slice(-max);
}

function looksPossiblyCutOff(text: string): boolean {
  const clean = text.trim();
  if (clean.length < 80) return false;
  if (/[.!?…)"'\]\u00bb]$/.test(clean)) return false;
  const last = clean.split(/\s+/).pop() ?? '';
  if (last.length <= 2) return false;
  if (/^[\p{L}\p{N}]+$/u.test(last) && last.length >= 6) return true;
  return /[,;:]$/.test(clean);
}
