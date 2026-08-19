import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Api } from 'grammy';
import type { AnimeArchiveConfig, LinkMediaConfig } from '../../config/index.js';
import {
  AnimeVideoOutputTooLargeError,
  normalizeAnimeVideo,
  probeVideo,
  type VideoProbe,
  videoThumbnail,
} from '../../providers/media/linkMedia/normalizer.js';
import { downloadToFile } from '../../providers/media/linkMedia/http.js';
import { sendPreparedMediaToChat } from '../../providers/media/linkMedia/telegramSender.js';
import { downloadWithYtdlp } from '../../providers/media/linkMedia/ytdlp.js';
import type { GroupQuotaService } from '../../services/groupQuota.js';
import type { Storage } from '../../storage/index.js';
import type {
  AnimeArchiveJobDoc,
  AnimeArchiveJobEpisode,
  AnimeArchiveTelegramReceipt,
} from '../../storage/repositories/animeArchive.js';
import { childLogger } from '../../utils/logger.js';
import { redactSecrets } from '../../utils/secrets.js';
import { ANIMEUNITY_MEDIA_HOSTS } from './animeUnity.js';
import { HENTAISATURN_MEDIA_HOSTS } from './hentaiSaturn.js';
import { assertAllowedArchiveUrl } from './http.js';
import { AnimeArchiveProgressReporter } from './progress.js';
import type { AnimeSourceRegistry } from './registry.js';
import {
  AnimeArchiveError,
  type AnimeArchiveEpisode,
  type AnimeArchiveSource,
  type AnimeMediaCandidate,
  type AnimeSourceAdapter,
} from './types.js';

const log = childLogger('anime-archive-worker');
const MIN_LEASE_MS = 10 * 60_000;
const MIN_STALE_RUN_AGE_MS = 10 * 60_000;
const SUMMARY_SWEEP_AGE_MS = 29 * 24 * 60 * 60_000;
const FINAL_SUMMARY_MAX_CHARS = 3_800;
const FINAL_FAILURE_REASON_MAX_CHARS = 160;
const RECEIPT_PERSIST_ATTEMPTS = 5;
export const MAX_ANIME_MEDIA_CANDIDATES = 6;

interface DownloadedAnimeCandidate {
  file: string;
  probe: VideoProbe;
}

interface DeliveredAnimeEpisode {
  deliveryToken: string;
  receipt: AnimeArchiveTelegramReceipt;
}

class ArchiveEpisodeFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ArchiveEpisodeFailure';
  }
}

class ArchiveDeliveryOutcomeUnknown extends Error {
  constructor(
    readonly deliveryToken: string,
    readonly terminalized: boolean,
    cause?: unknown,
  ) {
    super('Telegram delivery outcome unknown; automatic retry suppressed', { cause });
    this.name = 'ArchiveDeliveryOutcomeUnknown';
  }
}

/**
 * One persistent, sequential worker. Mongo owns the lease and per-episode state, so a process
 * restart can reclaim an interrupted job without touching rows that already have Telegram receipts.
 */
export class AnimeArchiveWorker {
  private readonly workerId = `archive-${process.pid}-${randomBytes(8).toString('hex')}`;
  private readonly instanceTmpDir: string;
  private readonly tmpReady: Promise<void>;
  private readonly shutdownController = new AbortController();
  private api: Api | undefined;
  private drainPromise: Promise<void> | undefined;
  private kickPending = false;
  private currentJobId: string | undefined;

  constructor(
    private readonly cfg: AnimeArchiveConfig,
    private readonly mediaCfg: LinkMediaConfig,
    private readonly storage: Storage,
    private readonly quota: GroupQuotaService,
    private readonly registry: AnimeSourceRegistry,
  ) {
    this.instanceTmpDir = join(cfg.tmpDir, `run-${process.pid}-${randomBytes(6).toString('hex')}`);
    this.tmpReady = prepareScratchRoot(
      cfg.tmpDir,
      this.instanceTmpDir,
      Math.max(MIN_STALE_RUN_AGE_MS, cfg.timeoutMs * 2),
    );
  }

  attachTelegramApi(api: Api): void {
    this.api = api;
    this.kick();
  }

