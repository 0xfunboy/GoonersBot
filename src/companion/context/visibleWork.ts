import type { LocalDevelopmentService } from '../../capabilities/localDevelopmentService.js';
import type { Storage } from '../../storage/index.js';
import type { Person, ChatContext } from '../../domain/types.js';
import type { AnimeArchiveJobDoc } from '../../storage/repositories/animeArchive.js';
import { childLogger } from '../../utils/logger.js';
import type { VisibleWorkReference, TurnUnderstanding } from './contracts.js';

const log = childLogger('visible-work');

export interface VisibleWorkQuery {
  actorTelegramId: number;
  chatId: number;
  threadId?: number;
  limit?: number;
}

export interface VisibleWorkReader {
  listVisible(query: VisibleWorkQuery): Promise<VisibleWorkReference[]>;
  control?(
    understanding: TurnUnderstanding,
    person: Person,
    context: ChatContext,
    language: string,
  ): Promise<string | null>;
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
          includeRecentTerminal: true,
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
        state: job.paused ? 'paused' : job.state,
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

  /** The original worker retains the only execution lease; controls never clone/replay jobs. */
  async control(
    understanding: TurnUnderstanding,
    person: Person,
    context: ChatContext,
    language: string,
  ): Promise<string | null> {
    const operations = understanding.interactions.filter((operation) =>
      ['status', 'cancel', 'pause', 'resume', 'continue_work', 'amend_work'].includes(
        operation.kind,
      ),
    );
    if (!operations.length) return null;
    const italian = language.toLowerCase().startsWith('it');
    const query = {
      actorTelegramId: person.telegramId,
      chatId: context.chatId,
      ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
      limit: 30,
    };
    const visible = await this.listVisible(query);
    if (!visible.length) return null;
    const archive = await this.storage.animeArchive.jobs.listVisibleForActor({
      ...query,
      includeRecentTerminal: true,
    });
    const replies: string[] = [];
    for (const operation of operations) {
      const refs = new Set(operation.referentIds.map((id) => id.replace(/^work:/u, '')));
      // Telegram reply is authoritative only if it resolves to an actual receipt in this scope.
      const replied =
        context.repliedToMessageId === undefined
          ? []
          : archive.filter(
              (job) =>
                job.destination.replyToMessageId === context.repliedToMessageId ||
                job.episodes.some(
                  (episode) =>
                    episode.receipt?.messageId === context.repliedToMessageId ||
                    episode.receipt?.messageIds?.includes(context.repliedToMessageId!),
                ),
            );
      let candidates = replied.length
        ? visible.filter((item) => replied.some((job) => job.id === item.id))
        : visible.filter((item) => refs.has(item.id));
      if (!candidates.length && refs.size) continue; // Never redirect a control aimed at another task.
      if (!candidates.length)
        candidates = visible.filter((item) =>
          ['resume', 'continue_work'].includes(operation.kind)
            ? ['cancelled', 'paused', 'partial', 'failed', 'stale'].includes(item.state)
            : !['done', 'failed', 'cancelled', 'applied'].includes(item.state),
        );
      if (!candidates.length) continue;
      if (candidates.length !== 1) {
        replies.push(
          italian
            ? `A quale lavoro ti riferisci? ${candidates
                .slice(0, 3)
                .map((item) => item.label.slice(0, 100))
                .join(' · ')}`
            : 'Which request do you mean? Reply to the relevant result.',
        );
        continue;
      }
      const selected = candidates[0]!;
      if (selected.kind === 'local_development') {
        const actor = {
          actorTelegramId: person.telegramId,
          chatId: context.chatId,
          isGroup: context.isGroup,
        };
        if (operation.kind === 'status') replies.push(`${selected.label}: ${selected.state}.`);
        else if (operation.kind === 'cancel') {
          await this.localDevelopment.cancel(actor, selected.id);
          replies.push(
            italian
              ? 'Ho annullato la proposta di modifica; nessun nuovo cambiamento verrà applicato.'
              : 'The development proposal is cancelled; no new changes will be applied.',
          );
        } else if (
          ['resume', 'continue_work'].includes(operation.kind) &&
          selected.state === 'stale'
        ) {
          await this.localDevelopment.status(actor, selected.id);
          replies.push(
            italian
              ? 'Ho richiesto al worker di riprendere la verifica della proposta conservata.'
              : 'The worker will resume verification of the stored proposal.',
          );
        } else
          replies.push(
            italian
              ? 'Questo worker può annullare la proposta o riprendere una verifica interrotta; non può modificare in corsa una patch già in verifica. Posso preparare una nuova proposta dopo aver fermato questa.'
              : 'This worker can cancel a proposal or resume an interrupted verification, but cannot change a patch during verification.',
          );
        continue;
      }
      let job = await this.storage.animeArchive.jobs.get(selected.id);
      if (
        !job ||
        job.requesterTelegramId !== person.telegramId ||
        job.destination.chatId !== context.chatId ||
        (job.destination.threadId ?? null) !== (context.threadId ?? null)
      )
        continue;
      const authority = () => ({ ...query, updatedAt: job!.updatedAt });
      if (operation.kind === 'status') {
        replies.push(archiveStatus(job, italian));
        continue;
      }
      if (operation.kind === 'cancel' || operation.kind === 'pause') {
        const updated = await this.storage.animeArchive.jobs.cancelJob(
          job.id,
          new Date(),
          authority(),
          operation.kind === 'pause',
        );
        replies.push(
          updated
            ? italian
              ? operation.kind === 'pause'
                ? 'Archivio in pausa. Gli episodi già consegnati restano salvati.'
                : 'Archivio fermato. Non avvierò altri download per questo lavoro.'
              : 'Archive stopped; delivered episodes are preserved.'
            : italian
              ? 'Il lavoro è cambiato nel frattempo; non ho modificato una versione superata.'
              : 'The request changed before the control could be applied.',
        );
        continue;
      }
      if (operation.kind === 'resume' || operation.kind === 'continue_work') {
        const resumed = await this.storage.animeArchive.jobs.resumeJob(
          job.id,
          new Date(),
          authority(),
        );
        replies.push(
          resumed.resumed
            ? italian
              ? 'Archivio rimesso in coda: salto gli episodi già consegnati e non ripeto gli invii con esito incerto.'
              : 'Archive requeued; delivered episodes and uncertain sends will not be replayed.'
            : italian
              ? 'Non serve ripartire: il lavoro è già attivo o è cambiato nel frattempo.'
              : 'The archive is already active or has changed.',
        );
        continue;
      }
      const proposed = understanding.proposedOperations.find(
        (item) => item.capabilityId === 'anime_archive',
      );
      const args = proposed?.input.args ?? {};
      const episode = Number(args['episodeNumber'] ?? args['episode'] ?? args['episode_number']);
      if (!Number.isFinite(episode) || episode <= 0) {
        replies.push(
          italian
            ? 'Quale episodio devo usare al posto della selezione attuale?'
            : 'Which episode should replace the current selection?',
        );
        continue;
      }
      if (['queued', 'running'].includes(job.state)) {
        const paused = await this.storage.animeArchive.jobs.cancelJob(
          job.id,
          new Date(),
          authority(),
          true,
        );
        if (!paused) {
          replies.push(
            italian
              ? 'La selezione è cambiata mentre la fermavo; controlla lo stato prima di correggerla.'
              : 'The selection changed while it was being paused.',
          );
          continue;
        }
        job = paused;
      }
      const amended = await this.storage.animeArchive.jobs.amendEpisode(
        job.id,
        episode,
        authority(),
      );
      replies.push(
        amended
          ? italian
            ? `Selezione aggiornata all'episodio ${episode}. Riprendo senza reinviare i file già consegnati.`
            : `Selection updated to episode ${episode}; delivered files will not be resent.`
          : italian
            ? `Ho mantenuto il lavoro fermo: l'episodio ${episode} non è nella selezione verificata, oppure c'è un invio incerto da controllare. Indicami il link esatto dell'episodio per una nuova verifica.`
            : 'The archive remains stopped: the episode is outside the verified snapshot, or an earlier send needs reconciliation. Provide its exact source link.',
      );
    }
    return replies.length ? replies.join('\n') : null;
  }
}

function archiveStatus(job: AnimeArchiveJobDoc, italian: boolean): string {
  const done = job.episodes.filter((episode) => episode.status === 'done').length;
  const uncertain = job.episodes.filter((episode) => episode.deliveryOutcomeUnknown).length;
  const state = job.paused ? (italian ? 'in pausa' : 'paused') : job.state;
  return `${job.series.title}: ${state}, ${done}/${job.episodes.length} ${italian ? 'episodi consegnati' : 'episodes delivered'}${uncertain ? `; ${uncertain} ${italian ? 'invii con esito da verificare' : 'sends need reconciliation'}` : ''}.`;
}
