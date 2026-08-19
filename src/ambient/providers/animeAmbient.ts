import type { AnimeCatalogService } from '../../anime/catalogService.js';
import { describeSeriesCompact } from '../../anime/answers.js';
import type { AnimeSeries } from '../../anime/types.js';
import { extractSubjects } from '../subjects.js';
import type { AmbientDomain } from '../domains.js';
import type { AmbientFact, AmbientProvider, AmbientRecallRequest } from '../types.js';

/**
 * Ambient release awareness, backed by persisted metadata. Watch/download availability is never
 * inferred from catalog links; the archive layer resolves AnimeUnity/HentaiSaturn separately.
 *
 * The point of this provider is the difference between the bot answering "e uscito l'ultimo
 * episodio?" and the bot *already knowing*, while chatting, that the episode dropped on
 * Wednesday. It therefore resolves against the local catalog and returns nothing when the series
 * is unknown, rather than reaching for the network mid-conversation.
 */
export class AnimeAmbientProvider implements AmbientProvider {
  readonly name = 'anime-catalog';
  readonly domains: readonly AmbientDomain[] = ['anime'];
  readonly adultCapable = true;

  constructor(private readonly catalog: AnimeCatalogService) {}

  get enabled(): boolean {
    return this.catalog.enabled;
  }

  async recall(request: AmbientRecallRequest): Promise<AmbientFact[]> {
    const subjects = extractSubjects(request.message, { limit: 3 });
    if (subjects.length === 0) return [];

    const facts: AmbientFact[] = [];
    const seen = new Set<string>();
    for (const subject of subjects) {
      if (facts.length >= request.limit) break;
      // Local-only on the reply path: `lookupLocal` never leaves the database.
      const result =
        request.budget === 'network'
          ? await this.catalog.lookup(subject, request.signal)
          : await this.catalog.lookupLocal(subject);
      const match = result.match;
      if (!match) continue;
      const series = match.series;
      if (seen.has(series.sourceId)) continue;
      seen.add(series.sourceId);
      facts.push(toFact(series, match.score));
    }
    return facts;
  }
}

function toFact(series: AnimeSeries, score: number): AmbientFact {
  return {
    domain: 'anime',
    subject: series.title,
    text: describeSeriesCompact(series),
    confidence: score,
    fromCache: true,
    adult: isAdult(series),
    entityId: `anilist:${series.sourceId}`,
  };
}

/**
 * Adult classification from the catalog's own genre data.
 *
 * AniList marks adult titles with the `Hentai` genre; treating that as the signal keeps the
 * decision on published metadata rather than on guessing from a title.
 */
function isAdult(series: AnimeSeries): boolean {
  return series.genres.some((genre) => /^(hentai|ecchi)$/i.test(genre));
}
