import { spawn } from 'node:child_process';

export interface NormalizeOptions {
  ffmpegBin: string;
  timeoutMs: number;
  maxUploadBytes: number;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg timeout'));
    }, timeoutMs);
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`));
    });
  });
}

/** Transcode any video (file or HLS/DASH manifest URL) to a Telegram-friendly H.264/AAC mp4. */
export async function normalizeVideo(input: string, output: string, opts: NormalizeOptions): Promise<void> {
  await run(
    opts.ffmpegBin,
    [
      '-y',
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
  );
}

/** Convert a GIF to a muted, looping-friendly mp4 (Telegram animation). */
export async function normalizeGifAsMp4(input: string, output: string, opts: NormalizeOptions): Promise<void> {
  await run(
    opts.ffmpegBin,
    [
      '-y',
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
  );
}

export async function normalizeAudio(input: string, output: string, opts: NormalizeOptions): Promise<void> {
  await run(opts.ffmpegBin, ['-y', '-i', input, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', output], opts.timeoutMs);
}

/** Derive the ffprobe path from the ffmpeg path (same directory/suffix). */
function ffprobeOf(ffmpegBin: string): string {
  return ffmpegBin.replace(/ffmpeg(\.[^./]*)?$/, 'ffprobe$1');
}

/**
 * Remux an mp4 in place to put the moov atom at the front (+faststart) WITHOUT re-encoding, so
 * Telegram can stream it inline (preview + autoplay). Falls back to a re-encode if stream-copy fails.
 */
export async function remuxFaststart(input: string, output: string, opts: NormalizeOptions): Promise<void> {
  try {
    await run(opts.ffmpegBin, ['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output], opts.timeoutMs);
  } catch {
    await normalizeVideo(input, output, opts);
  }
}

export interface VideoProbe {
  width?: number;
  height?: number;
  duration?: number;
}

/** Best-effort width/height/duration via ffprobe (resolves {} on any failure). */
export function probeVideo(ffmpegBin: string, input: string, timeoutMs = 15000): Promise<VideoProbe> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobeOf(ffmpegBin),
      [
        '-v',
        'error',
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
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({});
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
        const s = j.streams?.[0] ?? {};
        const dur = j.format?.duration ? Math.round(Number(j.format.duration)) : undefined;
        const probe: VideoProbe = {};
        if (typeof s.width === 'number') probe.width = s.width;
        if (typeof s.height === 'number') probe.height = s.height;
        if (dur && Number.isFinite(dur)) probe.duration = dur;
        resolve(probe);
      } catch {
        resolve({});
      }
    });
  });
}

/** Extract a small JPEG poster (<=320px) for the Telegram video thumbnail; resolves false on failure. */
export function videoThumbnail(ffmpegBin: string, input: string, output: string, timeoutMs = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegBin,
      // the `thumbnail` filter picks a representative (non-black) frame instead of the first one
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', "thumbnail,scale='min(320,iw)':-2", '-frames:v', '1', output],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
