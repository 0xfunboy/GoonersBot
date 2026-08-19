import type { Api } from 'grammy';
import type {
  AnimeArchiveJobDoc,
  AnimeArchiveJobEpisode,
} from '../../storage/repositories/animeArchive.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('anime-archive-progress');
const HEARTBEAT_MS = 45_000;
const TELEGRAM_PROGRESS_TIMEOUT_MS = 5_000;
const TIMED_OUT = Symbol('anime-progress-timeout');

export type AnimeArchiveProgressStage = 'download' | 'split' | 'upload';

/** One edited status message per running job; progress failures never affect media delivery. */
export class AnimeArchiveProgressReporter {
  private messageId: number | undefined;
  private lastText = '';
  private pendingText: string | undefined;
  private flushing = false;
  private disabled = false;

  constructor(
    private readonly api: Pick<Api, 'sendMessage' | 'editMessageText'>,
    private readonly job: AnimeArchiveJobDoc,
  ) {}

  async start(): Promise<void> {
    await this.write(
      `📦 ${this.job.series.title}: avvio archivio (${this.job.episodes.length} ${this.job.episodes.length === 1 ? 'episodio' : 'episodi'}, uno alla volta).`,
    );
  }

  async during<T>(
    episode: AnimeArchiveJobEpisode,
    stage: AnimeArchiveProgressStage,
    task: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    await this.stage(episode, stage, 0);
    const timer = setInterval(() => {
      const elapsedMinutes = Math.max(1, Math.floor((Date.now() - startedAt) / 60_000));
      void this.stage(episode, stage, elapsedMinutes);
    }, HEARTBEAT_MS);
    timer.unref();
    try {
      return await task();
    } finally {
      clearInterval(timer);
    }
  }

  async delivered(episode: AnimeArchiveJobEpisode): Promise<void> {
    const position = this.position(episode);
    const suffix = position < this.job.episodes.length ? ' Passo al prossimo.' : '';
    await this.write(
      `✅ ${this.job.series.title} · episodio ${formatEpisode(episode.number)} inviato (${position}/${this.job.episodes.length}).${suffix}`,
    );
  }

  async failed(episode: AnimeArchiveJobEpisode, retrying: boolean): Promise<void> {
    await this.write(
      `${retrying ? '🔄' : '⚠️'} ${this.job.series.title} · episodio ${formatEpisode(episode.number)} ${retrying ? 'non riuscito, riprovo entro il limite previsto.' : 'non disponibile; continuo con la coda.'}`,
    );
  }

  async finishing(): Promise<void> {
    await this.write(`✅ ${this.job.series.title}: lavorazione conclusa, preparo il riepilogo.`);
  }

  private async stage(
    episode: AnimeArchiveJobEpisode,
    stage: AnimeArchiveProgressStage,
    elapsedMinutes: number,
  ): Promise<void> {
    const labels: Record<AnimeArchiveProgressStage, string> = {
      download: 'download dalla sorgente',
      split: 'divisione lossless per Telegram (qualità originale)',
      upload: 'upload su Telegram',
    };
    const elapsed = elapsedMinutes > 0 ? ` · ${elapsedMinutes} min` : '';
    await this.write(
      `⏳ ${this.job.series.title} · episodio ${formatEpisode(episode.number)} (${this.position(episode)}/${this.job.episodes.length}): ${labels[stage]}${elapsed}.`,
    );
  }

  private position(episode: AnimeArchiveJobEpisode): number {
    const index = this.job.episodes.findIndex((candidate) => candidate.id === episode.id);
    return index >= 0 ? index + 1 : 1;
  }

  private async write(text: string): Promise<void> {
    if (this.disabled || text === this.lastText || text === this.pendingText) return;
    // Coalesce to the newest state. This method intentionally returns immediately: observability
    // must never delay lease renewal, download, conversion or the at-most-once delivery latch.
    this.pendingText = text;
    if (this.flushing) return;
    this.flushing = true;
    void this.flush();
  }

  private async flush(): Promise<void> {
    try {
      while (!this.disabled && this.pendingText !== undefined) {
        const text = this.pendingText;
        this.pendingText = undefined;
        try {
          const request =
            this.messageId !== undefined
              ? this.api
                  .editMessageText(this.job.destination.chatId, this.messageId, text)
                  .then(() => undefined)
              : this.api
                  .sendMessage(this.job.destination.chatId, text, {
                    ...(this.job.destination.threadId === null
                      ? {}
                      : { message_thread_id: this.job.destination.threadId }),
                    ...(this.job.destination.replyToMessageId === null
                      ? {}
                      : {
                          reply_parameters: {
                            message_id: this.job.destination.replyToMessageId,
                            allow_sending_without_reply: true,
                          },
                        }),
                  })
                  .then((sent) => {
                    this.messageId = sent.message_id;
                  });
          const outcome = await progressRequestWithin(request);
          if (outcome === TIMED_OUT) {
            // The Telegram outcome is unknown. Disable this best-effort reporter so it cannot emit
            // a duplicate status later; the actual media pipeline remains completely unaffected.
            this.disabled = true;
            this.pendingText = undefined;
            log.debug({ jobId: this.job.id }, 'anime archive progress update timed out');
            return;
          }
          this.lastText = text;
        } catch (error) {
          log.debug({ error, jobId: this.job.id }, 'anime archive progress update degraded');
        }
      }
    } finally {
      this.flushing = false;
      if (!this.disabled && this.pendingText !== undefined) {
        this.flushing = true;
        void this.flush();
      }
    }
  }
}

async function progressRequestWithin(request: Promise<void>): Promise<void | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), TELEGRAM_PROGRESS_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatEpisode(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
}
