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

/** Transcode arbitrary audio bytes → Telegram-ready OGG/Opus (48 kHz mono). */
export function toTelegramVoice(bin: string, input: Buffer, timeoutMs = 30000): Promise<Buffer> {
  return runFfmpeg(
    bin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
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

/** Transcode arbitrary audio bytes → 16 kHz mono PCM WAV (whisper.cpp input). */
export function toWhisperWav(bin: string, input: Buffer, timeoutMs = 30000): Promise<Buffer> {
  return runFfmpeg(
    bin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      'pipe:1',
    ],
    input,
    timeoutMs,
  );
}
