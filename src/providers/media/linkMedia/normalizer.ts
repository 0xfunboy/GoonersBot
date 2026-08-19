import { runProcess, runProcessChecked } from '../../../utils/process.js';
import { mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOCAL_INPUT_PROTOCOLS = ['-protocol_whitelist', 'file,pipe'] as const;

export interface NormalizeOptions {
  ffmpegBin: string;
  timeoutMs: number;
  maxUploadBytes: number;
  /** Optional codec/filter bound used only by the long-form archive profile. */
  threads?: number;
  signal?: AbortSignal;
}

export type AnimeVideoProfile = 'mobile' | 'source';

/** Explicit long-form settings. These do not alter the generic link-media defaults above. */
export interface NormalizeAnimeVideoOptions extends NormalizeOptions {
  profile: AnimeVideoProfile;
  maxHeight: number;
  crf: number;
  audioBitrateKbps: number;
  threads: number;
}

export interface AnimeVideoDecisionOptions {
  profile: AnimeVideoProfile;
  maxHeight: number;
  maxUploadBytes: number;
}

export type AnimeVideoPreparationAction = 'remux' | 'transcode';

export interface AnimeVideoNormalizationResult {
  action: AnimeVideoPreparationAction;
  sizeBytes: number;
  /** True when the final encode uses an explicit bitrate budget (directly or after CRF). */
  bitrateLimited: boolean;
}

export interface LosslessVideoPart {
  path: string;
  sizeBytes: number;
}

export interface LosslessVideoSplitResult {
  parts: LosslessVideoPart[];
  totalBytes: number;
  /** Number of stream-copy segmentation passes needed to satisfy the per-file upload ceiling. */
  attempts: number;
}

export class AnimeVideoOutputTooLargeError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`normalized anime video is ${actualBytes} bytes (maximum ${maxBytes})`);
    this.name = 'AnimeVideoOutputTooLargeError';
  }
}

async function run(
  bin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await runProcessChecked(bin, args, { timeoutMs, signal }, 'ffmpeg');
}

/** Transcode a downloaded local video to a Telegram-friendly H.264/AAC mp4. */
export async function normalizeVideo(
  input: string,
  output: string,
  opts: NormalizeOptions,
): Promise<void> {
  await transcodeVideo(input, output, opts, {
    scale: boundedScale(1280),
    qualityArgs: ['-crf', '28'],
    audioBitrate: 96_000,
  });

  const firstSize = await fileSize(output);
  if (firstSize <= opts.maxUploadBytes) return;

  // CRF controls visual quality rather than final bytes. If it overshoots Telegram's cap, compute a
  // bounded average bitrate from the real duration and retry at a smaller resolution. The margin
  // covers MP4/container overhead and one-pass encoder variance.
  const duration = (await probeVideo(opts.ffmpegBin, input, 15_000, opts.signal)).duration;
  if (!duration || duration <= 0) return;
  const totalBitrate = Math.max(
    128_000,
    Math.floor((opts.maxUploadBytes * 8 * 0.86) / Math.max(1, duration)),
  );
  const audioBitrate = totalBitrate >= 320_000 ? 80_000 : 48_000;
  const videoBitrate = Math.max(80_000, totalBitrate - audioBitrate);
  await transcodeVideo(input, output, opts, {
    scale: boundedScale(854),
    qualityArgs: [
      '-b:v',
      String(videoBitrate),
      '-maxrate',
      String(videoBitrate),
      '-bufsize',
      String(videoBitrate * 2),
    ],
    audioBitrate,
  });
}

interface VideoTranscodeSettings {
  scale: string;
  qualityArgs: string[];
  audioBitrate: number;
}

async function transcodeVideo(
  input: string,
  output: string,
  opts: NormalizeOptions,
  settings: VideoTranscodeSettings,
): Promise<void> {
  await run(
    opts.ffmpegBin,
    [
      '-y',
      ...(opts.threads === undefined
        ? []
        : ['-threads', String(opts.threads), '-filter_threads', String(opts.threads)]),
      ...LOCAL_INPUT_PROTOCOLS,
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      ...(opts.threads === undefined ? [] : ['-threads:v', String(opts.threads)]),
      '-preset',
      'veryfast',
      ...settings.qualityArgs,
      '-pix_fmt',
      'yuv420p',
      '-vf',
      settings.scale,
      '-c:a',
      'aac',
      '-b:a',
      String(settings.audioBitrate),
      '-movflags',
      '+faststart',
      output,
    ],
    opts.timeoutMs,
    opts.signal,
  );
}

