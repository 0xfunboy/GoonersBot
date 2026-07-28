import { runProcess, runProcessChecked } from '../../../utils/process.js';

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
      '-crf',
      '28',
      '-vf',
      'scale=min(1280\\,iw):-2',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      output,
    ],
    opts.timeoutMs,
    opts.signal,
  );
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
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        input,
      ],
      { timeoutMs, collectStdout: true, signal },
    );
    const j = JSON.parse(r.stdout.toString()) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const s = j.streams?.[0] ?? {};
    const dur = j.format?.duration ? Math.round(Number(j.format.duration)) : undefined;
    const probe: VideoProbe = {};
    if (typeof s.width === 'number') probe.width = s.width;
    if (typeof s.height === 'number') probe.height = s.height;
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
        "thumbnail,scale='min(320,iw)':-2",
        '-frames:v',
        '1',
        output,
      ],
      { timeoutMs, signal },
    );
    return r.code === 0;
  } catch {
    return false;
  }
}
