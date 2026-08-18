import { fetchSafeRemoteBuffer } from '../../utils/safeRemoteFetch.js';
import { childLogger } from '../../utils/logger.js';
import { SlidingWindowCounter } from '../../utils/rateLimit.js';
import type { Storage } from '../../storage/index.js';
import { extractSubjects } from '../subjects.js';
import type { AmbientDomain } from '../domains.js';
import type { AmbientFact, AmbientProvider, AmbientRecallRequest } from '../types.js';

const log = childLogger('ambient-wikipedia');

/** Courtesy limit; Wikipedia's REST summary endpoint is cheap but shared infrastructure. */
const RATE_LIMIT_PER_MINUTE = 30;

/**
 * Reference knowledge for the stable domains.
 *
 * Philosophy, psychology, science and history do not change between one message and the next,
 * which is exactly what makes them a good fit for a cache-first ambient source: a summary fetched
 * once stays true, so the reply path almost always answers from the database.
 */
export class WikipediaAmbientProvider implements AmbientProvider {
  readonly name = 'wikipedia';
  readonly domains: readonly AmbientDomain[] = [
    'philosophy',
    'psychology',
    'science',
    'history',
    'film_tv',
  ];
  private readonly limiter = new SlidingWindowCounter(60_000, RATE_LIMIT_PER_MINUTE);

  constructor(
    private readonly storage: Storage,
    private readonly cfg: {
      enabled: boolean;
      /** Language edition, e.g. `it`. */
      language: string;
      timeoutMs: number;
      maxResponseBytes: number;
      cacheTtlHours: number;
    },
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  async recall(request: AmbientRecallRequest): Promise<AmbientFact[]> {
    const subjects = extractSubjects(request.message, { limit: 3 });
    if (subjects.length === 0) return [];
    const domain = request.classification.domains[0]?.domain ?? 'science';

    const facts: AmbientFact[] = [];
    for (const subject of subjects) {
      if (facts.length >= request.limit) break;

      const cached = await this.storage.ambientCache.get('wikipedia', cacheKey(subject));
      if (cached) {
        // A negative cache entry is a real answer: it stops a nonsense subject from being
        // re-fetched on every single message that happens to contain it.
        if (cached.miss) continue;
        facts.push(toFact(domain, cached.subject, cached.text, cached.url ?? '', true));
        continue;
      }
      if (request.budget !== 'network') continue;

      const summary = await this.fetchSummary(subject, request.signal);
      await this.storage.ambientCache
        .put(
          'wikipedia',
          cacheKey(subject),
          summary
            ? { subject: summary.title, text: summary.extract, url: summary.url, miss: false }
            : { subject, text: '', miss: true },
          this.cfg.cacheTtlHours,
        )
        .catch((error: unknown) => log.debug({ error }, 'ambient cache write failed'));
      if (summary) facts.push(toFact(domain, summary.title, summary.extract, summary.url, false));
    }
    return facts;
  }

  /**
   * One bounded REST summary lookup.
   *
   * Returns `null` for anything other than a clean hit - including disambiguation pages, which
   * are the single most common way to get a confidently wrong ambient fact.
   */
  private async fetchSummary(
    subject: string,
    signal?: AbortSignal,
  ): Promise<{ title: string; extract: string; url: string } | null> {
    if (!this.limiter.isUnderLimit('wikipedia')) return null;
    this.limiter.record('wikipedia');
    const endpoint = `https://${encodeURIComponent(this.cfg.language)}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(subject)}`;
    try {
      const result = await fetchSafeRemoteBuffer(endpoint, {
        headers: { accept: 'application/json' },
        timeoutMs: this.cfg.timeoutMs,
        maxBytes: this.cfg.maxResponseBytes,
        allowedContentTypes: ['application/json'],
        ...(signal ? { signal } : {}),
      });
      return parseSummary(JSON.parse(result.buffer.toString('utf8')));
    } catch (error) {
      log.debug({ error, subject }, 'wikipedia summary unavailable');
      return null;
    }
  }
}

export function parseSummary(
  payload: unknown,
): { title: string; extract: string; url: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = payload as Record<string, unknown>;
  // `disambiguation` means the title maps to several subjects; quoting one would be a guess.
  if (data['type'] === 'disambiguation') return null;
  const title = typeof data['title'] === 'string' ? data['title'].trim() : '';
  const extract = typeof data['extract'] === 'string' ? data['extract'].trim() : '';
  if (!title || extract.length < 40) return null;
  const urls = data['content_urls'];
  const desktop =
    typeof urls === 'object' && urls !== null
      ? (urls as Record<string, unknown>)['desktop']
      : undefined;
  const page =
    typeof desktop === 'object' && desktop !== null
      ? (desktop as Record<string, unknown>)['page']
      : undefined;
  const url = typeof page === 'string' && /^https:\/\//.test(page) ? page : '';
  if (!url) return null;
  return { title, extract: extract.slice(0, 700), url };
}

function toFact(
  domain: AmbientDomain,
  subject: string,
  text: string,
  url: string,
  fromCache: boolean,
): AmbientFact {
  return {
    domain,
    subject,
    text,
    url,
    // Reference knowledge is reliable about its subject but weakly tied to what the user meant,
    // so it ranks below a catalog match that resolved an exact title.
    confidence: 0.6,
    fromCache,
    entityId: `wikipedia:${subject.toLowerCase()}`,
  };
}

function cacheKey(subject: string): string {
  return subject.toLowerCase().slice(0, 120);
}
