import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnimeArchiveConfig, LinkMediaConfig } from '../src/config/index.js';
import type { GroupQuotaService } from '../src/services/groupQuota.js';
import type { Storage } from '../src/storage/index.js';
import type {
  AnimeArchiveJobDoc,
  AnimeArchiveJobEpisode,
} from '../src/storage/repositories/animeArchive.js';
import {
  AnimeArchiveError,
  type AnimeArchiveEpisode,
  type AnimeMediaCandidate,
  type AnimeSourceAdapter,
} from '../src/anime/archive/types.js';
import type { AnimeSourceRegistry } from '../src/anime/archive/registry.js';
import {
  AnimeArchiveWorker,
  MAX_ANIME_MEDIA_CANDIDATES,
  buildFinalSummaryText,
} from '../src/anime/archive/worker.js';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  ytdlp: vi.fn(),
  normalize: vi.fn(),
  probe: vi.fn(),
  thumbnail: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../src/providers/media/linkMedia/http.js', () => ({
  downloadToFile: mocks.download,
}));

vi.mock('../src/providers/media/linkMedia/ytdlp.js', () => ({
  downloadWithYtdlp: mocks.ytdlp,
}));

vi.mock('../src/providers/media/linkMedia/telegramSender.js', () => ({
  sendPreparedMediaToChat: mocks.send,
}));

vi.mock('../src/providers/media/linkMedia/normalizer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/providers/media/linkMedia/normalizer.js')>();
  return {
    ...actual,
    normalizeAnimeVideo: mocks.normalize,
    probeVideo: mocks.probe,
    videoThumbnail: mocks.thumbnail,
  };
});

const roots: string[] = [];
const workers: AnimeArchiveWorker[] = [];
let scratchRoot = '';

const validProbe = {
  width: 1280,
  height: 720,
  duration: 1_400,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
};

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'goonerbot-anime-worker-'));
  roots.push(scratchRoot);
  vi.resetAllMocks();
  mocks.download.mockImplementation(async (_url: string, destination: string) => {
    await writeFile(destination, Buffer.from('video'));
  });
  mocks.probe.mockResolvedValue(validProbe);
  mocks.normalize.mockImplementation(async (_input: string, output: string) => {
    await writeFile(output, Buffer.from('prepared'));
    return { action: 'transcode', sizeBytes: 8, bitrateLimited: false };
  });
  mocks.thumbnail.mockResolvedValue(false);
  mocks.send.mockResolvedValue({ fileId: 'telegram-file', messageId: 91, kind: 'video' });
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function archiveConfig(overrides: Partial<AnimeArchiveConfig> = {}): AnimeArchiveConfig {
  return {
    enabled: true,
    bulkEnabled: true,
    profile: 'mobile',
    maxDurationSeconds: 7_200,
    maxDownloadBytes: 500 * 1024 * 1024,
    bulkConcurrency: 1,
    timeoutMs: 30_000,
    maxHeight: 720,
    crf: 27,
    audioBitrateKbps: 96,
    ffmpegThreads: 2,
    offerTtlMinutes: 15,
    maxRetries: 3,
    tmpDir: scratchRoot,
    ...overrides,
  };
}

function mediaConfig(overrides: Partial<LinkMediaConfig> = {}): LinkMediaConfig {
  return {
    enabled: true,
    autoRehost: true,
    aiCommentEnabled: false,
    commentOnlyWhenAddressed: false,
    maxUrlsPerMessage: 2,
    maxMediaPerUrl: 2,
    maxDownloadBytes: 500 * 1024 * 1024,
    maxUploadBytes: 50 * 1024 * 1024,
    maxDurationSeconds: 180,
    aiMaxDurationSeconds: 60,
    timeoutMs: 30_000,
    chatCooldownSeconds: 0,
    userCooldownSeconds: 0,
    tmpDir: scratchRoot,
    allowedHosts: [],
    blockedHosts: [],
    nsfwAllow: true,
    cookies: {
      default: undefined,
      instagram: undefined,
      tiktok: undefined,
      facebook: undefined,
      x: undefined,
      youtube: undefined,
    },
    extraYtdlpHosts: [],
    ytdlpImpersonate: undefined,
    ytdlpJsRuntime: 'node',
    bwrapBin: '/usr/bin/bwrap',
    proxy: undefined,
    cacheTtlDays: 1,
    ffmpegBin: '/usr/bin/ffmpeg',
    ffmpegAvailable: true,
    ytdlpBin: '/usr/bin/yt-dlp',
    ytdlpAvailable: true,
    userAgent: 'worker-test',
    ...overrides,
  };
}

