import type { AnimeArchiveConfig, LinkMediaConfig } from '../../config/index.js';
import type { KeyboardResponse } from '../../domain/types.js';
import { extractUrls } from '../../providers/media/linkMedia/url.js';
import type { GroupQuotaService, QuotaDecision } from '../../services/groupQuota.js';
import type { Storage } from '../../storage/index.js';
import {
  classifyAnimeArchiveAcceptedOfferRecovery,
  classifyAnimeArchiveOfferTransition,
  type AnimeArchiveJobDoc,
  type AnimeArchiveConfirmationAttachmentResult,
  type AnimeArchiveOfferDoc,
  type AnimeArchiveOfferTransitionFailure,
  type AnimeArchiveTarget,
} from '../../storage/repositories/animeArchive.js';
import { EXACT_MATCH_SCORE, isDecisiveMatch, rankByTitle, type RankedTitle } from '../titles.js';
import { childLogger } from '../../utils/logger.js';
import type { AnimeSourceRegistry } from './registry.js';
import {
  compareAnimeEpisodes,
  type AnimeArchiveEpisode,
  type AnimeArchiveSearchResult,
  type AnimeArchiveSeries,
  type AnimeArchiveSource,
  type AnimeSourceAdapter,
  type AnimeUrlClassification,
} from './types.js';

const log = childLogger('anime-archive-service');
const CALLBACK_ACTION = 'anime_archive';
const DEFAULT_TEXT_URL_LIMIT = 4;
const DEFAULT_SEARCH_LIMIT = 5;
const AVAILABILITY_CACHE_TTL_MS = 2 * 60_000;
const AVAILABILITY_CACHE_MAX_ENTRIES = 100;

export interface AnimeArchiveServiceConfig {
  animeArchive: AnimeArchiveConfig;
  /** Existing media policy is also the single source of truth for the adult adapter. */
  linkMedia: Pick<LinkMediaConfig, 'nsfwAllow'>;
}

export interface AnimeArchiveRequestContext {
  chatId: number;
  threadId?: number | null | undefined;
  replyToMessageId?: number | null | undefined;
  requesterTelegramId: number;
  /** Trusted operator/private-session decision computed by the existing permission layer. */
  quotaBypass?: boolean | undefined;
}

export interface PrepareAnimeArchiveUrlInput extends AnimeArchiveRequestContext {
  url: string | URL;
  /** Must be the existing true-admin decision; the service never infers it from chat shape. */
  isAdmin: boolean;
  signal?: AbortSignal | undefined;
}

export interface AnimeArchiveConfirmationInput {
  offerId: string;
  decision: AnimeArchiveConfirmationDecision;
  actorTelegramId: number;
  chatId: number;
  threadId?: number | null | undefined;
  /** Re-evaluated true-admin state at callback/text-confirmation time. */
  isAdmin: boolean;
  quotaBypass?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface AnimeArchiveCallbackConfirmationInput extends Omit<
  AnimeArchiveConfirmationInput,
  'offerId' | 'decision' | 'threadId'
> {
  /** Exact Telegram message that contained the inline keyboard being pressed. */
  confirmationMessageId: number;
}

export interface AnimeArchiveTextConfirmationInput extends Omit<
  AnimeArchiveConfirmationInput,
  'offerId' | 'decision'
> {
  text: string;
  /** Telegram message id being replied to, when the user used reply-to-confirmation. */
  replyToMessageId?: number | undefined;
}

export interface PrepareNaturalAnimeOfferInput extends AnimeArchiveRequestContext {
  query: string;
  /** Catalog/follow episode to offer; decimal forms such as 7.5 or "7,5" are supported. */
  expectedEpisodeNumber?: number | string | undefined;
  /** Explicit user source preference; omitted means AnimeUnity first, then allowed alternatives. */
  preferredSource?: AnimeArchiveSource | undefined;
  signal?: AbortSignal | undefined;
}

export interface PrepareNaturalAnimeSeriesOfferInput extends AnimeArchiveRequestContext {
  query: string;
  /** Explicit user source preference; omitted means AnimeUnity first, then allowed alternatives. */
  preferredSource?: AnimeArchiveSource | undefined;
  isAdmin: boolean;
  signal?: AbortSignal | undefined;
}

export interface PrepareResolvedAnimeOfferInput extends AnimeArchiveRequestContext {
  series: AnimeArchiveSeries;
  episode: AnimeArchiveEpisode;
}

export interface AnimeArchiveTextMatch {
  url: string;
  classification: AnimeUrlClassification;
  allowed: boolean;
  blockedReason?: 'disabled' | 'nsfw_disabled' | undefined;
}

export type AnimeArchiveConfirmationDecision = 'yes' | 'no';

export type AnimeArchiveServiceRejectReason =
  | AnimeArchiveOfferTransitionFailure
  | 'disabled'
  | 'bulk_disabled'
  | 'unsupported_url'
  | 'wrong_url_kind'
  | 'admin_required'
  | 'nsfw_disabled'
  | 'quota_denied'
  | 'source_unavailable'
  | 'no_episodes'
  | 'not_found'
  | 'ambiguous'
  | 'ambiguous_confirmation'
  | 'invalid_confirmation';

export interface AnimeArchiveRejected {
  status: 'rejected';
  reason: AnimeArchiveServiceRejectReason;
  quota?: QuotaDecision | undefined;
  candidates?: AnimeArchiveAvailabilityCandidate[] | undefined;
}

export interface AnimeArchiveQueued {
  status: 'queued';
  job: AnimeArchiveJobDoc;
  created: boolean;
  /** Series snapshot inserted/resumed/newly extended; false means a true no-op replay. */
  changed?: boolean | undefined;
  /** Present for callback/text confirmations so callers can retire the exact Telegram prompt. */
  offer?: AnimeArchiveOfferDoc | undefined;
}

export interface AnimeArchiveConfirmationRequired {
  status: 'confirmation_required';
  offer: AnimeArchiveOfferDoc;
  keyboard: KeyboardResponse;
  series: AnimeArchiveSeries;
  episode?: AnimeArchiveEpisode | undefined;
}

export interface AnimeArchiveCancelled {
  status: 'cancelled';
  offer: AnimeArchiveOfferDoc;
}

export type AnimeArchivePreparationResult =
  | AnimeArchiveQueued
  | AnimeArchiveConfirmationRequired
  | AnimeArchiveRejected;

export type AnimeArchiveConfirmationResult =
  | AnimeArchiveQueued
  | AnimeArchiveCancelled
  | AnimeArchiveRejected;

export interface AnimeArchiveAvailabilityCandidate {
  result: AnimeArchiveSearchResult;
  score: number;
  matchedKey: string;
}

export interface AnimeArchiveAvailabilityMatch extends AnimeArchiveAvailabilityCandidate {
  series: AnimeArchiveSeries;
  episode: AnimeArchiveEpisode;
}

export interface AnimeArchiveAvailabilityResult {
  match?: AnimeArchiveAvailabilityMatch | undefined;
  candidates: AnimeArchiveAvailabilityCandidate[];
  failure?: 'not_found' | 'ambiguous' | undefined;
  fromCache: boolean;
}

interface ArchiveSearchTitleCandidate {
  result: AnimeArchiveSearchResult;
  titles: string[];
}

interface ResolvedRankedArchiveHit {
  entry: RankedTitle<ArchiveSearchTitleCandidate>;
  series: AnimeArchiveSeries;
  episode: AnimeArchiveEpisode;
}

interface CachedAvailability {
  expiresAt: number;
  value: Omit<AnimeArchiveAvailabilityResult, 'fromCache'>;
}

/**
 * Deterministic orchestration boundary shared by pasted URLs, callbacks and natural answers.
 *
 * It owns metadata lookup, quota preflight, secure offer state and idempotent job creation. It
 * deliberately owns neither Telegram Context nor worker lifecycle: integration supplies a tiny
 * `kick` callback, keeping background processing restart-safe and independently testable.
 */
export class AnimeArchiveService {
  private readonly availabilityCache = new Map<string, CachedAvailability>();

