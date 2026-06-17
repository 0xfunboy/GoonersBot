import { spawn } from 'node:child_process';

/**
 * Run ffmpeg with a Buffer on stdin and collect a Buffer from stdout.
 * Used to transcode TTS audio → Telegram OGG/Opus and incoming voice → 16 kHz WAV for whisper.
 */
export function runFfmpeg(
  bin: string,
  args: string[],
  input: Buffer,
  timeoutMs = 30000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`));
    });

    child.stdin.on('error', () => undefined); // ignore EPIPE if ffmpeg closes early
    child.stdin.write(input);
    child.stdin.end();
  });
}

export interface TelegramVoiceOptions {
  timeoutMs?: number;
  tailPaddingMs?: number;
}

/** Transcode arbitrary audio bytes → Telegram-ready OGG/Opus (48 kHz mono). */
export function toTelegramVoice(
  bin: string,
  input: Buffer,
  opts: TelegramVoiceOptions | number = {},
): Promise<Buffer> {
  const timeoutMs = typeof opts === 'number' ? opts : (opts.timeoutMs ?? 30000);
  const tailPaddingMs = typeof opts === 'number' ? 0 : Math.max(0, opts.tailPaddingMs ?? 0);
  const filterArgs =
    tailPaddingMs > 0 ? ['-af', `apad=pad_dur=${(tailPaddingMs / 1000).toFixed(3)}`] : [];
  return runFfmpeg(
    bin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      ...filterArgs,
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-f',
      'ogg',
      'pipe:1',
    ],
    input,
    timeoutMs,
  );
}

const WHISPER_WAV_ARGS = ['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'];

/** Transcode arbitrary audio bytes (from stdin) → 16 kHz mono PCM WAV (whisper.cpp input). */
export function toWhisperWav(bin: string, input: Buffer, timeoutMs = 30000): Promise<Buffer> {
  return runFfmpeg(
    bin,
    ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...WHISPER_WAV_ARGS],
    input,
    timeoutMs,
  );
}

/**
 * Extract one representative frame from a video FILE → JPEG bytes (for vision). The `thumbnail`
 * filter picks the most representative frame from the opening of the clip; reading from a seekable
 * file handles MP4 containers. Frame is downscaled to keep the vision payload small.
 */
export function extractVideoFrame(
  bin: string,
  inputPath: string,
  timeoutMs = 30000,
): Promise<Buffer> {
  return runFfmpeg(
    bin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vf',
      "thumbnail,scale='min(1024,iw)':-2",
      '-frames:v',
      '1',
      '-f',
      'mjpeg',
      'pipe:1',
    ],
    Buffer.alloc(0),
    timeoutMs,
  );
}

/**
 * Decode a media FILE → 16 kHz mono PCM WAV. Reading from a seekable file (not a pipe) is required
 * for containers like MP4 whose moov atom sits at the end (videos / video-notes / audio files).
 * ffmpeg auto-detects the format and extracts the audio track regardless of container.
 */
export function decodeFileToWhisperWav(
  bin: string,
  inputPath: string,
  timeoutMs = 30000,
): Promise<Buffer> {
  return runFfmpeg(
    bin,
    ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-vn', ...WHISPER_WAV_ARGS],
    Buffer.alloc(0),
    timeoutMs,
  );
}
