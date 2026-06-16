import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { VoiceConfig } from '../../config/index.js';
import { decodeFileToWhisperWav } from './ffmpeg.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('stt');

const WHISPER_CODE: Record<string, string> = {
  italian: 'it',
  english: 'en',
  russian: 'ru',
  spanish: 'es',
};

/** Map a chat language NAME to a whisper code; unknown/undefined → 'auto'. */
export function langNameToWhisper(name?: string): string {
  return (name && WHISPER_CODE[name]) || 'auto';
}

/**
 * STT provider: local whisper.cpp (whisper-cli). Converts incoming audio → 16 kHz WAV via ffmpeg,
 * runs whisper-cli, returns the transcript. Fully local, no network, modest CPU. Degrades to null.
 */
export class SttProvider {
  constructor(private readonly cfg: VoiceConfig['stt']) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** `language` is a chat language NAME (italian/english/…); mapped to a whisper code or 'auto'. */
  async transcribe(audio: Buffer, language?: string): Promise<string | null> {
    if (!this.cfg.enabled) return null;
    // Write the raw media to a seekable temp file first: voice notes (ogg) decode fine from a pipe,
    // but videos/audio files (mp4 with a trailing moov atom) need ffmpeg to seek. Decode from path.
    const stem = randomBytes(6).toString('hex');
    const src = join(tmpdir(), `gb-stt-${stem}.src`);
    const wavPath = join(tmpdir(), `gb-stt-${stem}.wav`);
    try {
      await writeFile(src, audio);
      const wav = await decodeFileToWhisperWav(this.cfg.ffmpegBin, src, this.cfg.timeoutMs);
      await writeFile(wavPath, wav);
      const text = await this.runWhisper(wavPath, this.resolveLang(language));
      const clean = text.trim();
      return clean.length > 0 ? clean : null;
    } catch (err) {
      log.warn({ err }, 'stt transcription failed');
      return null;
    } finally {
      await unlink(src).catch(() => undefined);
      await unlink(wavPath).catch(() => undefined);
    }
  }

  /** A fixed STT_LANGUAGE wins; otherwise use the chat-language hint; otherwise auto-detect. */
  private resolveLang(hint?: string): string {
    if (this.cfg.language && this.cfg.language !== 'auto') return this.cfg.language;
    return langNameToWhisper(hint);
  }

  private runWhisper(wavPath: string, lang: string): Promise<string> {
    const args = [
      '-m',
      this.cfg.whisperModel,
      '-f',
      wavPath,
      '-l',
      lang,
      '-t',
      String(this.cfg.threads),
      '-np', // no progress prints
      '-nt', // no timestamps
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.whisperBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('whisper timed out'));
      }, this.cfg.timeoutMs);
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`whisper exited ${code}: ${err.slice(-300)}`));
      });
    });
  }
}
