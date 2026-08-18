import type { AnimeConfig } from '../config/index.js';
import { childLogger } from '../utils/logger.js';
import { describeCandidates, describeLatestRelease, summarizeSeries } from './answers.js';
import type { AnimeCatalogService } from './catalogService.js';
import type { AnimeFollowService } from './followService.js';
import type { AnimeSeries } from './types.js';

const log = childLogger('anime-knowledge');

/** The deterministic actions the agent may request. Anything else is rejected, not guessed. */
export const ANIME_INTENTS = ['lookup', 'follow', 'unfollow', 'list_follows', 'airing'] as const;
export type AnimeIntent = (typeof ANIME_INTENTS)[number];

export interface AnimeKnowledgeRequest {
  intent: AnimeIntent;
  /** Series title for `lookup`, `follow` and `unfollow`. */
  title?: string | undefined;
  /**
   * The user's message as written.
   *
   * The title alone cannot say whether they asked "com'era" or "quando esce il prossimo", and
   * that distinction is what resolves a franchise whose entries all share a name.
   */
  question?: string | undefined;
  chatId: number;
  threadId?: number | undefined;
  userHandle: string;
  signal?: AbortSignal | undefined;
}

export interface AnimeKnowledgeAnswer {
  /** Factual text for the composer. Never phrased as a final user-facing reply. */
  summary: string;
  /** True when the request produced real catalog data. */
  resolved: boolean;
  /** The single resolved series, when the match was decisive. */
  series?: AnimeSeries | undefined;
  /** Ranked alternatives when the title stayed ambiguous. */
  candidates: AnimeSeries[];
  /** Canonical source URLs, surfaced to the agent as evidence. */
  sources: string[];
}

/**
 * Single entry point the agent tool calls.
 *
 * Intent selection is the model's job; everything below this line is deterministic - which series
 * a title refers to, what the catalog says about it, and whether a follow was actually written.
 */
export class AnimeKnowledgeService {
  constructor(
    private readonly cfg: AnimeConfig,
    private readonly catalog: AnimeCatalogService,
    private readonly follows: AnimeFollowService,
  ) {}

  get enabled(): boolean {
    return this.catalog.enabled;
  }

  async handle(request: AnimeKnowledgeRequest): Promise<AnimeKnowledgeAnswer> {
    if (!this.enabled) {
      return empty('Il catalogo anime non è abilitato su questa istanza.');
    }
    switch (request.intent) {
      case 'lookup':
        return this.lookup(request);
      case 'follow':
        return this.follow(request);
      case 'unfollow':
        return this.unfollow(request);
      case 'list_follows':
        return this.listFollows(request);
      case 'airing':
        return this.airing(request);
      default:
        return empty('Richiesta sul catalogo anime non riconosciuta.');
    }
  }

  private async lookup(request: AnimeKnowledgeRequest): Promise<AnimeKnowledgeAnswer> {
    const title = request.title?.trim();
    if (!title) return empty('Nessun titolo indicato per la ricerca nel catalogo anime.');

    const result = await this.catalog.lookup(title, request.signal, {
      preferOngoing: asksAboutUpcoming(request.question ?? title),
    });
    if (result.match) {
      const series = result.match.series;
      log.info(
        {
          title,
          sourceId: series.sourceId,
          fromCache: result.fromCache,
          score: result.match.score,
        },
        'anime lookup resolved',
      );
      return {
        summary: describeLatestRelease(series),
        resolved: true,
        series,
        candidates: [],
        sources: [series.url],
      };
    }
    if (result.candidates.length > 0) {
      const candidates = result.candidates.map((candidate) => candidate.series);
      // `resolved: true` on purpose. A shortlist is a real, verifiable answer backed by real
      // catalog URLs; reporting it as a failure made the agent discard it and surface its own
      // verification machinery to the user instead.
      return {
        summary: `Più titoli corrispondono a "${title}". Dati dal catalogo per ciascuno:\n${describeCandidates(candidates)}`,
        resolved: true,
        candidates,
        sources: candidates.map((series) => series.url),
      };
    }
    return empty(`Nessuna serie trovata nel catalogo per "${title}".`);
  }

