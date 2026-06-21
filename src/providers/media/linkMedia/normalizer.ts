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
