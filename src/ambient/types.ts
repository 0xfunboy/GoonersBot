import type { AmbientClassification } from './classifier.js';
import type { AmbientDomain } from './domains.js';

/**
 * Contract every ambient knowledge source implements.
 *
 * Providers are asked, on an ordinary conversational turn, whether they happen to know something
 * about what is being discussed. They are never asked to research: the answer must be cheap, and
 * "I have nothing" is a completely normal answer.
 */
export interface AmbientProvider {
  readonly name: string;
  /** Domains this provider can speak about. */
  readonly domains: readonly AmbientDomain[];
  readonly enabled: boolean;
  /** True when this provider may return adult material and must respect the chat's NSFW policy. */
  readonly adultCapable?: boolean;
  recall(request: AmbientRecallRequest): Promise<AmbientFact[]>;
}

/**
 * How much work a provider is allowed to do for this turn.
 *
 * `local` is the default on the reply path: persisted or in-memory data only, no network. A
 * provider that cannot answer locally returns nothing rather than blocking a reply on an HTTP
 * round-trip that the user never asked for.
 */
export type AmbientBudget = 'local' | 'network';

export interface AmbientRecallRequest {
  message: string;
  classification: AmbientClassification;
  budget: AmbientBudget;
  chatId: number;
  /** The chat's current adult policy, resolved by the existing reply pipeline. */
  nsfwAllowed: boolean;
  signal?: AbortSignal | undefined;
  /** Maximum facts this provider should return. */
  limit: number;
}

/** One recalled fact, already rendered as text the composer can quote or ignore. */
export interface AmbientFact {
  domain: AmbientDomain;
  /** Short label naming the subject, e.g. the series or article title. */
  subject: string;
  /** Compact factual body. Must contain no speculation. */
  text: string;
  /** Canonical URL backing the fact, when one exists. */
  url?: string | undefined;
  /** 0..1 confidence that this fact is about what the user meant. */
  confidence: number;
  /** True when the fact was produced without any network call. */
  fromCache: boolean;
  /** Set when the fact concerns adult material. */
  adult?: boolean | undefined;
  /**
   * Stable identity for the subject, `<provider>:<id>`. Used to track the subject as a
   * conversation entity so a later "quando esce il prossimo?" still resolves.
   */
  entityId?: string | undefined;
}
