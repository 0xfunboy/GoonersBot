import type { StoredMessage } from '../storage/repositories/messages.js';
import { renderSocialContext } from './context.js';
import type { SocialProfileEngine } from './engine.js';
import type { SocialObservationMiner } from './miner.js';
import type { SocialObservationResult } from './types.js';

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
    const [context, knownHandles] = await Promise.all([
      this.engine.getContext(params.chatId, {
        maxMembers: 40,
        maxFacetsPerFocusedMember: 5,
        maxFacetsPerOtherMember: 3,
        maxRelationships: 30,
        maxJokes: 15,
        maxNorms: 12,
      }),
      this.engine.listKnownHandles(params.chatId),
    ]);
    const extraction = await this.miner.extractDetailed({
      messages: params.messages,
      existingSocialContext: renderSocialContext(context),
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
