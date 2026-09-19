import type { LocalDevelopmentService } from '../../capabilities/localDevelopmentService.js';
import type { Storage } from '../../storage/index.js';
import { childLogger } from '../../utils/logger.js';
import type { VisibleWorkReference } from './contracts.js';

const log = childLogger('visible-work');

export interface VisibleWorkQuery {
  actorTelegramId: number;
  chatId: number;
  threadId?: number;
  limit?: number;
}

export interface VisibleWorkReader {
  listVisible(query: VisibleWorkQuery): Promise<VisibleWorkReference[]>;
}

/**
 * Read-only cutover adapter for durable workers that predate the generic task engine.
 *
 * R04 will make companion tasks authoritative. Until then Cortex can still resolve natural status
 * and control references against real, scope-filtered archive and local-development jobs.
 */
export class ExistingVisibleWorkReader implements VisibleWorkReader {
  constructor(
    private readonly storage: Storage,
    private readonly localDevelopment: LocalDevelopmentService,
  ) {}

  async listVisible(query: VisibleWorkQuery): Promise<VisibleWorkReference[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 12, 30));
    const [archive, development] = await Promise.all([
      this.storage.animeArchive.jobs
        .listVisibleForActor({
          actorTelegramId: query.actorTelegramId,
          chatId: query.chatId,
          ...(query.threadId !== undefined ? { threadId: query.threadId } : {}),
          limit,
        })
        .catch((error) => {
          log.warn({ error }, 'anime archive visible-work lookup failed');
          return [];
        }),
      this.localDevelopment.enabled && query.chatId === query.actorTelegramId
        ? this.localDevelopment.listVisible(query.actorTelegramId, limit).catch((error) => {
            log.warn({ error }, 'local development visible-work lookup failed');
            return [];
          })
        : Promise.resolve([]),
    ]);
    return [
      ...archive.map((job) => ({
        id: job.id,
        kind: 'anime_archive' as const,
        state: job.state,
        label: `${job.series.title}: ${job.scope === 'series' ? 'serie' : `episodio ${job.episodes[0]?.number ?? '?'}`}`,
        updatedAt: job.updatedAt.toISOString(),
      })),
      ...development.map((job) => ({
        id: job.id,
        kind: 'local_development' as const,
        state: job.state,
        label: job.goal,
        revision: job.revision,
        updatedAt: job.updatedAt,
      })),
    ]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }
}
