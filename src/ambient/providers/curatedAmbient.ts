import type { KnowledgeRetriever } from '../../knowledge/knowledgeRetriever.js';
import type { NewsService } from '../../news/newsService.js';
import { bestDomainFor } from '../classifier.js';
import type { AmbientDomain } from '../domains.js';
import type { AmbientFact, AmbientProvider, AmbientRecallRequest } from '../types.js';

/**
 * The curated knowledge base, re-exposed as an ambient source.
 *
 * `knowledge_rag` already does relevance-scored recall over this collection; wrapping it rather
 * than reimplementing it means the seed file stays the single place where curated culture lives,
 * and the two paths can never disagree about what the bot knows.
 */
export class CuratedAmbientProvider implements AmbientProvider {
  readonly name = 'curated-knowledge';
  readonly domains: readonly AmbientDomain[] = [
    'technology',
    'gaming',
    'music',
    'science',
    'film_tv',
    'anime',
  ];

  constructor(private readonly knowledge: KnowledgeRetriever) {}

  get enabled(): boolean {
    return this.knowledge.enabled;
  }

  async recall(request: AmbientRecallRequest): Promise<AmbientFact[]> {
    const domain = bestDomainFor(request.classification, this.domains, 'technology');
    const items = await this.knowledge.retrieve(request.message);
    return items.slice(0, request.limit).map((item) => ({
      domain,
      subject: item.topic,
      text: item.text,
      // Curated entries are hand-written and always local, but they are background colour rather
      // than a resolved fact about a named subject.
      confidence: Math.min(0.55, 0.3 + item.score * 0.25),
      fromCache: true,
      entityId: `curated:${item.topic.toLowerCase()}`,
    }));
  }
}

/**
 * Today's headlines, re-exposed as an ambient source.
 *
 * Current events are the one domain where "what the bot happens to know" must be measured in
 * hours, so this provider only ever offers items the existing news service already considers
 * fresh, and never reaches further back to fill space.
 */
export class NewsAmbientProvider implements AmbientProvider {
  readonly name = 'news';
  readonly domains: readonly AmbientDomain[] = ['current_events'];

  constructor(private readonly news: NewsService) {}

  get enabled(): boolean {
    return this.news.enabled;
  }

  async recall(request: AmbientRecallRequest): Promise<AmbientFact[]> {
    // Headlines are only worth injecting when the user is actually asking about now, and fetching
    // feeds is a network act, so this provider stays silent on a local-budget turn.
    if (!request.classification.wantsCurrent || request.budget !== 'network') return [];
    // The message itself is the ranking signal: the existing ranker already knows how to weigh
    // terms against fresh items, so nothing here re-implements relevance.
    const ranked = await this.news.ranked({
      dynamicTerms: request.classification.normalized.split(' ').filter((t) => t.length > 3),
    });
    return ranked
      .filter((item) => item.score > 0)
      .slice(0, request.limit)
      .map((item) => ({
        domain: 'current_events' as const,
        subject: item.title,
        text: item.summary || item.title,
        url: item.link,
        confidence: 0.5,
        fromCache: false,
        entityId: `news:${item.link}`,
      }));
  }
}
