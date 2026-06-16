import type { LLMProvider, ChatResult } from '../providers/llm/types.js';
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

  private callOne(
    system: string,
    userPrompt: string,
    model: string | undefined,
  ): Promise<ChatResult> {
    return this.llm.chatCompletion({
      system,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: this.cfg.temperature,
      topP: this.cfg.topP,
      frequencyPenalty: this.cfg.frequencyPenalty,
      presencePenalty: this.cfg.presencePenalty,
      maxTokens: this.maxTokens(),
      ...(model ? { model } : {}),
    });
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