  constructor(
    private readonly config: AnimeArchiveServiceConfig,
    private readonly storage: Storage,
    private readonly quota: GroupQuotaService,
    private readonly registry: AnimeSourceRegistry,
    private readonly kick: () => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get enabled(): boolean {
    return this.config.animeArchive.enabled;
  }

  /** Return every supported URL in free text, including an explicit policy result for HS URLs. */
  classifyText(text: string, max = DEFAULT_TEXT_URL_LIMIT): AnimeArchiveTextMatch[] {
    const limit = boundedLimit(max, 1, 12, DEFAULT_TEXT_URL_LIMIT);
    const matches: AnimeArchiveTextMatch[] = [];
    for (const url of extractUrls(text, limit * 2)) {
      const classification = this.registry.classify(url);
      if (!classification) continue;
      const blockedReason = this.blockedReason(classification.source);
      matches.push({
        url: classification.canonicalUrl,
        classification,
        allowed: blockedReason === null,
        ...(blockedReason ? { blockedReason } : {}),
      });
      if (matches.length >= limit) break;
    }
    return matches;
  }

  classifyUrl(url: string | URL): AnimeArchiveTextMatch | null {
    const classification = this.registry.classify(url);
    if (!classification) return null;
    const blockedReason = this.blockedReason(classification.source);
    return {
      url: classification.canonicalUrl,
      classification,
      allowed: blockedReason === null,
      ...(blockedReason ? { blockedReason } : {}),
    };
  }

  /** Dispatch one already-extracted source URL. Episode URLs queue; series URLs only make offers. */
  async prepareUrl(input: PrepareAnimeArchiveUrlInput): Promise<AnimeArchivePreparationResult> {
    const match = this.classifyUrl(input.url);
    if (!match) return rejected('unsupported_url');
    if (!match.allowed) return rejected(match.blockedReason ?? 'disabled');
    return match.classification.kind === 'episode'
      ? this.prepareClassifiedEpisode(match.classification, input)
      : this.prepareClassifiedSeries(match.classification, input);
  }

  async prepareDirectEpisode(
    input: PrepareAnimeArchiveUrlInput,
  ): Promise<AnimeArchivePreparationResult> {
    const match = this.classifyUrl(input.url);
    if (!match) return rejected('unsupported_url');
    if (match.classification.kind !== 'episode') return rejected('wrong_url_kind');
    if (!match.allowed) return rejected(match.blockedReason ?? 'disabled');
    return this.prepareClassifiedEpisode(match.classification, input);
  }

  async prepareSeries(input: PrepareAnimeArchiveUrlInput): Promise<AnimeArchivePreparationResult> {
    const match = this.classifyUrl(input.url);
    if (!match) return rejected('unsupported_url');
    if (match.classification.kind !== 'series') return rejected('wrong_url_kind');
    if (!match.allowed) return rejected(match.blockedReason ?? 'disabled');
    return this.prepareClassifiedSeries(match.classification, input);
  }

  /** Persist the id of the Telegram prompt after it has actually been sent. */
  async attachConfirmationMessage(
    offerId: string,
    confirmationMessageId: number,
  ): Promise<AnimeArchiveOfferDoc | null> {
    return this.storage.animeArchive.offers.attachConfirmationMessage(
      offerId,
      confirmationMessageId,
      this.now(),
    );
  }

  /** Atomic replacement variant used when the caller must delete the exact displaced prompt. */
  async replaceConfirmationMessage(
    offerId: string,
    confirmationMessageId: number,
  ): Promise<AnimeArchiveConfirmationAttachmentResult | null> {
    return this.storage.animeArchive.offers.replaceConfirmationMessage(
      offerId,
      confirmationMessageId,
      this.now(),
    );
  }

  /** Make a pending nonce unusable when its Telegram prompt could not be sent or attached. */
  async invalidateOffer(offerId: string): Promise<AnimeArchiveOfferDoc | null> {
    return this.storage.animeArchive.offers.invalidatePending(offerId, this.now());
  }

  /** Shared YES/NO implementation for both callbacks and plain-language confirmation. */
  async confirm(input: AnimeArchiveConfirmationInput): Promise<AnimeArchiveConfirmationResult> {
    if (input.decision === 'no') {
      const cancelled = await this.storage.animeArchive.offers.cancel(
        input.offerId,
        actorFrom(input),
        this.now(),
      );
      return cancelled.ok
        ? { status: 'cancelled', offer: cancelled.offer }
        : rejected(cancelled.reason);
    }

    const now = this.now();
    const pending = await this.storage.animeArchive.offers.get(input.offerId);
    if (pending?.state === 'accepted') {
      return this.recoverAcceptedOffer(pending, input);
    }
    const precheck = classifyAnimeArchiveOfferTransition(pending, actorFrom(input), now, 'accept');
    if (precheck) return rejected(precheck);
    if (!pending) return rejected('not_found');

    const blocked = this.blockedReason(pending.source);
    if (blocked) return rejected(blocked);
    if (pending.target.kind === 'series' && !this.config.animeArchive.bulkEnabled) {
      return rejected('bulk_disabled');
    }

    if (pending.target.kind === 'episode') {
      const quota = await this.precheckQuota(input.chatId, input.quotaBypass ?? false);
      if (!quota.allowed) return rejected('quota_denied', { quota });
      const episode = await this.readEpisode(
        pending.source,
        pending.target.episode.canonicalUrl,
        input.signal,
      );
      if (!episode || episode.sourceId !== pending.target.episode.id) {
        return rejected('source_unavailable');
      }
      const accepted = await this.storage.animeArchive.offers.accept(
        input.offerId,
        actorFrom(input),
        // Metadata is a network call: expiry must be checked against a fresh clock at the CAS.
        this.now(),
      );
      if (!accepted.ok) return this.rejectOrRecoverAccepted(accepted.reason, input);
      return this.enqueueEpisode(
        episode,
        destinationFromOffer(accepted.offer),
        input.quotaBypass ?? false,
        accepted.offer,
      );
    }

    // Series metadata and the current episode snapshot are resolved before the CAS. A transient
    // source failure therefore leaves a still-pending prompt instead of consuming it without a job.
    const resolved = await this.readSeriesWithEpisodes(
      pending.source,
      pending.target.series.canonicalUrl,
      input.signal,
    );
    if (!resolved) return rejected('source_unavailable');
    if (resolved.episodes.length === 0) return rejected('no_episodes');
    const accepted = await this.storage.animeArchive.offers.accept(
      input.offerId,
      actorFrom(input),
      // Do not let the pre-fetch timestamp extend the life of a confirmation token.
      this.now(),
    );
    if (!accepted.ok) return this.rejectOrRecoverAccepted(accepted.reason, input);
    return this.enqueueSeries(
      resolved.series,
      resolved.episodes,
      destinationFromOffer(accepted.offer),
      input.quotaBypass ?? false,
      accepted.offer,
    );
  }

  async confirmCallback(
    args: readonly string[],
    actor: AnimeArchiveCallbackConfirmationInput,
  ): Promise<AnimeArchiveConfirmationResult> {
    const parsed = parseAnimeArchiveCallbackArgs(args);
    if (!parsed) return rejected('invalid_confirmation');
    const offer = await this.storage.animeArchive.offers.get(parsed.offerId);
    if (!offer) return rejected('not_found');
    if (offer.requesterTelegramId !== actor.actorTelegramId) return rejected('wrong_actor');
    if (offer.chatId !== actor.chatId) return rejected('wrong_chat');
    // The callback is bound to the exact Telegram message whose keyboard carried this nonce. This
    // is stronger than reconstructing a forum topic from callback context, which Telegram/grammY
    // can represent differently from the originating user message.
    if (
      offer.confirmationMessageId === null ||
      offer.confirmationMessageId !== actor.confirmationMessageId
    ) {
      return rejected('invalid_confirmation');
    }
    return this.confirm({
      ...actor,
      offerId: parsed.offerId,
      decision: parsed.decision,
      threadId: offer.threadId,
    });
  }

  /**
   * Reply-to wins. Without it, natural SI/NO is accepted only when exactly one pending offer is
   * visible to the same actor/chat/topic; ambiguity never guesses which archive to start.
   */
  async confirmText(
    input: AnimeArchiveTextConfirmationInput,
  ): Promise<AnimeArchiveConfirmationResult> {
    const decision = parseAnimeArchiveConfirmationDecision(input.text);
    if (!decision) return rejected('invalid_confirmation');
    const actor = {
      actorTelegramId: input.actorTelegramId,
      chatId: input.chatId,
      threadId: input.threadId,
    };
    const pending = await this.storage.animeArchive.offers.listLatestPendingForActor(
      actor,
      10,
      this.now(),
    );
    let selected: AnimeArchiveOfferDoc | undefined;
    if (input.replyToMessageId !== undefined) {
      selected = pending.find((offer) => offer.confirmationMessageId === input.replyToMessageId);
      // A quoted SI/NO is scoped to that exact delivered prompt. Never fall through and consume an
      // unrelated sole pending offer elsewhere in the same topic.
      if (!selected) return rejected('not_found');
    } else {
      if (pending.length === 0) return rejected('not_found');
      if (pending.length !== 1) return rejected('ambiguous_confirmation');
      [selected] = pending;
    }
    if (!selected) return rejected('not_found');
    return this.confirm({
      offerId: selected.id,
      decision,
      actorTelegramId: input.actorTelegramId,
      chatId: input.chatId,
      threadId: input.threadId,
      isAdmin: input.isAdmin,
      quotaBypass: input.quotaBypass,
      signal: input.signal,
    });
  }

  /**
   * Short-lived, bounded live lookup used only to decide whether a natural catalog answer can
   * safely offer a downloadable latest episode. Nothing here writes a second catalog to Mongo.
   */
  async findLatestAvailability(
    query: string,
    options: {
      limit?: number | undefined;
      signal?: AbortSignal | undefined;
      bypassCache?: boolean | undefined;
      expectedEpisodeNumber?: number | string | undefined;
      source?: AnimeArchiveSource | undefined;
    } = {},
  ): Promise<AnimeArchiveAvailabilityResult> {
    if (!this.enabled) return { candidates: [], fromCache: false };
    const normalized = query.trim().replace(/\s+/gu, ' ');
    if (normalized.length < 2) return { candidates: [], fromCache: false };
    const expected = normalizeExpectedEpisodeNumber(options.expectedEpisodeNumber);
    if (options.expectedEpisodeNumber !== undefined && expected === null) {
      return { candidates: [], fromCache: false };
    }
    if (options.source && !this.sourceAllowed(options.source)) {
      return { candidates: [], fromCache: false };
    }
    const limit = boundedLimit(options.limit ?? DEFAULT_SEARCH_LIMIT, 1, 5, DEFAULT_SEARCH_LIMIT);
    const cacheKey = [
      this.config.linkMedia.nsfwAllow ? 'adult' : 'safe',
      options.source ?? 'any',
      expected ?? 'latest',
      limit,
      normalized.toLocaleLowerCase('it'),
    ].join(':');
    const cached = this.availabilityCache.get(cacheKey);
    const nowMs = this.now().getTime();
    if (!options.bypassCache && cached && cached.expiresAt > nowMs) {
      return { ...cached.value, fromCache: true };
    }
    if (cached) this.availabilityCache.delete(cacheKey);

    options.signal?.throwIfAborted();
    const adapters = this.registry.adapters
      .filter(
        (adapter) =>
          this.sourceAllowed(adapter.source) &&
          (!options.source || adapter.source === options.source) &&
          typeof adapter.search === 'function',
      )
      // Safe default is explicit: AnimeUnity wins whenever it has a valid match. The adult source
      // is only consulted as an allowed fallback, never because it happens to expose more episodes.
      .sort(
        (left, right) =>
          Number(left.source !== 'animeunity') - Number(right.source !== 'animeunity'),
      );
    const candidates: AnimeArchiveAvailabilityCandidate[] = [];
    let match: AnimeArchiveAvailabilityMatch | undefined;
    let sawAmbiguity = false;
    for (const adapter of adapters) {
      options.signal?.throwIfAborted();
      const result = await this.findAdapterAvailability(
        adapter,
        normalized,
        limit,
        expected,
        options.signal,
      );
      candidates.push(...result.candidates);
      if (result.match) {
        match = result.match;
        break;
      }
      sawAmbiguity ||= result.failure === 'ambiguous';
    }
    const value: Omit<AnimeArchiveAvailabilityResult, 'fromCache'> = {
      ...(match ? { match } : { failure: sawAmbiguity ? 'ambiguous' : 'not_found' }),
      candidates,
    };
    this.cacheAvailability(cacheKey, value, nowMs);
    return { ...value, fromCache: false };
  }

  private async findAdapterAvailability(
    adapter: AnimeSourceAdapter,
    query: string,
    limit: number,
    expected: number | null,
    signal?: AbortSignal,
  ): Promise<Omit<AnimeArchiveAvailabilityResult, 'fromCache'>> {
    let hits: AnimeArchiveSearchResult[] = [];
    let lastSearchError: unknown;
    for (const searchQuery of archiveSearchQueryVariants(query)) {
      try {
        hits = dedupeSearchResults(await adapter.search!(searchQuery, limit, signal), limit);
        if (hits.length > 0) break;
      } catch (error) {
        signal?.throwIfAborted();
        lastSearchError = error;
      }
    }
    if (hits.length === 0 && lastSearchError) {
      log.warn(
        { source: adapter.source, error: safeError(lastSearchError) },
        'anime archive source search failed',
      );
      return { candidates: [], failure: 'not_found' };
    }
    const ranked = rankByTitle<ArchiveSearchTitleCandidate>(
      query,
      hits.map((result) => ({
        result,
        titles: [result.title, result.slug.replace(/[-_]+/gu, ' ')],
      })),
      { limit, minScore: 0.45 },
    );
    const candidates = ranked.map((entry) => availabilityCandidate(entry));
    const top = ranked[0];
    if (!top) return { candidates, failure: 'not_found' };

    // Episode availability may disambiguate editions of the *same* title, but must never turn a
    // fuzzy sequel/spinoff into the answer merely because the exact title lacks that episode.
    const exact = ranked.filter((entry) => entry.score >= EXACT_MATCH_SCORE);
    const cohort = exact.length ? exact : ranked.filter((entry) => entry.score >= top.score - 0.02);
    if (expected !== null) {
      const resolved = await Promise.all(
        cohort.map(async (entry) => {
          const series = await this.readSeries(
            entry.item.result.source,
            entry.item.result.canonicalUrl,
            signal,
          );
          const episode = series?.episodes.find(
            (candidate) => normalizeExpectedEpisodeNumber(candidate.number) === expected,
          );
          return series && episode ? { entry, series, episode } : null;
        }),
      );
      const eligible = resolved.filter(
        (entry): entry is NonNullable<(typeof resolved)[number]> => entry !== null,
      );
      const selected =
        eligible.length === 1
          ? eligible[0]
          : isDecisiveMatch(eligible.map((entry) => entry.entry))
            ? eligible[0]
            : undefined;
      return selected
        ? { candidates, match: availabilityMatch(selected) }
        : { candidates, failure: eligible.length > 1 ? 'ambiguous' : 'not_found' };
    }

    const titleDecisive = isDecisiveMatch(ranked);
    const contenders = titleDecisive ? [top] : cohort;
    const resolved = await Promise.all(
      contenders.map(async (entry) => {
        const series = await this.readSeries(
          entry.item.result.source,
          entry.item.result.canonicalUrl,
          signal,
        );
        const episode = series ? latestEpisode(series.episodes) : undefined;
        return series && episode ? { entry, series, episode } : null;
      }),
    );
    const usable = resolved
      .filter((entry): entry is NonNullable<(typeof resolved)[number]> => entry !== null)
      .sort((left, right) => right.episode.order - left.episode.order);
    const selected =
      titleDecisive ||
      usable.length === 1 ||
      (usable[0] && usable[1] && usable[0].episode.order > usable[1].episode.order)
        ? usable[0]
        : undefined;
    return selected
      ? { candidates, match: availabilityMatch(selected) }
      : { candidates, failure: usable.length > 1 ? 'ambiguous' : 'not_found' };
  }

  /** Find the latest downloadable episode and persist a normal-user SI/NO offer for it. */
  async prepareNaturalEpisodeOffer(
    input: PrepareNaturalAnimeOfferInput,
  ): Promise<AnimeArchivePreparationResult> {
    const blocked = this.blockedReason(input.preferredSource ?? 'animeunity');
    if (blocked) return rejected(blocked);
    const quota = await this.precheckQuota(input.chatId, input.quotaBypass ?? false);
    if (!quota.allowed) return rejected('quota_denied', { quota });
    const expected = normalizeExpectedEpisodeNumber(input.expectedEpisodeNumber);
    if (input.expectedEpisodeNumber !== undefined && expected === null) {
      return rejected('not_found');
    }
    const availability = await this.findLatestAvailability(input.query, {
      signal: input.signal,
      bypassCache: expected !== null,
      ...(expected === null ? {} : { expectedEpisodeNumber: expected }),
      ...(input.preferredSource ? { source: input.preferredSource } : {}),
    });
    if (!availability.match) {
      const reason = availability.failure ?? 'not_found';
      return rejected(
        reason,
        reason === 'ambiguous' ? { candidates: availability.candidates } : {},
      );
    }
    const episode =
      expected === null
        ? availability.match.episode
        : availability.match.series.episodes.find(
            (candidate) => normalizeExpectedEpisodeNumber(candidate.number) === expected,
          );
    if (!episode) return rejected('not_found');
    return this.createEpisodeOffer(availability.match.series, episode, input);
  }

  /** Whole-series natural-language action selected upstream by Cortex; confirmation stays admin-only. */
  async prepareNaturalSeriesOffer(
    input: PrepareNaturalAnimeSeriesOfferInput,
  ): Promise<AnimeArchivePreparationResult> {
    const blocked = this.blockedReason(input.preferredSource ?? 'animeunity');
    if (blocked) return rejected(blocked);
    if (!this.config.animeArchive.bulkEnabled) return rejected('bulk_disabled');
    if (!input.isAdmin) return rejected('admin_required');
    const availability = await this.findLatestAvailability(input.query, {
      signal: input.signal,
      ...(input.preferredSource ? { source: input.preferredSource } : {}),
    });
    if (!availability.match) {
      const reason = availability.failure ?? 'not_found';
      return rejected(
        reason,
        reason === 'ambiguous' ? { candidates: availability.candidates } : {},
      );
    }
    return this.createSeriesOffer(availability.match.series, input);
  }

  /** An explicit "rehost/scarica" instruction is consent itself, so queue without another SI/NO. */
  async prepareNaturalEpisodeRequest(
    input: PrepareNaturalAnimeOfferInput,
  ): Promise<AnimeArchivePreparationResult> {
    const blocked = this.blockedReason(input.preferredSource ?? 'animeunity');
    if (blocked) return rejected(blocked);
    const quota = await this.precheckQuota(input.chatId, input.quotaBypass ?? false);
    if (!quota.allowed) return rejected('quota_denied', { quota });
    const expected = normalizeExpectedEpisodeNumber(input.expectedEpisodeNumber);
    if (input.expectedEpisodeNumber !== undefined && expected === null) {
      return rejected('not_found');
    }
    const availability = await this.findLatestAvailability(input.query, {
      signal: input.signal,
      bypassCache: true,
      ...(expected === null ? {} : { expectedEpisodeNumber: expected }),
      ...(input.preferredSource ? { source: input.preferredSource } : {}),
    });
    if (!availability.match) {
      const reason = availability.failure ?? 'not_found';
      return rejected(
        reason,
        reason === 'ambiguous' ? { candidates: availability.candidates } : {},
      );
    }
    return this.enqueueEpisode(availability.match.episode, input, input.quotaBypass ?? false);
  }

  /** Create a prompt for a source identity that was already resolved by the no-gateway poller. */
  async prepareResolvedEpisodeOffer(
    input: PrepareResolvedAnimeOfferInput,
  ): Promise<AnimeArchivePreparationResult> {
    const { series, episode } = input;
    const blocked = this.blockedReason(series.source);
    if (blocked) return rejected(blocked);
    if (
      episode.source !== series.source ||
      episode.seriesId !== series.sourceId ||
      episode.canonicalSeriesUrl !== series.canonicalUrl
    ) {
      return rejected('source_unavailable');
    }
    const quota = await this.precheckQuota(input.chatId, input.quotaBypass ?? false);
    if (!quota.allowed) return rejected('quota_denied', { quota });
    return this.createEpisodeOffer(series, episode, input);
  }

  private async prepareClassifiedEpisode(
    classification: AnimeUrlClassification,
    input: PrepareAnimeArchiveUrlInput,
  ): Promise<AnimeArchivePreparationResult> {
    const quota = await this.precheckQuota(input.chatId, input.quotaBypass ?? false);
    if (!quota.allowed) return rejected('quota_denied', { quota });
    const episode = await this.readEpisode(
      classification.source,
      classification.canonicalUrl,
      input.signal,
    );
    if (!episode) return rejected('source_unavailable');
    return this.enqueueEpisode(episode, input, input.quotaBypass ?? false);
  }

  private async prepareClassifiedSeries(
    classification: AnimeUrlClassification,
    input: PrepareAnimeArchiveUrlInput,
  ): Promise<AnimeArchivePreparationResult> {
    if (!this.config.animeArchive.bulkEnabled) return rejected('bulk_disabled');
    if (!input.isAdmin) return rejected('admin_required');
    const series = await this.readSeries(
      classification.source,
      classification.canonicalSeriesUrl,
      input.signal,
    );
    if (!series) return rejected('source_unavailable');
    return this.createSeriesOffer(series, input);
  }

  private async createSeriesOffer(
    series: AnimeArchiveSeries,
    input: AnimeArchiveRequestContext,
  ): Promise<AnimeArchiveConfirmationRequired> {
    const offer = await this.storage.animeArchive.offers.create(
      {
        source: series.source,
        target: { kind: 'series', series: seriesRef(series) },
        chatId: input.chatId,
        threadId: input.threadId,
        replyToMessageId: input.replyToMessageId,
        requesterTelegramId: input.requesterTelegramId,
        requiresAdmin: true,
        expiresAt: this.offerExpiry(),
      },
      this.now(),
    );
    return {
      status: 'confirmation_required',
      offer,
      keyboard: animeArchiveConfirmationKeyboard(offer.id),
      series,
    };
  }

  private async createEpisodeOffer(
    series: AnimeArchiveSeries,
    episode: AnimeArchiveEpisode,
    input: AnimeArchiveRequestContext,
  ): Promise<AnimeArchiveConfirmationRequired> {
    const target: AnimeArchiveTarget = {
      kind: 'episode',
      series: seriesRef(series),
      episode: episodeRef(episode),
    };
    const offer = await this.storage.animeArchive.offers.create(
      {
        source: episode.source,
        target,
        chatId: input.chatId,
        threadId: input.threadId,
        replyToMessageId: input.replyToMessageId,
        requesterTelegramId: input.requesterTelegramId,
        requiresAdmin: false,
        expiresAt: this.offerExpiry(),
      },
      this.now(),
    );
    return {
      status: 'confirmation_required',
      offer,
      keyboard: animeArchiveConfirmationKeyboard(offer.id),
      series,
      episode,
    };
  }

  private async enqueueEpisode(
    episode: AnimeArchiveEpisode,
    destination: AnimeArchiveRequestContext,
    quotaBypass: boolean,
    offer?: AnimeArchiveOfferDoc,
  ): Promise<AnimeArchiveQueued> {
    const created = await this.storage.animeArchive.jobs.create(
      {
        scope: 'episode',
        source: episode.source,
        series: {
          id: episode.seriesId,
          canonicalUrl: episode.canonicalSeriesUrl,
          title: episode.seriesTitle,
        },
        destination: {
          chatId: destination.chatId,
          threadId: destination.threadId,
          replyToMessageId: destination.replyToMessageId,
        },
        requesterTelegramId: destination.requesterTelegramId,
        quotaBypass,
        episodes: [episodeRef(episode)],
        ...(offer ? { offerId: offer.id } : {}),
        idempotencyKey: stableTargetKey(
          episode.source,
          'episode',
          episode.sourceId,
          destination.chatId,
          destination.threadId,
        ),
        // Config counts retries after the initial attempt; storage persists the total budget.
        maxAttempts: 1 + this.config.animeArchive.maxRetries,
      },
      this.now(),
    );
    this.kick();
    return { status: 'queued', ...created, ...(offer ? { offer } : {}) };
  }

  private async enqueueSeries(
    series: AnimeArchiveSeries,
    episodes: readonly AnimeArchiveEpisode[],
    destination: AnimeArchiveRequestContext,
    quotaBypass: boolean,
    offer: AnimeArchiveOfferDoc,
  ): Promise<AnimeArchiveQueued> {
    const created = await this.storage.animeArchive.jobs.createOrMergeSeriesSnapshot(
      {
        scope: 'series',
        source: series.source,
        series: seriesRef(series),
        destination: {
          chatId: destination.chatId,
          threadId: destination.threadId,
          replyToMessageId: destination.replyToMessageId,
        },
        requesterTelegramId: destination.requesterTelegramId,
        quotaBypass,
        episodes: episodes.map(episodeRef),
        offerId: offer.id,
        idempotencyKey: stableTargetKey(
          series.source,
          'series',
          series.sourceId,
          destination.chatId,
          destination.threadId,
        ),
        // Config counts retries after the initial attempt; storage persists the total budget.
        maxAttempts: 1 + this.config.animeArchive.maxRetries,
      },
      this.now(),
    );
    if (created.changed) this.kick();
    return { status: 'queued', ...created, offer };
  }

  /**
   * A successful offer CAS and the idempotent job upsert deliberately form a recoverable pair.
   * Retrying the same confirmation repairs a crash/error between them without reopening pending
   * state or permitting a different actor/chat/topic to adopt the job.
   */
  private async recoverAcceptedOffer(
    offer: AnimeArchiveOfferDoc,
    input: AnimeArchiveConfirmationInput,
  ): Promise<AnimeArchiveConfirmationResult> {
    const reason = classifyAnimeArchiveAcceptedOfferRecovery(offer, actorFrom(input), this.now());
    if (reason) return rejected(reason);

    const existing = await this.storage.animeArchive.jobs.getByOfferId(offer.id);
    if (existing) {
      // The process may have died after persistence but before the original kick.
      this.kick();
      return { status: 'queued', created: false, job: existing, offer };
    }

    const blocked = this.blockedReason(offer.source);
    if (blocked) return rejected(blocked);
    if (offer.target.kind === 'series' && !this.config.animeArchive.bulkEnabled) {
      return rejected('bulk_disabled');
    }

    if (offer.target.kind === 'episode') {
      const quota = await this.precheckQuota(input.chatId, input.quotaBypass ?? false);
      if (!quota.allowed) return rejected('quota_denied', { quota });
      const episode = await this.readEpisode(
        offer.source,
        offer.target.episode.canonicalUrl,
        input.signal,
      );
      if (!episode || episode.sourceId !== offer.target.episode.id) {
        return rejected('source_unavailable');
      }
      return this.enqueueEpisode(
        episode,
        destinationFromOffer(offer),
        input.quotaBypass ?? false,
        offer,
      );
    }

    const resolved = await this.readSeriesWithEpisodes(
      offer.source,
      offer.target.series.canonicalUrl,
      input.signal,
    );
    if (!resolved) return rejected('source_unavailable');
    if (resolved.episodes.length === 0) return rejected('no_episodes');
    return this.enqueueSeries(
      resolved.series,
      resolved.episodes,
      destinationFromOffer(offer),
      input.quotaBypass ?? false,
      offer,
    );
  }

  private async rejectOrRecoverAccepted(
    reason: AnimeArchiveOfferTransitionFailure,
    input: AnimeArchiveConfirmationInput,
  ): Promise<AnimeArchiveConfirmationResult> {
    if (reason !== 'already_consumed') return rejected(reason);
    const latest = await this.storage.animeArchive.offers.get(input.offerId);
    return latest?.state === 'accepted'
      ? this.recoverAcceptedOffer(latest, input)
      : rejected('already_consumed');
  }

  private async readEpisode(
    source: AnimeArchiveSource,
    url: string,
    signal?: AbortSignal,
  ): Promise<AnimeArchiveEpisode | null> {
    try {
      const episode = await this.registry.get(source).getEpisode(url, signal);
      return episode.source === source ? episode : null;
    } catch (error) {
      signal?.throwIfAborted();
      log.warn({ source, error: safeError(error) }, 'anime episode metadata lookup failed');
      return null;
    }
  }

  private async readSeries(
    source: AnimeArchiveSource,
    url: string,
    signal?: AbortSignal,
  ): Promise<AnimeArchiveSeries | null> {
    try {
      const series = await this.registry.get(source).getSeries(url, signal);
      return series.source === source ? series : null;
    } catch (error) {
      signal?.throwIfAborted();
      log.warn({ source, error: safeError(error) }, 'anime series metadata lookup failed');
      return null;
    }
  }

  private async readSeriesWithEpisodes(
    source: AnimeArchiveSource,
    url: string,
    signal?: AbortSignal,
  ): Promise<{ series: AnimeArchiveSeries; episodes: AnimeArchiveEpisode[] } | null> {
    const series = await this.readSeries(source, url, signal);
    if (!series) return null;
    try {
      const episodes = await this.registry.get(source).listEpisodes(series, signal);
      if (episodes.some((episode) => episode.source !== source)) return null;
      return { series, episodes: [...episodes].sort(compareAnimeEpisodes) };
    } catch (error) {
      signal?.throwIfAborted();
      log.warn({ source, error: safeError(error) }, 'anime episode enumeration failed');
      return null;
    }
  }

  private async precheckQuota(chatId: number, bypass: boolean): Promise<QuotaDecision> {
    return bypass ? { allowed: true } : this.quota.canReserveMedia(chatId, 1);
  }

  private blockedReason(source: AnimeArchiveSource): 'disabled' | 'nsfw_disabled' | null {
    if (!this.enabled) return 'disabled';
    return this.sourceAllowed(source) ? null : 'nsfw_disabled';
  }

  private sourceAllowed(source: AnimeArchiveSource): boolean {
    return source !== 'hentaisaturn' || this.config.linkMedia.nsfwAllow;
  }

  private offerExpiry(): Date {
    return new Date(this.now().getTime() + this.config.animeArchive.offerTtlMinutes * 60_000);
  }

  private cacheAvailability(
    key: string,
    value: Omit<AnimeArchiveAvailabilityResult, 'fromCache'>,
    nowMs: number,
  ): void {
    for (const [cachedKey, entry] of this.availabilityCache) {
      if (entry.expiresAt <= nowMs) this.availabilityCache.delete(cachedKey);
    }
    while (this.availabilityCache.size >= AVAILABILITY_CACHE_MAX_ENTRIES) {
      const oldest = this.availabilityCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.availabilityCache.delete(oldest);
    }
    this.availabilityCache.set(key, {
      expiresAt: nowMs + AVAILABILITY_CACHE_TTL_MS,
      value,
    });
  }
}

export function animeArchiveConfirmationKeyboard(offerId: string): KeyboardResponse {
  const id = normalizeOpaqueOfferId(offerId);
  return {
    options: [
      { id: `yes|${id}`, label: 'SI' },
      { id: `no|${id}`, label: 'NO' },
    ],
    callback: CALLBACK_ACTION,
    buttonAction: CALLBACK_ACTION,
    columns: 2,
  };
}

export function parseAnimeArchiveCallbackArgs(
  args: readonly string[],
): { decision: AnimeArchiveConfirmationDecision; offerId: string } | null {
  if (args.length !== 2) return null;
  const [rawDecision, rawOfferId] = args;
  if ((rawDecision !== 'yes' && rawDecision !== 'no') || !rawOfferId) return null;
  try {
    return { decision: rawDecision, offerId: normalizeOpaqueOfferId(rawOfferId) };
  } catch {
    return null;
  }
}

export function parseAnimeArchiveConfirmationDecision(
  text: string,
): AnimeArchiveConfirmationDecision | null {
  const normalized = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('it')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 48) return null;
  const yes = new Set([
    'si',
    'yes',
    'ok',
    'vai',
    'procedi',
    'confermo',
    'scarica',
    'scaricalo',
    'fallo',
    'si vai',
    'si procedi',
    'si scarica',
    'si scaricalo',
  ]);
  const no = new Set(['no', 'nope', 'annulla', 'lascia', 'fermo', 'non scaricare', 'no annulla']);
  if (yes.has(normalized)) return 'yes';
  if (no.has(normalized)) return 'no';
  return null;
}

function normalizeExpectedEpisodeNumber(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim().replace(',', '.');
    if (!/^\d+(?:\.\d+)?$/u.test(text)) return null;
    const normalized = Number(text);
    return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
  }
  const normalized = value;
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function actorFrom(input: AnimeArchiveConfirmationInput) {
  return {
    actorTelegramId: input.actorTelegramId,
    chatId: input.chatId,
    threadId: input.threadId,
    isAdmin: input.isAdmin,
  };
}

function destinationFromOffer(offer: AnimeArchiveOfferDoc): AnimeArchiveRequestContext {
  return {
    chatId: offer.chatId,
    threadId: offer.threadId,
    replyToMessageId: offer.replyToMessageId,
    requesterTelegramId: offer.requesterTelegramId,
  };
}

function seriesRef(series: AnimeArchiveSeries) {
  return {
    id: series.sourceId,
    canonicalUrl: series.canonicalUrl,
    title: series.title,
  };
}

function episodeRef(episode: AnimeArchiveEpisode) {
  return {
    id: episode.sourceId,
    number: episode.order,
    canonicalUrl: episode.canonicalUrl,
    title: episode.title,
  };
}

function latestEpisode(episodes: readonly AnimeArchiveEpisode[]): AnimeArchiveEpisode | undefined {
  return [...episodes].sort(compareAnimeEpisodes).at(-1);
}

function availabilityCandidate(
  entry: RankedTitle<ArchiveSearchTitleCandidate>,
): AnimeArchiveAvailabilityCandidate {
  return {
    result: entry.item.result,
    score: entry.score,
    matchedKey: entry.matchedKey,
  };
}

function availabilityMatch(resolved: ResolvedRankedArchiveHit): AnimeArchiveAvailabilityMatch {
  return {
    ...availabilityCandidate(resolved.entry),
    series: resolved.series,
    episode: resolved.episode,
  };
}

function archiveSearchQueryVariants(query: string): string[] {
  const base = query.trim().replace(/\s+/gu, ' ');
  const variants = [base];
  const compactSeason = base
    .replace(/\b(?:season|stagione)\s*(\d+(?:[.,]\d+)?)\b/giu, '$1')
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/giu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  if (compactSeason && compactSeason !== base) variants.push(compactSeason);
  return [...new Set(variants)];
}

function stableTargetKey(
  source: AnimeArchiveSource,
  scope: 'episode' | 'series',
  sourceId: string,
  chatId: number,
  threadId?: number | null,
): string {
  return JSON.stringify({
    version: 1,
    source,
    scope,
    sourceId,
    chatId,
    threadId: threadId ?? null,
  });
}

function dedupeSearchResults(
  results: readonly AnimeArchiveSearchResult[],
  limit: number,
): AnimeArchiveSearchResult[] {
  const seen = new Set<string>();
  const out: AnimeArchiveSearchResult[] = [];
  for (const result of results) {
    const key = `${result.source}\u0000${result.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
    if (out.length >= limit) break;
  }
  return out;
}

function rejected(
  reason: AnimeArchiveServiceRejectReason,
  extras: Omit<AnimeArchiveRejected, 'status' | 'reason'> = {},
): AnimeArchiveRejected {
  return { status: 'rejected', reason, ...extras };
}

function normalizeOpaqueOfferId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/u.test(id)) {
    throw new Error('Invalid anime archive offer id');
  }
  return id;
}

function boundedLimit(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function safeError(error: unknown): { name: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: raw.replace(/https?:\/\/\S+/giu, '[redacted-url]').slice(0, 300),
  };
}
