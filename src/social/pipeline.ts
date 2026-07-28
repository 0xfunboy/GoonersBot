import type { StoredMessage } from '../storage/repositories/messages.js';
import { compactMiningLines } from '../utils/miningPrompt.js';
import { renderSocialContext } from './context.js';
import type { SocialProfileEngine } from './engine.js';
import { normalizeSocialHandle } from './evolution.js';
import type { SocialObservationMiner } from './miner.js';
import type { SocialObservationResult } from './types.js';

const SOCIAL_MINING_CONTEXT_MAX_BYTES = 2_800;

export interface SocialLearningResult extends SocialObservationResult {
  proposed: number;
  /** LLM extraction failed/skipped; only conservative local declarations were applied. */
  degraded: boolean;
}

/**
 * One-call learning pipeline for the scheduler or post-message background path.
 *
 * Extraction is intentionally separate from reply generation: a failed mining call never delays or
 * breaks the user's response, and applying observations remains deterministic after the LLM step.
 */
export class SocialLearningPipeline {
  private readonly chatQueues = new Map<number, Promise<void>>();

  constructor(
    private readonly engine: SocialProfileEngine,
    private readonly miner: SocialObservationMiner,
  ) {}

  async learn(params: {
    chatId: number;
    messages: StoredMessage[];
    language: string;
    eligibleSourceMessageIds?: number[];
    skipLlm?: boolean;
  }): Promise<SocialLearningResult> {
    const previous = this.chatQueues.get(params.chatId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(
      () => gate,
      () => gate,
    );
    this.chatQueues.set(params.chatId, queued);
    await previous.catch(() => undefined);
    try {
      return await this.learnNow(params);
    } finally {
      release?.();
      if (this.chatQueues.get(params.chatId) === queued) this.chatQueues.delete(params.chatId);
    }
  }

  private async learnNow(params: {
    chatId: number;
    messages: StoredMessage[];
    language: string;
    eligibleSourceMessageIds?: number[];
    skipLlm?: boolean;
  }): Promise<SocialLearningResult> {
    const focusHandles = [
      ...new Set(
        params.messages
          .filter((message) => !message.isBot)
          .flatMap((message) => [message.handle, message.replyToHandle ?? ''])
          .map(normalizeSocialHandle)
          .filter(Boolean),
      ),
    ];
    const [context, knownHandles] = await Promise.all([
      this.engine.getContext(params.chatId, {
        focusHandles,
        maxMembers: 12,
        maxFacetsPerFocusedMember: 5,
        maxFacetsPerOtherMember: 1,
        maxRelationships: 12,
        maxJokes: 6,
        maxNorms: 8,
      }),
      this.engine.listKnownHandles(params.chatId),
    ]);
    const extraction = await this.miner.extractDetailed({
      messages: params.messages,
      existingSocialContext: compactMiningLines(
        renderSocialContext(context),
        SOCIAL_MINING_CONTEXT_MAX_BYTES,
      ),
      language: params.language,
      knownHandles,
      ...(params.eligibleSourceMessageIds
        ? { eligibleSourceMessageIds: params.eligibleSourceMessageIds }
        : {}),
      ...(params.skipLlm ? { skipLlm: true } : {}),
    });
    const result = await this.engine.observeBatch(params.chatId, extraction.observations);
    return {
      proposed: extraction.observations.length,
      degraded: extraction.degraded,
      ...result,
    };
  }
}
