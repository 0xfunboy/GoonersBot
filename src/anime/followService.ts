import type { AnimeConfig } from '../config/index.js';
import type { Storage } from '../storage/index.js';
import type { AnimeFollowDoc } from '../storage/repositories/animeFollows.js';
import { childLogger } from '../utils/logger.js';
import { isDecisiveMatch, rankByTitle } from './titles.js';
import type { AnimeCatalogService } from './catalogService.js';
import type { AnimeSeries } from './types.js';

const log = childLogger('anime-follows');

export interface FollowTarget {
  chatId: number;
  threadId?: number | undefined;
  userHandle: string;
}

export type FollowOutcome =
  | { ok: true; created: boolean; series: AnimeSeries }
  | {
      ok: false;
      reason: 'disabled' | 'not_found' | 'ambiguous' | 'limit_reached';
      candidates: AnimeSeries[];
    };

export type UnfollowOutcome =
  | { ok: true; series: AnimeSeries }
  | {
      ok: false;
      reason: 'disabled' | 'not_found' | 'ambiguous' | 'not_following';
      candidates: AnimeSeries[];
    };

/**
 * Per-chat series subscriptions.
 *
 * Follows are resolved through the same deterministic catalog lookup as questions, so
 * "segui Tanya the Evil" and "è uscito l'ultimo episodio di Tanya the Evil?" can never disagree
 * about which series they mean.
 */
export class AnimeFollowService {
  constructor(
    private readonly cfg: AnimeConfig,
    private readonly storage: Storage,
    private readonly catalog: AnimeCatalogService,
  ) {}

  get enabled(): boolean {
    return this.cfg.follows.enabled && this.catalog.enabled;
  }

  async follow(query: string, target: FollowTarget, signal?: AbortSignal): Promise<FollowOutcome> {
    if (!this.enabled) return { ok: false, reason: 'disabled', candidates: [] };

    const lookup = await this.catalog.lookup(query, signal);
    if (!lookup.match) {
      return {
        ok: false,
        reason: lookup.candidates.length > 0 ? 'ambiguous' : 'not_found',
        candidates: lookup.candidates.map((candidate) => candidate.series),
      };
    }
    const series = lookup.match.series;

    const existing = await this.storage.animeFollows.get(
      target.chatId,
      series.source,
      series.sourceId,
    );
    if (
      !existing &&
      (await this.storage.animeFollows.countForChat(target.chatId)) >= this.cfg.follows.maxPerChat
    ) {
      return { ok: false, reason: 'limit_reached', candidates: [] };
    }

    // Seed at what has already aired so following mid-season never backfills old episodes.
    const { created } = await this.storage.animeFollows.follow({
      chatId: target.chatId,
      threadId: target.threadId,
      source: series.source,
      sourceId: series.sourceId,
      title: series.title,
      createdByHandle: target.userHandle,
      seedEpisode: series.latestEpisode,
    });
    log.info(
      { chatId: target.chatId, source: series.source, sourceId: series.sourceId, created },
      'anime follow recorded',
    );
    return { ok: true, created, series };
  }

  async unfollow(query: string, chatId: number, signal?: AbortSignal): Promise<UnfollowOutcome> {
    if (!this.enabled) return { ok: false, reason: 'disabled', candidates: [] };

    // Resolve against what this chat actually follows first: it is a far smaller and less
    // ambiguous set than the global catalog, so "smetti di seguire tanya" behaves predictably.
    const followed = await this.storage.animeFollows.listForChat(
      chatId,
      this.cfg.follows.maxPerChat,
    );
    const localMatch = this.matchFollowed(query, followed);
    if (localMatch) {
      const removed = await this.storage.animeFollows.unfollow(
        chatId,
        localMatch.source,
        localMatch.sourceId,
      );
      if (removed) {
        const series =
          (await this.catalog.getPersisted(localMatch.source, localMatch.sourceId)) ??
          seriesStub(localMatch);
        return { ok: true, series };
      }
    }

    const lookup = await this.catalog.lookup(query, signal);
    if (!lookup.match) {
      return {
        ok: false,
        reason: lookup.candidates.length > 0 ? 'ambiguous' : 'not_found',
        candidates: lookup.candidates.map((candidate) => candidate.series),
      };
    }
    const series = lookup.match.series;
    const removed = await this.storage.animeFollows.unfollow(
      chatId,
      series.source,
      series.sourceId,
    );
    return removed
      ? { ok: true, series }
      : { ok: false, reason: 'not_following', candidates: [series] };
  }

  async list(chatId: number): Promise<AnimeFollowDoc[]> {
    if (!this.enabled) return [];
    return this.storage.animeFollows.listForChat(chatId, this.cfg.follows.maxPerChat);
  }

  /** Deterministic match of a query against this chat's follows only. */
  private matchFollowed(query: string, followed: readonly AnimeFollowDoc[]): AnimeFollowDoc | null {
    if (followed.length === 0) return null;
    const ranked = rankByTitle(
      query,
      followed.map((doc) => ({ titles: [doc.title], doc })),
      { limit: 3 },
    );
    return isDecisiveMatch(ranked) && ranked[0] ? ranked[0].item.doc : null;
  }
}

/** Minimal series shape for a follow whose catalog entry has since been evicted. */
function seriesStub(follow: AnimeFollowDoc): AnimeSeries {
  return {
    source: follow.source,
    sourceId: follow.sourceId,
    title: follow.title,
    aliases: [],
    titleKeys: [],
    url: `https://anilist.co/anime/${follow.sourceId}`,
    status: 'ongoing',
    genres: [],
    studios: [],
    externalIds: {},
  };
}
