import { runProcess, runProcessChecked } from '../../../utils/process.js';
import { stat, unlink } from 'node:fs/promises';

const LOCAL_INPUT_PROTOCOLS = ['-protocol_whitelist', 'file,pipe'] as const;

export interface NormalizeOptions {
  ffmpegBin: string;
  timeoutMs: number;
  maxUploadBytes: number;
  signal?: AbortSignal;
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
      ...LOCAL_INPUT_PROTOCOLS,
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
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

function boundedScale(max: number): string {
  return `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
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
    await run(
      opts.ffmpegBin,
      [
        '-y',
        ...LOCAL_INPUT_PROTOCOLS,
        '-i',
        input,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        output,
      ],
      opts.timeoutMs,
      opts.signal,
    );
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