function boundedHeightScale(maxHeight: number): string {
  // `-2` derives an even width. min(maxHeight,ih) prevents upscale; trunc also makes height even.
  return `scale=-2:'trunc(min(${maxHeight},ih)/2)*2'`;
}

function boundedScale(max: number): string {
  return `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

function assertAnimeOptions(opts: NormalizeAnimeVideoOptions): void {
  if (!Number.isSafeInteger(opts.maxHeight) || opts.maxHeight < 2) {
    throw new TypeError('anime maxHeight must be an integer of at least 2');
  }
  if (!Number.isFinite(opts.crf) || opts.crf < 0 || opts.crf > 51) {
    throw new TypeError('anime crf must be between 0 and 51');
  }
  if (!Number.isFinite(opts.audioBitrateKbps) || opts.audioBitrateKbps <= 0) {
    throw new TypeError('anime audioBitrateKbps must be positive');
  }
  if (!Number.isSafeInteger(opts.threads) || opts.threads < 1 || opts.threads > 4) {
    throw new TypeError('anime ffmpeg threads must be an integer between 1 and 4');
  }
  if (!Number.isSafeInteger(opts.maxUploadBytes) || opts.maxUploadBytes <= 0) {
    throw new TypeError('anime maxUploadBytes must be a positive integer');
  }
}

/**
 * Source mode may avoid a costly re-encode, but only when every property needed by Telegram and
 * the configured archive budget is known to be safe. Mobile mode intentionally produces a
 * consistent compact encode.
 */
export function decideAnimeVideoPreparation(
  probe: VideoProbe,
  inputBytes: number,
  opts: AnimeVideoDecisionOptions,
): AnimeVideoPreparationAction {
  if (opts.profile !== 'source') return 'transcode';
  if (!isTelegramCompatibleVideo(probe)) return 'transcode';
  if (!Number.isFinite(inputBytes) || inputBytes < 0 || inputBytes > opts.maxUploadBytes) {
    return 'transcode';
  }
  if (
    typeof probe.height !== 'number' ||
    !Number.isFinite(probe.height) ||
    probe.height <= 0 ||
    probe.height > opts.maxHeight
  ) {
    return 'transcode';
  }
  return 'remux';
}

async function remuxCopyFaststart(
  input: string,
  output: string,
  opts: NormalizeOptions,
): Promise<void> {
  await run(
    opts.ffmpegBin,
    ['-y', ...LOCAL_INPUT_PROTOCOLS, '-i', input, '-c', 'copy', '-movflags', '+faststart', output],
    opts.timeoutMs,
    opts.signal,
  );
}

async function transcodeAnimeVideo(
  input: string,
  output: string,
  opts: NormalizeAnimeVideoOptions,
  qualityArgs: string[],
  audioBitrate: number,
  maxHeight = opts.maxHeight,
): Promise<void> {
  await transcodeVideo(input, output, opts, {
    scale: boundedHeightScale(Math.floor(maxHeight / 2) * 2),
    qualityArgs,
    audioBitrate,
  });
}

async function animeBitrateRetry(
  input: string,
  output: string,
  opts: NormalizeAnimeVideoOptions,
  probe: VideoProbe,
): Promise<number> {
  const duration = probe.duration;
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    throw new AnimeVideoOutputTooLargeError(await fileSize(output), opts.maxUploadBytes);
  }

  // Leave headroom for MP4 overhead and one-pass encoder variance. The configured audio bitrate is
  // an upper bound on this constrained pass so unusually small budgets still prioritize the video.
  const totalBitrate = Math.floor((opts.maxUploadBytes * 8 * 0.86) / Math.max(1, duration));
  const configuredAudioBitrate = Math.round(opts.audioBitrateKbps * 1_000);
  const audioFloor = Math.min(configuredAudioBitrate, 32_000);
  const audioBitrate = Math.min(
    configuredAudioBitrate,
    Math.max(audioFloor, Math.floor(totalBitrate * 0.25)),
  );
  const videoBitrate = totalBitrate - audioBitrate;
  if (videoBitrate < 64_000) {
    throw new AnimeVideoOutputTooLargeError(await fileSize(output), opts.maxUploadBytes);
  }

  await transcodeAnimeVideo(
    input,
    output,
    opts,
    [
      '-b:v',
      String(videoBitrate),
      '-maxrate',
      String(videoBitrate),
      '-bufsize',
      String(videoBitrate * 2),
    ],
    audioBitrate,
    constrainedAnimeHeight(videoBitrate, opts.maxHeight),
  );
  return fileSize(output);
}

/** Skip a predictably oversized CRF pass for long episodes whose source bitrate dwarfs the cap. */
export function shouldStartWithBitrateLimitedAnimeEncode(
  inputBytes: number,
  probe: VideoProbe,
  maxUploadBytes: number,
): boolean {
  if (!probe.duration || !Number.isFinite(probe.duration) || probe.duration <= 0) return false;
  if (!Number.isFinite(inputBytes) || inputBytes <= maxUploadBytes * 1.35) return false;
  const sourceBitrate = (inputBytes * 8) / probe.duration;
  const uploadBitrate = (maxUploadBytes * 8 * 0.86) / probe.duration;
  return sourceBitrate > uploadBitrate * 1.35;
}

function constrainedAnimeHeight(videoBitrate: number, configuredMaxHeight: number): number {
  const bitrateHeight = videoBitrate < 120_000 ? 360 : videoBitrate < 240_000 ? 480 : 720;
  return Math.max(2, Math.min(configuredMaxHeight, bitrateHeight));
}

/**
 * Prepare a long-form episode as a bounded, phone-friendly MP4.
 *
 * The optional source probe lets the archive worker reuse the probe it already performed for its
 * duration ceiling. When omitted, this function probes once itself.
 */
export async function normalizeAnimeVideo(
  input: string,
  output: string,
  opts: NormalizeAnimeVideoOptions,
  sourceProbe?: VideoProbe,
): Promise<AnimeVideoNormalizationResult> {
  assertAnimeOptions(opts);
  const [inputBytes, probe] = await Promise.all([
    fileSize(input),
    sourceProbe
      ? Promise.resolve(sourceProbe)
      : probeVideo(opts.ffmpegBin, input, 15_000, opts.signal),
  ]);
  const decision = decideAnimeVideoPreparation(probe, inputBytes, opts);

  if (decision === 'remux') {
    try {
      await remuxCopyFaststart(input, output, opts);
      const sizeBytes = await fileSize(output);
      if (sizeBytes <= opts.maxUploadBytes) {
        return { action: 'remux', sizeBytes, bitrateLimited: false };
      }
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      // A stream-copy/container failure is recoverable through the bounded anime transcode below.
    }
  }

  if (shouldStartWithBitrateLimitedAnimeEncode(inputBytes, probe, opts.maxUploadBytes)) {
    const finalSize = await animeBitrateRetry(input, output, opts, probe);
    if (finalSize > opts.maxUploadBytes) {
      throw new AnimeVideoOutputTooLargeError(finalSize, opts.maxUploadBytes);
    }
    return { action: 'transcode', sizeBytes: finalSize, bitrateLimited: true };
  }

  const configuredAudioBitrate = Math.round(opts.audioBitrateKbps * 1_000);
  await transcodeAnimeVideo(
    input,
    output,
    opts,
    ['-crf', String(opts.crf)],
    configuredAudioBitrate,
  );
  const firstSize = await fileSize(output);
  if (firstSize <= opts.maxUploadBytes) {
    return { action: 'transcode', sizeBytes: firstSize, bitrateLimited: false };
  }

  const finalSize = await animeBitrateRetry(input, output, opts, probe);
  if (finalSize > opts.maxUploadBytes) {
    throw new AnimeVideoOutputTooLargeError(finalSize, opts.maxUploadBytes);
  }
  return { action: 'transcode', sizeBytes: finalSize, bitrateLimited: true };
}

const LOSSLESS_SPLIT_TARGET_RATIO = 0.72;
const LOSSLESS_SPLIT_MAX_ATTEMPTS = 6;
const LOSSLESS_SPLIT_MAX_PARTS = 64;

/**
 * Split an oversized local video into Telegram-sized MP4 parts without re-encoding either stream.
 *
 * This exists for archive sources whose original episode is already good quality but exceeds the
 * hosted Bot API's per-file ceiling. ffmpeg's segment muxer rewrites only container boundaries;
 * `-c copy` preserves the encoded video/audio bitstreams byte-for-byte between cut points.
 */
export async function splitVideoLosslessly(
  input: string,
  outputDir: string,
  opts: Pick<NormalizeOptions, 'ffmpegBin' | 'timeoutMs' | 'maxUploadBytes' | 'signal'>,
  sourceProbe?: VideoProbe,
): Promise<LosslessVideoSplitResult> {
  if (!Number.isSafeInteger(opts.maxUploadBytes) || opts.maxUploadBytes <= 0) {
    throw new TypeError('lossless split maxUploadBytes must be a positive integer');
  }
  const [inputBytes, probe] = await Promise.all([
    fileSize(input),
    sourceProbe
      ? Promise.resolve(sourceProbe)
      : probeVideo(opts.ffmpegBin, input, 15_000, opts.signal),
  ]);
  if (!Number.isFinite(inputBytes) || inputBytes <= 0) {
    throw new AnimeVideoOutputTooLargeError(inputBytes, opts.maxUploadBytes);
  }
  if (inputBytes <= opts.maxUploadBytes) {
    return { parts: [{ path: input, sizeBytes: inputBytes }], totalBytes: inputBytes, attempts: 0 };
  }
  const duration = probe.duration;
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    throw new AnimeVideoOutputTooLargeError(inputBytes, opts.maxUploadBytes);
  }

  await mkdir(outputDir, { recursive: true });
  const targetBytes = Math.max(1, Math.floor(opts.maxUploadBytes * LOSSLESS_SPLIT_TARGET_RATIO));
  let segmentSeconds = Math.max(1, (duration * targetBytes) / inputBytes);

  for (let attempt = 1; attempt <= LOSSLESS_SPLIT_MAX_ATTEMPTS; attempt += 1) {
    await clearLosslessParts(outputDir);
    const pattern = join(outputDir, 'part-%03d.mp4');
    await run(
      opts.ffmpegBin,
      [
        '-y',
        ...LOCAL_INPUT_PROTOCOLS,
        '-i',
        input,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-f',
        'segment',
        '-segment_time',
        segmentSeconds.toFixed(3),
        '-reset_timestamps',
        '1',
        '-segment_format',
        'mp4',
        '-segment_format_options',
        'movflags=+faststart',
        pattern,
      ],
      opts.timeoutMs,
      opts.signal,
    );
    const paths = (await readdir(outputDir))
      .filter((name) => /^part-\d+\.mp4$/u.test(name))
      .sort()
      .map((name) => join(outputDir, name));
    if (paths.length === 0 || paths.length > LOSSLESS_SPLIT_MAX_PARTS) {
      throw new AnimeVideoOutputTooLargeError(inputBytes, opts.maxUploadBytes);
    }
    const parts = await Promise.all(
      paths.map(async (path) => ({ path, sizeBytes: await fileSize(path) })),
    );
    const largest = Math.max(...parts.map((part) => part.sizeBytes));
    if (parts.every((part) => part.sizeBytes > 0 && part.sizeBytes <= opts.maxUploadBytes)) {
      return {
        parts,
        totalBytes: parts.reduce((sum, part) => sum + part.sizeBytes, 0),
        attempts: attempt,
      };
    }

    // Segment boundaries land on nearby keyframes, so size is approximate. Scale the next segment
    // duration from the observed worst part and keep extra headroom rather than ever transcoding.
    const observedScale = largest > 0 ? (opts.maxUploadBytes / largest) * 0.82 : 0.5;
    segmentSeconds = Math.max(1, segmentSeconds * Math.min(0.82, observedScale));
  }

  const leftovers = await losslessPartSizes(outputDir);
  throw new AnimeVideoOutputTooLargeError(
    leftovers.length ? Math.max(...leftovers) : inputBytes,
    opts.maxUploadBytes,
  );
}

async function clearLosslessParts(outputDir: string): Promise<void> {
  const names = await readdir(outputDir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => /^part-\d+\.mp4$/u.test(name))
      .map((name) => rm(join(outputDir, name), { force: true })),
  );
}

async function losslessPartSizes(outputDir: string): Promise<number[]> {
  const names = await readdir(outputDir).catch(() => [] as string[]);
  return Promise.all(
    names
      .filter((name) => /^part-\d+\.mp4$/u.test(name))
      .map((name) => fileSize(join(outputDir, name))),
  );
}

async function fileSize(path: string): Promise<number> {
  return stat(path)
    .then((entry) => entry.size)
    .catch(() => Number.POSITIVE_INFINITY);
}

/** Convert a GIF to a muted, looping-friendly mp4 (Telegram animation). */
export async function normalizeGifAsMp4(
  input: string,
  output: string,
  opts: NormalizeOptions,
): Promise<void> {
  await run(
    opts.ffmpegBin,
    [
      '-y',
      ...LOCAL_INPUT_PROTOCOLS,
      '-i',
      input,
      '-an',
      '-movflags',
      '+faststart',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=min(720\\,iw):-2,fps=24',
      output,
    ],
    opts.timeoutMs,
    opts.signal,
  );
}

export async function normalizeAudio(
  input: string,
  output: string,
  opts: NormalizeOptions,
): Promise<void> {
  await run(
    opts.ffmpegBin,
    [
      '-y',
      ...LOCAL_INPUT_PROTOCOLS,
      '-i',
      input,
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      output,
    ],
    opts.timeoutMs,
    opts.signal,
  );
}

/** Derive the ffprobe path from the ffmpeg path (same directory/suffix). */
function ffprobeOf(ffmpegBin: string): string {
  return ffmpegBin.replace(/ffmpeg(\.[^./]*)?$/, 'ffprobe$1');
}

/**
 * Remux an mp4 in place to put the moov atom at the front (+faststart) WITHOUT re-encoding, so
 * Telegram can stream it inline (preview + autoplay). Falls back to a re-encode if stream-copy fails.
 */
export async function remuxFaststart(
  input: string,
  output: string,
  opts: NormalizeOptions,
): Promise<void> {
  try {
    await remuxCopyFaststart(input, output, opts);
  } catch {
    if (opts.signal?.aborted) throw opts.signal.reason;
    await normalizeVideo(input, output, opts);
  }
}

export interface VideoProbe {
  width?: number;
  height?: number;
  duration?: number;
  videoCodec?: string;
  audioCodec?: string;
  pixelFormat?: string;
}

/** Telegram's inline player is consistently reliable for H.264/yuv420p video with AAC (or no audio). */
export function isTelegramCompatibleVideo(probe: VideoProbe): boolean {
  return (
    probe.videoCodec === 'h264' &&
    (!probe.pixelFormat || probe.pixelFormat === 'yuv420p' || probe.pixelFormat === 'yuvj420p') &&
    (!probe.audioCodec || probe.audioCodec === 'aac')
  );
}

/** Best-effort width/height/duration via ffprobe (resolves {} on any failure). */
export async function probeVideo(
  ffmpegBin: string,
  input: string,
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<VideoProbe> {
  try {
    const r = await runProcess(
      ffprobeOf(ffmpegBin),
      [
        '-v',
        'error',
        ...LOCAL_INPUT_PROTOCOLS,
        '-show_entries',
        'stream=codec_type,codec_name,width,height,pix_fmt:format=duration',
        '-of',
        'json',
        input,
      ],
      { timeoutMs, collectStdout: true, signal },
    );
    const j = JSON.parse(r.stdout.toString()) as {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        pix_fmt?: string;
      }>;
      format?: { duration?: string };
    };
    const s = j.streams?.find((stream) => stream.codec_type === 'video') ?? {};
    const audio = j.streams?.find((stream) => stream.codec_type === 'audio');
    const dur = j.format?.duration ? Math.round(Number(j.format.duration)) : undefined;
    const probe: VideoProbe = {};
    if (typeof s.width === 'number') probe.width = s.width;
    if (typeof s.height === 'number') probe.height = s.height;
    if (typeof s.codec_name === 'string') probe.videoCodec = s.codec_name;
    if (typeof s.pix_fmt === 'string') probe.pixelFormat = s.pix_fmt;
    if (typeof audio?.codec_name === 'string') probe.audioCodec = audio.codec_name;
    if (dur && Number.isFinite(dur)) probe.duration = dur;
    return probe;
  } catch {
    return {};
  }
}

/** Extract a small JPEG poster (<=320px) for the Telegram video thumbnail; resolves false on failure. */
export async function videoThumbnail(
  ffmpegBin: string,
  input: string,
  output: string,
  timeoutMs = 20000,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    // the `thumbnail` filter picks a representative (non-black) frame instead of the first one
    const r = await runProcess(
      ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...LOCAL_INPUT_PROTOCOLS,
        '-i',
        input,
        '-vf',
        `thumbnail,${boundedScale(320)}`,
        '-frames:v',
        '1',
        output,
      ],
      { timeoutMs, signal },
    );
    if (r.code !== 0) return false;
    const size = await fileSize(output);
    if (size > 200 * 1024) {
      await unlink(output).catch(() => undefined);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
