import type { AmbientConfig } from '../config/index.js';
import { Cooldown } from '../utils/rateLimit.js';
import { childLogger } from '../utils/logger.js';
import { classifyMessage, type AmbientClassification } from './classifier.js';
import type { AmbientBudget, AmbientFact, AmbientProvider } from './types.js';

const log = childLogger('ambient');

export interface AmbientRecallInput {
  message: string;
  chatId: number;
  /** The chat's adult policy for this turn, as already resolved by the reply pipeline. */
  nsfwAllowed: boolean;
  signal?: AbortSignal | undefined;
}

export interface AmbientRecallResult {
  classification: AmbientClassification;
  facts: AmbientFact[];
  /** Rendered prompt block, or empty when nothing was recalled. */
  block: string;
  /** Canonical URLs behind the facts, for the reply's source list. */
  sources: string[];
  budget: AmbientBudget;
}

const EMPTY: Omit<AmbientRecallResult, 'classification'> = {
  facts: [],
  block: '',
  sources: [],
  budget: 'local',
};

/**
 * Ambient recall: what the bot happens to know about whatever is being discussed.
 *
 * This is the pull-vs-push distinction that makes the catalog feel like knowledge instead of a
 * command. `anime_knowledge` and `web_search` are *pulled* by an explicit classified intent;
 * this runs on every turn and *pushes* a short factual block into the prompt when - and only
 * when - a provider genuinely recognises the subject.
 *
 * Three properties keep it from taking over the bot's personality:
 *  - a message about nothing in particular classifies to nothing and costs one regex pass;
 *  - the reply path is local-only by default, so recall never adds network latency to a reply;
 *  - the rendered block is explicitly optional context, mirroring the curated knowledge block.
 */
export class AmbientRetriever {
  /** Per-chat gate on the one path that may touch the network. */
  private readonly networkCooldown: Cooldown;

  constructor(
    private readonly cfg: AmbientConfig,
    private readonly providers: readonly AmbientProvider[],
  ) {
    this.networkCooldown = new Cooldown(cfg.networkCooldownSeconds * 1000);
  }

  get enabled(): boolean {
    return this.cfg.enabled && this.providers.some((provider) => provider.enabled);
  }

  async recall(input: AmbientRecallInput): Promise<AmbientRecallResult> {
    const classification = classifyMessage(input.message, {
      minScore: this.cfg.minDomainScore,
      maxDomains: this.cfg.maxDomains,
    });
    if (!this.enabled || classification.domains.length === 0) {
      return { classification, ...EMPTY };
    }

    const domains = new Set(classification.domains.map((signal) => signal.domain));
    const selected = this.providers.filter(
      (provider) => provider.enabled && provider.domains.some((domain) => domains.has(domain)),
    );
    if (selected.length === 0) return { classification, ...EMPTY };

    // A live-volatility signal is the only thing worth a network round-trip, and even then only
    // once per chat per cooldown window.
    const wantsNetwork =
      this.cfg.allowNetwork &&
      classification.domains.some((signal) => signal.volatility === 'live');
    const budget: AmbientBudget =
      wantsNetwork && this.networkCooldown.tryAcquire(String(input.chatId)) ? 'network' : 'local';

    const settled = await Promise.allSettled(
      selected.map((provider) =>
        provider.recall({
          message: input.message,
          classification,
          budget,
          chatId: input.chatId,
          nsfwAllowed: input.nsfwAllowed,
          signal: input.signal,
          limit: this.cfg.maxFactsPerProvider,
        }),
      ),
    );

    const facts: AmbientFact[] = [];
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        // One broken provider must never cost the user a reply.
        log.warn(
          { provider: selected[index]?.name, error: outcome.reason },
          'ambient provider failed',
        );
        continue;
      }
      for (const fact of outcome.value) {
        // Single adult gate for every provider: the chat's existing NSFW policy decides, so no
        // provider gets to invent a second, conflicting rule.
        if (fact.adult && !input.nsfwAllowed) continue;
        facts.push(fact);
      }
    }
    if (facts.length === 0) return { classification, ...EMPTY, budget };

    facts.sort((a, b) => b.confidence - a.confidence);
    const kept = facts.slice(0, this.cfg.maxFacts);
    const sources = [
      ...new Set(kept.map((fact) => fact.url).filter((url): url is string => Boolean(url))),
    ];
    log.debug(
      {
        chatId: input.chatId,
        domains: classification.domains.map((signal) => signal.domain),
        budget,
        facts: kept.length,
      },
      'ambient recall produced context',
    );
    return { classification, facts: kept, block: renderBlock(kept), sources, budget };
  }
}

/**
 * Render facts as optional background context.
 *
 * The wording mirrors the curated knowledge block on purpose: the model is told it *happens to*
 * know this, never that it must use it, which is what stops ambient recall from dragging every
 * conversation onto the same subject.
 */
export function renderBlock(facts: readonly AmbientFact[]): string {
  if (facts.length === 0) return '';
  return [
    'AMBIENT FACTS (verified background you happen to know about what is being discussed right ' +
      'now; these are FACTS, never invent more of them. Use only if it fits naturally, never ' +
      'force the topic, never info-dump, never list them):',
    ...facts.map((fact) => `- [${fact.domain}] ${fact.subject}: ${fact.text}`),
  ].join('\n');
}