  /** Start/resume queued work. Multiple scheduler/message calls collapse into one drain. */
  kick(): void {
    if (!this.cfg.enabled || !this.api || this.shutdownController.signal.aborted) return;
    if (this.drainPromise) {
      this.kickPending = true;
      return;
    }
    this.kickPending = false;
    this.drainPromise = this.drain()
      .catch((error) => log.error({ error: safeError(error) }, 'anime archive drain failed'))
      .finally(() => {
        this.drainPromise = undefined;
        if (this.kickPending) this.kick();
      });
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort(new Error('anime archive worker shutting down'));
    }
    await this.drainPromise?.catch(() => undefined);
    if (this.currentJobId) {
      await this.storage.animeArchive.jobs
        .releaseJob(this.currentJobId, this.workerId)
        .catch(() => undefined);
    }
    await this.tmpReady.catch(() => undefined);
    await rm(this.instanceTmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async drain(): Promise<void> {
    await this.tmpReady;
    const api = this.api;
    if (!api) return;
    const leaseMs = Math.max(MIN_LEASE_MS, this.cfg.timeoutMs * 2);
    while (!this.shutdownController.signal.aborted) {
      const job = await this.storage.animeArchive.jobs.claimNextJob(this.workerId, leaseMs);
      if (!job) {
        await this.notifyRecentTerminalSummaries(api);
        return;
      }
      this.currentJobId = job.id;
      try {
        await this.processJob(job, api, leaseMs);
      } catch (error) {
        log.warn(
          { error: safeError(error), jobId: job.id, source: job.source },
          'anime archive job interrupted; releasing lease',
        );
        await this.storage.animeArchive.jobs
          .releaseJob(job.id, this.workerId)
          .catch(() => undefined);
        if (this.shutdownController.signal.aborted) return;
      } finally {
        this.currentJobId = undefined;
      }
    }
  }

  private async processJob(job: AnimeArchiveJobDoc, api: Api, leaseMs: number): Promise<void> {
    const progress = new AnimeArchiveProgressReporter(api, job);
    await progress.start();
    const leaseAbort = new AbortController();
    const signal = AbortSignal.any([this.shutdownController.signal, leaseAbort.signal]);
    let renewInFlight = false;
    const renewTimer = setInterval(
      () => {
        if (renewInFlight || signal.aborted) return;
        renewInFlight = true;
        void this.storage.animeArchive.jobs
          .renewLease(job.id, this.workerId, leaseMs)
          .then((renewed) => {
            if (!renewed) leaseAbort.abort(new Error('anime archive job lease was lost'));
          })
          .catch(() => leaseAbort.abort(new Error('anime archive job lease renewal failed')))
          .finally(() => {
            renewInFlight = false;
          });
      },
      Math.min(60_000, Math.max(15_000, Math.floor(leaseMs / 4))),
    );
    renewTimer.unref();

    try {
      for (;;) {
        signal.throwIfAborted();
        const claimed = await this.storage.animeArchive.jobs.claimNextEpisode(
          job.id,
          this.workerId,
        );
        if (!claimed) break;
        const episode = claimed.episode;
        log.info(
          {
            jobId: job.id,
            source: job.source,
            episode: episode.number,
            totalEpisodes: job.episodes.length,
          },
          'anime archive episode started',
        );
        try {
          const delivered = await this.processEpisode(
            claimed.job,
            episode,
            api,
            signal,
            leaseMs,
            progress,
          );
          const completed = await this.persistDeliveredEpisode(job, episode, delivered);
          if (!completed) {
            throw new ArchiveDeliveryOutcomeUnknown(delivered.deliveryToken, false);
          }
          await progress.delivered(episode);
          log.info(
            { jobId: job.id, source: job.source, episode: episode.number },
            'anime archive episode delivered',
          );
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (error instanceof ArchiveDeliveryOutcomeUnknown) {
            const terminalized =
              error.terminalized ||
              Boolean(
                await this.storage.animeArchive.jobs
                  .markEpisodeDeliveryUnknown(
                    job.id,
                    episode.id,
                    this.workerId,
                    error.deliveryToken,
                  )
                  .catch(() => null),
              );
            if (!terminalized) throw error;
            log.error(
              { jobId: job.id, source: job.source, episode: episode.number },
              'anime archive delivery became uncertain; automatic resend suppressed',
            );
            await progress.failed(episode, false);
            continue;
          }
          const retryable = isRetryableFailure(error);
          const failed = await this.storage.animeArchive.jobs.failEpisode(
            job.id,
            episode.id,
            this.workerId,
            safeFailureReason(error),
            retryable,
          );
          if (!failed) throw new Error('anime episode failure lease was lost');
          log.warn(
            {
              jobId: job.id,
              source: job.source,
              episode: episode.number,
              retryable,
              retryScheduled: failed.retryScheduled ?? false,
              error: safeError(error),
            },
            'anime archive episode failed',
          );
          await progress.failed(episode, failed.retryScheduled ?? false);
          if (isSourceLayoutFailure(error)) {
            const stopped = await this.storage.animeArchive.jobs.failPendingEpisodes(
              job.id,
              this.workerId,
              safeFailureReason(error),
            );
            if (!stopped) throw new Error('anime source-layout failure lease was lost');
            break;
          }
          if (failed.retryScheduled) {
            await waitForRetry(retryDelayMs(episode.attempts), signal);
          }
        }
      }
      const finalized = await this.storage.animeArchive.jobs.finalizeJob(job.id, this.workerId);
      if (finalized) {
        await progress.finishing();
        await this.notifyFinalSummary(finalized, api);
      }
    } finally {
      clearInterval(renewTimer);
    }
  }

  /**
   * Telegram returned a receipt, so never return the row to retry. Persist it with a short bounded
   * retry loop; if the lease/write cannot be confirmed, the durable marker is terminalized instead.
   */
  private async persistDeliveredEpisode(
    job: AnimeArchiveJobDoc,
    row: AnimeArchiveJobEpisode,
    delivered: DeliveredAnimeEpisode,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < RECEIPT_PERSIST_ATTEMPTS; attempt += 1) {
      try {
        const completed = await this.storage.animeArchive.jobs.completeEpisode(
          job.id,
          row.id,
          this.workerId,
          delivered.deliveryToken,
          delivered.receipt,
        );
        if (completed) return true;
        const current = await this.storage.animeArchive.jobs.get(job.id);
        const persisted = current?.episodes.find((episode) => episode.id === row.id);
        if (
          persisted?.status === 'done' &&
          sameTelegramReceipt(persisted.receipt, delivered.receipt)
        ) {
          return true;
        }
        if (
          current?.state !== 'running' ||
          current.leaseOwner !== this.workerId ||
          persisted?.deliveryToken !== delivered.deliveryToken
        ) {
          return false;
        }
      } catch (error) {
        log.warn(
          { jobId: job.id, episode: row.number, attempt: attempt + 1, error: safeError(error) },
          'anime archive receipt persistence failed; retrying while lease is valid',
        );
      }
      if (attempt + 1 < RECEIPT_PERSIST_ATTEMPTS) {
        await waitForReceiptPersistence(50 * 2 ** attempt);
      }
    }
    return false;
  }