function episodeRow(overrides: Partial<AnimeArchiveJobEpisode> = {}): AnimeArchiveJobEpisode {
  const now = new Date('2026-08-19T12:00:00.000Z');
  return {
    id: 'episode-1',
    number: 1,
    canonicalUrl: 'https://www.animeunity.so/anime/1-series/episode-1',
    order: 0,
    status: 'running',
    attempts: 1,
    totalAttempts: 1,
    receipt: null,
    failureReason: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function archiveJob(overrides: Partial<AnimeArchiveJobDoc> = {}): AnimeArchiveJobDoc {
  const now = new Date('2026-08-19T12:00:00.000Z');
  return {
    id: 'job-1',
    idempotencyKey: 'worker-test',
    offerId: null,
    scope: 'series',
    source: 'animeunity',
    series: {
      id: 'series-1',
      canonicalUrl: 'https://www.animeunity.so/anime/1-series',
      title: 'Test Series',
    },
    destination: { chatId: -1001, threadId: 42, replyToMessageId: 7 },
    requesterTelegramId: 123,
    quotaBypass: false,
    episodes: [episodeRow()],
    maxAttempts: 3,
    state: 'running',
    leaseOwner: 'test-worker',
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    leaseRenewedAt: now,
    claimCount: 1,
    leaseRecoveryCount: 0,
    resumeCount: 0,
    skippedOnCurrentRun: 0,
    summary: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function resolvedEpisode(
  job: AnimeArchiveJobDoc,
  row: AnimeArchiveJobEpisode,
): AnimeArchiveEpisode {
  return {
    source: job.source,
    sourceId: row.id,
    seriesId: job.series.id,
    seriesSlug: 'series',
    seriesTitle: job.series.title,
    number: String(row.number),
    order: row.number,
    title: `Episode ${row.number}`,
    canonicalUrl: row.canonicalUrl,
    canonicalSeriesUrl: job.series.canonicalUrl,
  };
}

function directCandidate(index = 1): AnimeMediaCandidate {
  return {
    url: `https://vixcloud.co/video-${index}.mp4?token=secret-${index}`,
    kind: 'download',
    label: `download-${index}`,
    requestHeaders: { referer: 'https://www.animeunity.so/' },
  };
}

function streamCandidate(index = 1): AnimeMediaCandidate {
  return {
    url: `https://vixcloud.co/stream-${index}.m3u8?token=secret-${index}`,
    kind: 'stream',
    label: `stream-${index}`,
    requestHeaders: { referer: 'https://vixcloud.co/' },
  };
}

interface WorkerHarness {
  job: AnimeArchiveJobDoc;
  row: AnimeArchiveJobEpisode;
  jobs: {
    claimNextJob: ReturnType<typeof vi.fn>;
    claimNextEpisode: ReturnType<typeof vi.fn>;
    renewLease: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    beginEpisodeDelivery: ReturnType<typeof vi.fn>;
    abortEpisodeDelivery: ReturnType<typeof vi.fn>;
    markEpisodeDeliveryUnknown: ReturnType<typeof vi.fn>;
    completeEpisode: ReturnType<typeof vi.fn>;
    failEpisode: ReturnType<typeof vi.fn>;
    failPendingEpisodes: ReturnType<typeof vi.fn>;
    finalizeJob: ReturnType<typeof vi.fn>;
    releaseJob: ReturnType<typeof vi.fn>;
    listTerminal: ReturnType<typeof vi.fn>;
  };
  notifications: {
    claim: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  quota: GroupQuotaService;
  canReserveMedia: ReturnType<typeof vi.fn>;
  reserveMedia: ReturnType<typeof vi.fn>;
  releaseMedia: ReturnType<typeof vi.fn>;
  adapter: AnimeSourceAdapter;
  getEpisode: ReturnType<typeof vi.fn>;
  resolveMedia: ReturnType<typeof vi.fn>;
  registry: AnimeSourceRegistry;
  storage: Storage;
  api: Api;
  sendMessage: ReturnType<typeof vi.fn>;
}

function harness(
  options: {
    job?: AnimeArchiveJobDoc;
    candidates?: AnimeMediaCandidate[];
    terminal?: AnimeArchiveJobDoc[];
  } = {},
): WorkerHarness {
  const job = options.job ?? archiveJob();
  const row = job.episodes[0] ?? episodeRow();
  let jobClaimed = false;
  let episodeClaimed = false;
  const claimNextJob = vi.fn(async () => {
    if (jobClaimed) return null;
    jobClaimed = true;
    return job;
  });
  const claimNextEpisode = vi.fn(async () => {
    if (episodeClaimed) return null;
    episodeClaimed = true;
    return { job, episode: row };
  });
  const renewLease = vi.fn().mockResolvedValue(true);
  const get = vi.fn(async () => job);
  const beginEpisodeDelivery = vi.fn(
    async (_jobId: string, _episodeId: string, _workerId: string, deliveryToken: string) => {
      row.deliveryToken = deliveryToken;
      row.deliveryStartedAt = new Date();
      row.deliveryOutcomeUnknown = false;
      return { job, episode: row };
    },
  );
  const abortEpisodeDelivery = vi.fn(async () => {
    row.deliveryToken = null;
    row.deliveryStartedAt = null;
    return { job, episode: row };
  });
  const markEpisodeDeliveryUnknown = vi.fn(async () => {
    row.status = 'failed';
    row.deliveryOutcomeUnknown = true;
    row.failureReason = 'Telegram delivery outcome unknown; automatic retry suppressed';
    return { job, episode: row };
  });
  const completeEpisode = vi.fn().mockResolvedValue({ job, episode: row });
  const failEpisode = vi
    .fn()
    .mockResolvedValue({ job, episode: { ...row, status: 'failed' }, retryScheduled: false });
  const failPendingEpisodes = vi.fn().mockResolvedValue(job);
  const finalizeJob = vi.fn().mockResolvedValue(null);
  const releaseJob = vi.fn().mockResolvedValue(true);
  const listTerminal = vi.fn().mockResolvedValue(options.terminal ?? []);
  const notifications = {
    claim: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
  };
  const jobs = {
    claimNextJob,
    claimNextEpisode,
    renewLease,
    get,
    beginEpisodeDelivery,
    abortEpisodeDelivery,
    markEpisodeDeliveryUnknown,
    completeEpisode,
    failEpisode,
    failPendingEpisodes,
    finalizeJob,
    releaseJob,
    listTerminal,
  };
  const storage = {
    animeArchive: { jobs },
    jobNotifications: notifications,
  } as unknown as Storage;

  const canReserveMedia = vi.fn().mockResolvedValue({ allowed: true });
  const reserveMedia = vi.fn().mockResolvedValue({ allowed: true });
  const releaseMedia = vi.fn().mockResolvedValue(undefined);
  const quota = { canReserveMedia, reserveMedia, releaseMedia } as unknown as GroupQuotaService;
  const getEpisode = vi.fn().mockResolvedValue(resolvedEpisode(job, row));
  const resolveMedia = vi.fn().mockImplementation(async (episode: AnimeArchiveEpisode) => ({
    source: job.source,
    episode,
    candidates: options.candidates ?? [directCandidate()],
    resolvedAt: new Date(),
  }));
  const adapter = {
    source: job.source,
    classify: vi.fn(),
    getSeries: vi.fn(),
    getEpisode,
    listEpisodes: vi.fn(),
    resolveMedia,
  } as unknown as AnimeSourceAdapter;
  const registry = { get: vi.fn(() => adapter) } as unknown as AnimeSourceRegistry;
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 501 });
  const api = { sendMessage } as unknown as Api;
  return {
    job,
    row,
    jobs,
    notifications,
    quota,
    canReserveMedia,
    reserveMedia,
    releaseMedia,
    adapter,
    getEpisode,
    resolveMedia,
    registry,
    storage,
    api,
    sendMessage,
  };
}

async function runHarness(
  state: WorkerHarness,
  options: {
    archive?: Partial<AnimeArchiveConfig>;
    media?: Partial<LinkMediaConfig>;
    waitFor: 'complete' | 'failure' | 'summary' | 'uncertain';
  },
): Promise<AnimeArchiveWorker> {
  const worker = new AnimeArchiveWorker(
    archiveConfig(options.archive),
    mediaConfig(options.media),
    state.storage,
    state.quota,
    state.registry,
  );
  workers.push(worker);
  worker.attachTelegramApi(state.api);
  await vi.waitFor(() => {
    if (options.waitFor === 'complete') expect(state.jobs.completeEpisode).toHaveBeenCalled();
    if (options.waitFor === 'failure') expect(state.jobs.failEpisode).toHaveBeenCalled();
    if (options.waitFor === 'summary') expect(state.sendMessage).toHaveBeenCalled();
    if (options.waitFor === 'uncertain') {
      expect(state.jobs.markEpisodeDeliveryUnknown).toHaveBeenCalled();
    }
  });
  await vi.waitFor(() => expect(state.jobs.listTerminal).toHaveBeenCalled());
  return worker;
}

describe('anime archive worker safety boundaries', () => {
  it('uploads Telegram-compatible AnimeUnity/HentaiSaturn source bytes without remux or transcode', async () => {
    const state = harness({ candidates: [directCandidate(1)] });

    await runHarness(state, { waitFor: 'complete' });

    expect(mocks.normalize).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0]?.[0].path).toContain('source-video.bin');
    expect(state.reserveMedia).toHaveBeenCalledWith(state.job.destination.chatId, 5);
    expect(mocks.thumbnail.mock.calls[0]?.[1]).toContain('source-video.bin');
  });

  it('probes inside the bounded fallback loop and renews its lease before upload', async () => {
    const state = harness({ candidates: [directCandidate(1), directCandidate(2)] });
    mocks.probe.mockImplementation(async (_bin: string, input: string) => {
      if (input.includes('candidate-0-')) return {};
      return validProbe;
    });

    await runHarness(state, { waitFor: 'complete' });

    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.normalize).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls[0]?.[0].path).toContain('candidate-1-');
    expect(state.canReserveMedia.mock.invocationCallOrder[0]).toBeLessThan(
      state.getEpisode.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(state.jobs.renewLease.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(state.jobs.beginEpisodeDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      state.reserveMedia.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(state.reserveMedia.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(state.jobs.completeEpisode).toHaveBeenCalledOnce();
    const deliveryToken = state.jobs.beginEpisodeDelivery.mock.calls[0]?.[3];
    expect(deliveryToken).toEqual(expect.any(String));
    expect(state.jobs.completeEpisode.mock.calls[0]?.[3]).toBe(deliveryToken);
    expect(mocks.send.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('re-resolves a failed signed direct URL before trying alternate streams', async () => {
    const initialStream = streamCandidate(1);
    const refreshedStream = streamCandidate(2);
    const state = harness({ candidates: [directCandidate(1), initialStream] });
    const episode = resolvedEpisode(state.job, state.row);
    state.resolveMedia
      .mockReset()
      .mockResolvedValueOnce({
        source: state.job.source,
        episode,
        candidates: [directCandidate(1), initialStream],
        resolvedAt: new Date(),
      })
      .mockResolvedValueOnce({
        source: state.job.source,
        episode,
        candidates: [directCandidate(2), refreshedStream],
        resolvedAt: new Date(),
      });
    mocks.download.mockRejectedValue(new Error('HTTP 410 signed URL expired'));
    mocks.ytdlp.mockImplementation(async (_url: string, outputDir: string) => {
      const file = join(outputDir, 'stream.mp4');
      await writeFile(file, Buffer.from('stream'));
      return { file, title: 'episode', duration: 1_400 };
    });

    await runHarness(state, { waitFor: 'complete' });

    expect(state.resolveMedia).toHaveBeenCalledTimes(2);
    expect(mocks.download.mock.calls.map((call) => call[0])).toEqual([
      directCandidate(1).url,
      directCandidate(2).url,
    ]);
    expect(mocks.ytdlp).toHaveBeenCalledOnce();
    expect(mocks.ytdlp.mock.calls[0]?.[0]).toBe(refreshedStream.url);
    expect(mocks.download.mock.invocationCallOrder[0]).toBeLessThan(
      state.resolveMedia.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    expect(state.resolveMedia.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.download.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.download.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.ytdlp.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.ytdlp.mock.invocationCallOrder[0]).toBeLessThan(
      state.jobs.beginEpisodeDelivery.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('retries receipt persistence after Telegram success without uploading or charging twice', async () => {
    const state = harness();
    state.jobs.completeEpisode
      .mockReset()
      .mockRejectedValueOnce(new Error('mongo primary stepped down'))
      .mockRejectedValueOnce(new Error('mongo retryable write timeout'))
      .mockResolvedValue({ job: state.job, episode: state.row });

    await runHarness(state, { waitFor: 'complete' });

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(state.reserveMedia).toHaveBeenCalledOnce();
    expect(state.jobs.completeEpisode).toHaveBeenCalledTimes(3);
    expect(state.jobs.markEpisodeDeliveryUnknown).not.toHaveBeenCalled();
    expect(state.jobs.failEpisode).not.toHaveBeenCalled();
    expect(state.releaseMedia).not.toHaveBeenCalled();
  });

  it('terminalizes a crash-after-send persistence failure without automatic resend or quota rollback', async () => {
    const state = harness();
    state.jobs.completeEpisode.mockRejectedValue(new Error('mongo unavailable after upload'));

    await runHarness(state, { waitFor: 'uncertain' });

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(state.jobs.completeEpisode).toHaveBeenCalledTimes(5);
    expect(state.jobs.markEpisodeDeliveryUnknown).toHaveBeenCalledOnce();
    expect(state.jobs.failEpisode).not.toHaveBeenCalled();
    expect(state.releaseMedia).not.toHaveBeenCalled();
    expect(state.jobs.markEpisodeDeliveryUnknown.mock.calls[0]?.[3]).toBe(
      state.jobs.beginEpisodeDelivery.mock.calls[0]?.[3],
    );
  });

  it('treats an ambiguous Telegram transport error as possibly delivered and never retries it', async () => {
    const state = harness();
    mocks.send.mockRejectedValue(new Error('socket closed before response'));

    await runHarness(state, { waitFor: 'uncertain' });

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(state.jobs.abortEpisodeDelivery).not.toHaveBeenCalled();
    expect(state.jobs.markEpisodeDeliveryUnknown).toHaveBeenCalledOnce();
    expect(state.jobs.failEpisode).not.toHaveBeenCalled();
    expect(state.releaseMedia).not.toHaveBeenCalled();
  });

  it('rolls back marker and quota only when Telegram explicitly rejects the request', async () => {
    const state = harness();
    mocks.send.mockRejectedValue(
      Object.assign(new Error('Too Many Requests'), {
        error_code: 429,
        description: 'Too Many Requests: retry later',
      }),
    );

    await runHarness(state, { waitFor: 'failure' });

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(state.jobs.abortEpisodeDelivery).toHaveBeenCalledOnce();
    expect(state.jobs.markEpisodeDeliveryUnknown).not.toHaveBeenCalled();
    expect(state.jobs.failEpisode.mock.calls[0]?.[4]).toBe(true);
    expect(state.releaseMedia).toHaveBeenCalledOnce();
  });

  it('keeps marker and possible quota charge when quota reservation response is ambiguous', async () => {
    const state = harness();
    state.reserveMedia.mockRejectedValue(new Error('quota CAS response lost'));

    await runHarness(state, { waitFor: 'uncertain' });

    expect(state.jobs.beginEpisodeDelivery).toHaveBeenCalledOnce();
    expect(state.jobs.markEpisodeDeliveryUnknown).toHaveBeenCalledOnce();
    expect(state.jobs.abortEpisodeDelivery).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(state.releaseMedia).not.toHaveBeenCalled();
    expect(state.jobs.failEpisode).not.toHaveBeenCalled();
  });

  it('aborts the marker without charging when quota is definitively denied', async () => {
    const state = harness();
    state.reserveMedia.mockResolvedValue({ allowed: false, reason: 'media_bytes' });

    await runHarness(state, { waitFor: 'failure' });

    expect(state.jobs.beginEpisodeDelivery).toHaveBeenCalledOnce();
    expect(state.jobs.abortEpisodeDelivery).toHaveBeenCalledOnce();
    expect(state.jobs.markEpisodeDeliveryUnknown).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(state.releaseMedia).not.toHaveBeenCalled();
    expect(state.jobs.failEpisode.mock.calls[0]?.[4]).toBe(false);
  });

  it('treats a Telegram 5xx response as ambiguous and never retries or refunds it', async () => {
    const state = harness();
    mocks.send.mockRejectedValue(
      Object.assign(new Error('Telegram internal error'), {
        error_code: 500,
        description: 'Internal Server Error',
      }),
    );

    await runHarness(state, { waitFor: 'uncertain' });

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(state.jobs.abortEpisodeDelivery).not.toHaveBeenCalled();
    expect(state.jobs.markEpisodeDeliveryUnknown).toHaveBeenCalledOnce();
    expect(state.jobs.failEpisode).not.toHaveBeenCalled();
    expect(state.releaseMedia).not.toHaveBeenCalled();
  });

  it('suppresses retry when rollback of a definitively rejected upload is ambiguous', async () => {
    const state = harness();
    mocks.send.mockRejectedValue(
      Object.assign(new Error('Too Many Requests'), {
        error_code: 429,
        description: 'Too Many Requests: retry later',
      }),
    );
    state.releaseMedia.mockRejectedValue(new Error('quota rollback response lost'));

    await runHarness(state, { waitFor: 'failure' });

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(state.jobs.abortEpisodeDelivery).toHaveBeenCalledOnce();
    expect(state.releaseMedia).toHaveBeenCalledOnce();
    expect(state.jobs.failEpisode.mock.calls[0]?.[4]).toBe(false);
    expect(state.jobs.failEpisode.mock.calls[0]?.[3]).toContain('quota rollback outcome unknown');
  });

  it('never attempts more than six media candidates', async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => directCandidate(index + 1));
    const state = harness({ candidates });
    mocks.probe.mockResolvedValue({});

    await runHarness(state, { waitFor: 'failure' });

    expect(MAX_ANIME_MEDIA_CANDIDATES).toBe(6);
    expect(mocks.download).toHaveBeenCalledTimes(MAX_ANIME_MEDIA_CANDIDATES);
    expect(state.jobs.failEpisode.mock.calls[0]?.[4]).toBe(true);
    expect(mocks.normalize).not.toHaveBeenCalled();
  });

  it('denies exhausted quota before resolving or downloading source media', async () => {
    const state = harness();
    state.canReserveMedia.mockResolvedValue({ allowed: false, reason: 'media' });

    await runHarness(state, { waitFor: 'failure' });

    expect(state.getEpisode).not.toHaveBeenCalled();
    expect(state.resolveMedia).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(state.jobs.failEpisode.mock.calls[0]?.[4]).toBe(false);
  });

  it('rechecks the HentaiSaturn NSFW policy at execution time', async () => {
    const row = episodeRow({
      id: 'series:ep-1',
      canonicalUrl: 'https://www.hentaisaturn.tv/episode/series/ep-1',
    });
    const state = harness({ job: archiveJob({ source: 'hentaisaturn', episodes: [row] }) });

    await runHarness(state, { media: { nsfwAllow: false }, waitFor: 'failure' });

    expect(state.canReserveMedia).not.toHaveBeenCalled();
    expect(state.getEpisode).not.toHaveBeenCalled();
    expect(state.jobs.failEpisode.mock.calls[0]?.[4]).toBe(false);
  });

  it('fails HLS closed when bubblewrap isolation is unavailable', async () => {
    const stream: AnimeMediaCandidate = {
      url: 'https://vixcloud.co/master.m3u8?token=secret',
      kind: 'stream',
      label: 'hls',
      requestHeaders: {},
    };
    const state = harness({ candidates: [stream] });

    await runHarness(state, {
      media: { ytdlpAvailable: true, bwrapBin: undefined },
      waitFor: 'failure',
    });

    expect(mocks.ytdlp).not.toHaveBeenCalled();
    expect(state.jobs.failEpisode.mock.calls[0]?.[4]).toBe(false);
  });

  it('rejects a just-in-time episode whose source identity changed', async () => {
    const state = harness();
    state.getEpisode.mockResolvedValue(
      resolvedEpisode(state.job, { ...state.row, id: 'different-episode' }),
    );

    await runHarness(state, { waitFor: 'failure' });

    expect(state.resolveMedia).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(state.jobs.failEpisode.mock.calls[0]?.[4]).toBe(false);
  });

  it('terminalizes untouched episodes after a fatal source-layout break', async () => {
    const pending = episodeRow({ id: 'episode-2', number: 2, order: 1, status: 'pending' });
    const state = harness({ job: archiveJob({ episodes: [episodeRow(), pending] }) });
    state.getEpisode.mockRejectedValue(
      new AnimeArchiveError('source_layout_changed', 'player layout changed'),
    );

    await runHarness(state, { waitFor: 'failure' });

    expect(state.jobs.failPendingEpisodes).toHaveBeenCalledWith(
      state.job.id,
      expect.stringMatching(/^archive-/),
      'player layout changed',
    );
    expect(state.jobs.claimNextEpisode).toHaveBeenCalledOnce();
    expect(state.jobs.finalizeJob).toHaveBeenCalledOnce();
  });

  it('does not lose a kick received while a drain is winding down', async () => {
    const state = harness();
    let resolveFirstClaim: ((job: null) => void) | undefined;
    state.jobs.claimNextJob.mockReset();
    state.jobs.claimNextJob
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            resolveFirstClaim = resolve;
          }),
      )
      .mockResolvedValueOnce(state.job)
      .mockResolvedValue(null);
    const worker = new AnimeArchiveWorker(
      archiveConfig(),
      mediaConfig(),
      state.storage,
      state.quota,
      state.registry,
    );
    workers.push(worker);
    worker.attachTelegramApi(state.api);
    await vi.waitFor(() => expect(state.jobs.claimNextJob).toHaveBeenCalledOnce());

    worker.kick();
    resolveFirstClaim?.(null);

    await vi.waitFor(() => expect(state.jobs.completeEpisode).toHaveBeenCalledOnce());
    expect(state.jobs.claimNextJob.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('sweeps only stale, dead process scratch directories', async () => {
    const stale = join(scratchRoot, 'run-2147483646-abcdefabcdef');
    const liveShape = join(scratchRoot, `run-${process.pid}-123456abcdef`);
    const unrelated = join(scratchRoot, 'operator-data');
    await Promise.all([mkdir(stale), mkdir(liveShape), mkdir(unrelated)]);
    await writeFile(join(stale, 'partial.mp4'), 'partial');
    const old = new Date(Date.now() - 60 * 60_000);
    await Promise.all([
      utimes(stale, old, old),
      utimes(liveShape, old, old),
      utimes(unrelated, old, old),
    ]);

    const state = harness();
    const worker = new AnimeArchiveWorker(
      archiveConfig({ enabled: false }),
      mediaConfig(),
      state.storage,
      state.quota,
      state.registry,
    );
    workers.push(worker);
    await worker.shutdown();

    await expect(access(stale)).rejects.toThrow();
    await expect(access(liveShape)).resolves.toBeUndefined();
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it('redelivers bounded terminal summaries after restart', async () => {
    const failedEpisodes = Array.from({ length: 40 }, (_, index) => ({
      id: `episode-${index}`,
      number: index + 1,
      reason: `failure ${index}: ${'detail '.repeat(80)}`,
    }));
    const terminal = archiveJob({
      state: 'partial',
      resumeCount: 2,
      summary: {
        total: 41,
        completed: 1,
        failed: 40,
        pending: 0,
        running: 0,
        skipped: 1,
        failedEpisodes,
      },
      finishedAt: new Date(),
    });
    const state = harness({ terminal: [terminal] });
    state.jobs.claimNextJob.mockResolvedValue(null);

    await runHarness(state, { waitFor: 'summary' });

    const text = String(state.sendMessage.mock.calls[0]?.[1]);
    expect([...text].length).toBeLessThanOrEqual(3_800);
    expect(text).toContain('Altri 28 episodi falliti');
    expect(state.notifications.claim).toHaveBeenCalledWith(
      'anime_archive',
      terminal.id,
      'partial:2',
      terminal.destination.chatId,
    );
    expect(buildFinalSummaryText(terminal)).toBe(text);
  });
});
