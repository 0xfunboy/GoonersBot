import { runProcessChecked } from '../../utils/process.js';

/**
 * Run ffmpeg with a Buffer on stdin and collect a Buffer from stdout.
 * Used to transcode TTS audio → Telegram OGG/Opus and incoming voice → 16 kHz WAV for whisper.
 */
export async function runFfmpeg(
  bin: string,
  args: string[],
  input: Buffer,
  timeoutMs = 30000,
): Promise<Buffer> {
  const r = await runProcessChecked(bin, args, { timeoutMs, input, collectStdout: true }, 'ffmpeg');
  return r.stdout;
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

export interface FileVoiceOptions {
  /** hard cap on output duration in seconds (longer input is truncated) */
  maxDurationSec?: number;
  timeoutMs?: number;
  /** opus bitrate (music wants more than the 32k used for speech) */
  bitrate?: string;
}

/**
 * Transcode an audio FILE (any container yt-dlp produced) → Telegram-ready OGG/Opus (48 kHz mono),
 * optionally truncated to `maxDurationSec`. Reading from a seekable file handles every container.
 */
export function fileToTelegramVoice(
  bin: string,
  inputPath: string,
  opts: FileVoiceOptions = {},
): Promise<Buffer> {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-vn'];
  if (opts.maxDurationSec && opts.maxDurationSec > 0) args.push('-t', String(opts.maxDurationSec));
  args.push(
    '-c:a',
    'libopus',
    '-b:a',
    opts.bitrate ?? '48k',
    '-ar',
    '48000',
    '-ac',
    '1',
    '-f',
    'ogg',
    'pipe:1',
  );
  return runFfmpeg(bin, args, Buffer.alloc(0), opts.timeoutMs ?? 60000);
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