  private async processEpisode(
    job: AnimeArchiveJobDoc,
    row: AnimeArchiveJobEpisode,
    api: Api,
    parentSignal: AbortSignal,
    leaseMs: number,
    progress: AnimeArchiveProgressReporter,
  ): Promise<DeliveredAnimeEpisode> {
    const deadline = AbortSignal.timeout(this.cfg.timeoutMs);
    const signal = AbortSignal.any([parentSignal, deadline]);
    if (job.source === 'hentaisaturn' && !this.mediaCfg.nsfwAllow) {
      throw new ArchiveEpisodeFailure('HentaiSaturn archive is disabled by NSFW policy', false);
    }
    if (!job.quotaBypass) {
      const preflight = await this.quota.canReserveMedia(job.destination.chatId, 1);
      if (!preflight.allowed) {
        throw new ArchiveEpisodeFailure(
          `Media quota unavailable (${preflight.reason ?? 'limit'})`,
          false,
        );
      }
    }
    const workdir = await mkdtemp(join(this.instanceTmpDir, 'episode-'));
    let quotaBytes = 0;
    let quotaReserved = false;
    let retainQuota = false;
    try {
      const adapter = this.registry.get(job.source);
      // Canonical page metadata and every signed candidate are resolved afresh on each persisted
      // attempt. Expired tokens never survive into Mongo or a subsequent retry.
      const episode = await adapter.getEpisode(row.canonicalUrl, signal);
      if (episode.source !== job.source || episode.sourceId !== row.id) {
        throw new AnimeArchiveError(
          'source_mismatch',
          'Resolved episode identity does not match the queued archive row',
        );
      }
      const resolved = await adapter.resolveMedia(episode, signal);
      const downloaded = await progress.during(row, 'download', () =>
        this.downloadWithFreshMediaFallback(adapter, episode, resolved.candidates, workdir, signal),
      );
      const rawProbe = downloaded.probe;

      const prepared = join(workdir, 'prepared.mp4');
      const normalized = await progress.during(row, 'conversion', () =>
        normalizeAnimeVideo(
          downloaded.file,
          prepared,
          {
            ffmpegBin: this.mediaCfg.ffmpegBin,
            timeoutMs: this.cfg.timeoutMs,
            maxUploadBytes: this.mediaCfg.maxUploadBytes,
            profile: this.cfg.profile,
            maxHeight: this.cfg.maxHeight,
            crf: this.cfg.crf,
            audioBitrateKbps: this.cfg.audioBitrateKbps,
            threads: this.cfg.ffmpegThreads,
            signal,
          },
          rawProbe,
        ),
      );
      log.info(
        {
          jobId: job.id,
          source: job.source,
          episode: row.number,
          action: normalized.action,
          bitrateLimited: normalized.bitrateLimited,
          sizeBytes: normalized.sizeBytes,
        },
        'anime archive episode prepared',
      );
      quotaBytes = normalized.sizeBytes;
      const preparedProbe = await probeVideo(this.mediaCfg.ffmpegBin, prepared, 20_000, signal);
      const thumbnailPath = join(workdir, 'thumbnail.jpg');
      const hasThumbnail = await videoThumbnail(
        this.mediaCfg.ffmpegBin,
        prepared,
        thumbnailPath,
        20_000,
        signal,
      );
      signal.throwIfAborted();
      const leaseRenewed = await this.storage.animeArchive.jobs.renewLease(
        job.id,
        this.workerId,
        leaseMs,
      );
      if (!leaseRenewed) {
        throw new ArchiveEpisodeFailure('Anime archive lease was lost before upload', true);
      }
      signal.throwIfAborted();
      const deliveryToken = randomBytes(18).toString('base64url');
      const marked = await this.storage.animeArchive.jobs.beginEpisodeDelivery(
        job.id,
        row.id,
        this.workerId,
        deliveryToken,
      );
      if (!marked) {
        throw new ArchiveEpisodeFailure(
          'Anime archive lease was lost before delivery marker',
          true,
        );
      }

      if (!job.quotaBypass) {
        let decision: Awaited<ReturnType<GroupQuotaService['reserveMedia']>>;
        try {
          decision = await this.quota.reserveMedia(job.destination.chatId, quotaBytes);
        } catch (error) {
          // The quota CAS may have committed even if its response was lost. Keep both the possible
          // charge and the delivery latch, preventing a second reservation on automatic recovery.
          retainQuota = true;
          const terminalized = Boolean(
            await this.storage.animeArchive.jobs
              .markEpisodeDeliveryUnknown(job.id, row.id, this.workerId, deliveryToken)
              .catch(() => null),
          );
          throw new ArchiveDeliveryOutcomeUnknown(deliveryToken, terminalized, error);
        }
        if (!decision.allowed) {
          const aborted = await this.storage.animeArchive.jobs
            .abortEpisodeDelivery(job.id, row.id, this.workerId, deliveryToken)
            .catch(() => null);
          if (!aborted) {
            const terminalized = Boolean(
              await this.storage.animeArchive.jobs
                .markEpisodeDeliveryUnknown(job.id, row.id, this.workerId, deliveryToken)
                .catch(() => null),
            );
            throw new ArchiveDeliveryOutcomeUnknown(deliveryToken, terminalized);
          }
          throw new ArchiveEpisodeFailure(
            `Media quota unavailable (${decision.reason ?? 'limit'})`,
            false,
          );
        }
        quotaReserved = true;
      }

      if (signal.aborted) {
        await this.storage.animeArchive.jobs
          .abortEpisodeDelivery(job.id, row.id, this.workerId, deliveryToken)
          .catch(() => null);
        throw signal.reason;
      }

      let sent: Awaited<ReturnType<typeof sendPreparedMediaToChat>>;
      try {
        sent = await progress.during(row, 'upload', () =>
          sendPreparedMediaToChat({
            api,
            chatId: job.destination.chatId,
            kind: 'video',
            path: prepared,
            caption: `${job.series.title} — Episodio ${displayEpisodeNumber(row.number)}`,
            filename: episodeFilename(job.series.title, row.number),
            signal,
            ...(job.destination.threadId === null
              ? {}
              : { messageThreadId: job.destination.threadId }),
            ...(job.destination.replyToMessageId === null
              ? {}
              : { replyToMessageId: job.destination.replyToMessageId }),
            video: {
              ...preparedProbe,
              ...(hasThumbnail ? { thumbnailPath } : {}),
            },
          }),
        );
      } catch (error) {
        if (isDefinitiveTelegramApiRejection(error)) {
          const aborted = await this.storage.animeArchive.jobs
            .abortEpisodeDelivery(job.id, row.id, this.workerId, deliveryToken)
            .catch(() => null);
          if (aborted) throw error;
        }
        retainQuota = true;
        const terminalized = Boolean(
          await this.storage.animeArchive.jobs
            .markEpisodeDeliveryUnknown(job.id, row.id, this.workerId, deliveryToken)
            .catch(() => null),
        );
        throw new ArchiveDeliveryOutcomeUnknown(deliveryToken, terminalized, error);
      }
      return {
        deliveryToken,
        receipt: {
          chatId: job.destination.chatId,
          messageId: sent.messageId,
          ...(sent.fileId ? { fileId: sent.fileId } : {}),
          mediaKind: sent.kind === 'document' ? ('document' as const) : ('video' as const),
        },
      };
    } catch (error) {
      if (quotaReserved && !retainQuota) {
        try {
          await this.quota.releaseMedia(job.destination.chatId, quotaBytes);
        } catch {
          throw new ArchiveEpisodeFailure(
            'Media quota rollback outcome unknown; automatic retry suppressed',
            false,
          );
        }
      }
      throw error;
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * A signed direct URL gets one fresh source resolution before falling back to player streams.
   * The six-candidate budget spans all three stages, so refresh cannot multiply network work.
   */
  private async downloadWithFreshMediaFallback(
    adapter: AnimeSourceAdapter,
    episode: AnimeArchiveEpisode,
    initialCandidates: readonly AnimeMediaCandidate[],
    workdir: string,
    signal: AbortSignal,
  ): Promise<DownloadedAnimeCandidate> {
    let remaining = MAX_ANIME_MEDIA_CANDIDATES;
    let lastError: unknown;
    let sawRetryableFailure = false;

    const attempt = async (
      candidates: readonly AnimeMediaCandidate[],
      maximum: number,
    ): Promise<DownloadedAnimeCandidate | null> => {
      const stage = candidates.slice(0, Math.max(0, Math.min(remaining, maximum)));
      if (stage.length === 0) return null;
      remaining -= stage.length;
      try {
        return await this.downloadFirstUsableCandidate(episode.source, stage, workdir, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        lastError = error;
        if (isRetryableFailure(error)) sawRetryableFailure = true;
        return null;
      }
    };

    const initialDirect = initialCandidates.filter((candidate) => candidate.kind === 'download');
    const initialStreams = initialCandidates.filter((candidate) => candidate.kind === 'stream');
    // Preserve budget for at least one refreshed direct and one alternate stream.
    const initial = await attempt(initialDirect, Math.max(0, remaining - 2));
    if (initial) return initial;

    let refreshedCandidates: readonly AnimeMediaCandidate[] = [];
    try {
      const refreshed = await adapter.resolveMedia(episode, signal);
      if (refreshed.source !== episode.source || refreshed.episode.sourceId !== episode.sourceId) {
        throw new AnimeArchiveError(
          'source_mismatch',
          'Refreshed media identity does not match the archive episode',
        );
      }
      refreshedCandidates = refreshed.candidates;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      lastError = error;
      if (isRetryableFailure(error)) sawRetryableFailure = true;
    }

    const refreshedDirect = refreshedCandidates.filter(
      (candidate) => candidate.kind === 'download',
    );
    const refreshedStreams = refreshedCandidates.filter((candidate) => candidate.kind === 'stream');
    const hasStreamFallback = refreshedStreams.length > 0 || initialStreams.length > 0;
    const refreshed = await attempt(
      refreshedDirect,
      Math.max(0, remaining - (hasStreamFallback ? 1 : 0)),
    );
    if (refreshed) return refreshed;

    const streams = uniqueMediaCandidates([...refreshedStreams, ...initialStreams]);
    const alternate = await attempt(streams, remaining);
    if (alternate) return alternate;

    if (sawRetryableFailure && !isRetryableFailure(lastError)) {
      throw new ArchiveEpisodeFailure(
        'Every bounded media candidate failed; at least one failure was transient',
        true,
      );
    }
    throw lastError ?? new ArchiveEpisodeFailure('Source exposed no media candidates', true);
  }

  private async downloadFirstUsableCandidate(
    source: AnimeArchiveSource,
    candidates: readonly AnimeMediaCandidate[],
    workdir: string,
    signal: AbortSignal,
  ): Promise<DownloadedAnimeCandidate> {
    if (candidates.length === 0) {
      throw new ArchiveEpisodeFailure('Source exposed no media candidates', true);
    }
    let lastError: unknown;
    let sawRetryableFailure = false;
    for (const [index, candidate] of candidates.slice(0, MAX_ANIME_MEDIA_CANDIDATES).entries()) {
      signal.throwIfAborted();
      if (candidate.expiresAt && candidate.expiresAt.getTime() <= Date.now() + 10_000) {
        lastError = new ArchiveEpisodeFailure('Signed media candidate expired', true);
        sawRetryableFailure = true;
        continue;
      }
      const candidateDir = await mkdtemp(join(workdir, `candidate-${index}-`));
      let selected = false;
      try {
        const allowedHosts = mediaHostsFor(source);
        const validated = assertAllowedArchiveUrl(candidate.url, allowedHosts);
        let file: string;
        if (candidate.kind === 'stream') {
          if (!this.mediaCfg.ytdlpAvailable || !this.mediaCfg.bwrapBin) {
            throw new ArchiveEpisodeFailure('Safe HLS downloader is unavailable', false);
          }
          const forwardedHeaders = safeForwardHeaders(candidate.requestHeaders);
          const result = await downloadWithYtdlp(validated.toString(), candidateDir, {
            ytdlpBin: this.mediaCfg.ytdlpBin,
            ffmpegBin: this.mediaCfg.ffmpegBin,
            maxDownloadBytes: this.cfg.maxDownloadBytes,
            maxDurationSeconds: this.cfg.maxDurationSeconds,
            timeoutMs: this.cfg.timeoutMs,
            signal,
            userAgent: this.mediaCfg.userAgent,
            ...(this.mediaCfg.ytdlpJsRuntime ? { jsRuntime: this.mediaCfg.ytdlpJsRuntime } : {}),
            ...(this.mediaCfg.ytdlpImpersonate
              ? { impersonate: this.mediaCfg.ytdlpImpersonate }
              : {}),
            ...(this.mediaCfg.bwrapBin ? { bwrapBin: this.mediaCfg.bwrapBin } : {}),
            ...(this.mediaCfg.proxy ? { proxy: this.mediaCfg.proxy } : {}),
            ...(forwardedHeaders['referer'] ? { referer: forwardedHeaders['referer'] } : {}),
            validateUrl: (url) => {
              assertAllowedArchiveUrl(url, allowedHosts);
            },
          });
          if (!result) throw new ArchiveEpisodeFailure('HLS download produced no video', true);
          file = result.file;
        } else {
          const destination = join(candidateDir, 'source-video.bin');
          await downloadToFile(validated.toString(), destination, {
            timeoutMs: this.cfg.timeoutMs,
            maxBytes: this.cfg.maxDownloadBytes,
            userAgent: this.mediaCfg.userAgent,
            signal,
            allowedContentTypes: ['video/*', 'application/octet-stream'],
            headers: safeForwardHeaders(candidate.requestHeaders),
            validateUrl: (url) => {
              assertAllowedArchiveUrl(url, allowedHosts);
            },
          });
          const size = (await stat(destination)).size;
          if (size <= 0) throw new ArchiveEpisodeFailure('Downloaded video is empty', true);
          file = destination;
        }

        const probe = await probeVideo(this.mediaCfg.ffmpegBin, file, 20_000, signal);
        if (!probe.duration || !Number.isFinite(probe.duration)) {
          throw new ArchiveEpisodeFailure('Video duration could not be verified', true);
        }
        if (probe.duration > this.cfg.maxDurationSeconds) {
          throw new ArchiveEpisodeFailure(
            `Episode duration exceeds the configured ${this.cfg.maxDurationSeconds}s ceiling`,
            false,
          );
        }
        selected = true;
        return { file, probe };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        lastError = error;
        if (isRetryableFailure(error)) sawRetryableFailure = true;
      } finally {
        if (!selected) {
          await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
    if (sawRetryableFailure && !isRetryableFailure(lastError)) {
      throw new ArchiveEpisodeFailure(
        'Every bounded media candidate failed; at least one failure was transient',
        true,
      );
    }
    throw lastError ?? new ArchiveEpisodeFailure('Every media candidate failed', true);
  }

  private async notifyFinalSummary(job: AnimeArchiveJobDoc, api: Api): Promise<void> {
    const summary = job.summary;
    if (!summary) return;
    const notificationState = `${job.state}:${job.resumeCount}`;
    const claimed = await this.storage.jobNotifications.claim(
      'anime_archive',
      job.id,
      notificationState,
      job.destination.chatId,
    );
    if (!claimed) return;
    const text = buildFinalSummaryText(job);
    try {
      await api.sendMessage(job.destination.chatId, text, {
        ...(job.destination.threadId === null
          ? {}
          : { message_thread_id: job.destination.threadId }),
      });
    } catch (error) {
      await this.storage.jobNotifications
        .release('anime_archive', job.id, notificationState)
        .catch(() => undefined);
      log.warn(
        { error: safeError(error), jobId: job.id },
        'anime archive final summary delivery failed',
      );
    }
  }

  private async notifyRecentTerminalSummaries(api: Api): Promise<void> {
    const since = new Date(Date.now() - SUMMARY_SWEEP_AGE_MS);
    const terminal = await this.storage.animeArchive.jobs.listTerminal(50, since);
    for (const job of terminal) {
      if (this.shutdownController.signal.aborted) return;
      await this.notifyFinalSummary(job, api);
    }
  }
}

export function buildFinalSummaryText(job: AnimeArchiveJobDoc): string {
  const summary = job.summary;
  if (!summary) return '';
  const failed = summary.failedEpisodes.slice(0, 12).map((episode) => {
    const reason = truncateText(safeFailureReason(episode.reason), FINAL_FAILURE_REASON_MAX_CHARS);
    return `${displayEpisodeNumber(episode.number)} (${reason})`;
  });
  const omitted = Math.max(0, summary.failedEpisodes.length - failed.length);
  const text = [
    `Archivio ${job.series.title} terminato: ${summary.completed}/${summary.total} episodi inviati.`,
    summary.skipped > 0 ? `${summary.skipped} già completati, saltati alla ripresa.` : '',
    failed.length > 0 ? `Falliti: ${failed.join(', ')}.` : '',
    omitted > 0 ? `Altri ${omitted} episodi falliti non mostrati.` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return truncateText(text, FINAL_SUMMARY_MAX_CHARS);
}

/** Exponential, jittered and hard-bounded retry delay; exposed for deterministic tests. */
export function retryDelayMs(attempt: number, random = Math.random()): number {
  const boundedAttempt = Math.max(1, Math.min(8, Math.trunc(attempt)));
  const boundedRandom = Math.max(0, Math.min(1, random));
  const base = Math.min(20_000, 750 * 2 ** (boundedAttempt - 1));
  return Math.round(base * (0.8 + boundedRandom * 0.4));
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    timer.unref();
    const aborted = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function waitForReceiptPersistence(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function sameTelegramReceipt(
  left: AnimeArchiveTelegramReceipt | null,
  right: AnimeArchiveTelegramReceipt,
): boolean {
  return Boolean(
    left &&
    left.chatId === right.chatId &&
    left.messageId === right.messageId &&
    left.fileId === right.fileId &&
    left.fileUniqueId === right.fileUniqueId &&
    left.mediaKind === right.mediaKind,
  );
}

/** Only client-side Bot API rejections prove that Telegram did not accept the upload. */
function isDefinitiveTelegramApiRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Number((error as Record<string, unknown>)['error_code']);
  return Number.isInteger(code) && code >= 400 && code < 500 && ![408, 409, 425].includes(code);
}

function mediaHostsFor(source: AnimeArchiveSource): readonly string[] {
  return source === 'animeunity' ? ANIMEUNITY_MEDIA_HOSTS : HENTAISATURN_MEDIA_HOSTS;
}

function uniqueMediaCandidates(candidates: readonly AnimeMediaCandidate[]): AnimeMediaCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}\0${candidate.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeForwardHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    const value = rawValue.trim();
    if (!['referer', 'origin', 'accept'].includes(name) || /[\0\r\n]/u.test(value)) continue;
    safe[name] = value;
  }
  return safe;
}

function isRetryableFailure(error: unknown): boolean {
  if (error instanceof ArchiveEpisodeFailure) return error.retryable;
  if (error instanceof AnimeVideoOutputTooLargeError) return false;
  if (error instanceof AnimeArchiveError) {
    return error.code === 'media_unavailable';
  }
  const telegramCode =
    error && typeof error === 'object'
      ? Number((error as Record<string, unknown>)['error_code'])
      : Number.NaN;
  if ([408, 409, 410, 425, 429, 500, 502, 503, 504].includes(telegramCode)) return true;
  if (Number.isInteger(telegramCode) && telegramCode >= 400 && telegramCode <= 599) return false;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/duration|quota|too large|maximum .*bytes|unsupported|not found|layout/u.test(message)) {
    return false;
  }
  return /\b(403|408|409|410|425|429|500|502|503|504)\b|timeout|timed out|network|socket|reset|aborted|expired|temporary|fetch failed/u.test(
    message,
  );
}

function isSourceLayoutFailure(error: unknown): boolean {
  return error instanceof AnimeArchiveError && error.code === 'source_layout_changed';
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).replace(/\s+/gu, ' ').trim().slice(0, 700) || 'Unknown failure';
}

function safeError(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: safeFailureReason(error),
  };
}

function truncateText(value: string, maxCharacters: number): string {
  const characters = [...value];
  return characters.length <= maxCharacters ? value : characters.slice(0, maxCharacters).join('');
}

function displayEpisodeNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function episodeFilename(title: string, episode: number): string {
  const safeTitle =
    [...title.normalize('NFKC')]
      .map((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127 ? '_' : character;
      })
      .join('')
      .replace(/[<>:"/\\|?*]/gu, '_')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 120) || 'Anime';
  return `${safeTitle} - E${displayEpisodeNumber(episode)}.mp4`;
}

async function prepareScratchRoot(
  root: string,
  instance: string,
  staleAgeMs: number,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('anime archive temporary root must be a real directory');
  }

  const cutoff = Date.now() - staleAgeMs;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const match = /^run-(\d+)-[a-f0-9]{12}$/u.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    if (candidate === instance) continue;
    const metadata = await lstat(candidate).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink() || metadata.mtimeMs > cutoff)
      continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 2 || processIsAlive(pid)) continue;
    await rm(candidate, { recursive: true, force: true }).catch((error) =>
      log.debug({ error: safeError(error) }, 'stale anime archive scratch cleanup failed'),
    );
  }
  await mkdir(instance, { mode: 0o700 });
  await chmod(instance, 0o700);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