  private async follow(request: AnimeKnowledgeRequest): Promise<AnimeKnowledgeAnswer> {
    const title = request.title?.trim();
    if (!title) return empty('Nessun titolo indicato da seguire.');

    const outcome = await this.follows.follow(
      title,
      {
        chatId: request.chatId,
        threadId: request.threadId,
        userHandle: request.userHandle,
      },
      request.signal,
    );
    if (outcome.ok) {
      const series = outcome.series;
      const state = outcome.created
        ? 'Follow creato'
        : 'Questa chat seguiva già la serie (nessun duplicato creato)';
      return {
        summary: `${state}: ${summarizeSeries(series)}\nLa chat riceverà un avviso quando esce un nuovo episodio.`,
        resolved: true,
        series,
        candidates: [],
        sources: [series.url],
      };
    }
    return this.failure(outcome.reason, title, outcome.candidates, {
      limit_reached: `Questa chat ha raggiunto il limite di ${this.cfg.follows.maxPerChat} serie seguite.`,
      disabled: 'I follow delle serie non sono abilitati su questa istanza.',
    });
  }

  private async unfollow(request: AnimeKnowledgeRequest): Promise<AnimeKnowledgeAnswer> {
    const title = request.title?.trim();
    if (!title) return empty('Nessun titolo indicato da smettere di seguire.');

    const outcome = await this.follows.unfollow(title, request.chatId, request.signal);
    if (outcome.ok) {
      return {
        summary: `Follow rimosso: ${summarizeSeries(outcome.series)}`,
        resolved: true,
        series: outcome.series,
        candidates: [],
        sources: [outcome.series.url],
      };
    }
    return this.failure(outcome.reason, title, outcome.candidates, {
      not_following: `Questa chat non stava seguendo "${title}".`,
      disabled: 'I follow delle serie non sono abilitati su questa istanza.',
    });
  }

  private async listFollows(request: AnimeKnowledgeRequest): Promise<AnimeKnowledgeAnswer> {
    const followed = await this.follows.list(request.chatId);
    if (followed.length === 0) {
      return empty('Questa chat non sta seguendo nessuna serie.');
    }
    const lines = followed.map(
      (entry, index) =>
        `${index + 1}. ${entry.title} - https://anilist.co/anime/${entry.sourceId}` +
        (entry.lastNotifiedEpisode >= 0
          ? ` (ultimo avviso: ep. ${entry.lastNotifiedEpisode})`
          : ''),
    );
    return {
      summary: `Serie seguite da questa chat (${followed.length}):\n${lines.join('\n')}`,
      resolved: true,
      candidates: [],
      sources: [],
    };
  }

  private async airing(request: AnimeKnowledgeRequest): Promise<AnimeKnowledgeAnswer> {
    const series = await this.catalog.listAiring(this.cfg.maxCandidates * 2, request.signal);
    if (series.length === 0) return empty('Il catalogo non ha restituito serie in corso.');
    return {
      summary: `Serie attualmente in onda:\n${describeCandidates(series)}`,
      resolved: true,
      candidates: series,
      sources: series.map((entry) => entry.url),
    };
  }

  /** Map a service-level failure onto a factual, non-apologetic summary. */
  private failure(
    reason: string,
    title: string,
    candidates: AnimeSeries[],
    messages: Record<string, string>,
  ): AnimeKnowledgeAnswer {
    const specific = messages[reason];
    if (specific) return { ...empty(specific), candidates };
    if (reason === 'ambiguous' && candidates.length > 0) {
      return {
        summary: `Il titolo "${title}" è ambiguo. Candidati dal catalogo:\n${describeCandidates(candidates)}`,
        resolved: false,
        candidates,
        sources: candidates.map((series) => series.url),
      };
    }
    return { ...empty(`Nessuna serie trovata nel catalogo per "${title}".`), candidates };
  }
}

/**
 * True when the question is about what is coming, not about the work in general.
 *
 * Deliberately narrow: only phrasings that ask about the release timeline count, because this
 * decides which entry of a franchise the answer is about.
 */
export function asksAboutUpcoming(question: string): boolean {
  return /\b(prossim\w*|quando|esce|escono|uscit\w*|nuovo|nuova|nuovi|ultim\w*|next|when|airs?|airing|latest|upcoming)\b/i.test(
    question,
  );
}

function empty(summary: string): AnimeKnowledgeAnswer {
  return { summary, resolved: false, candidates: [], sources: [] };
}

/** Narrow an arbitrary planner-supplied value to a supported intent. */
export function parseAnimeIntent(raw: unknown): AnimeIntent | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  return (ANIME_INTENTS as readonly string[]).includes(normalized)
    ? (normalized as AnimeIntent)
    : null;
}
