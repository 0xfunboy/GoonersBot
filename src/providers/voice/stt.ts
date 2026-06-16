import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { VoiceConfig } from '../../config/index.js';
import { toWhisperWav } from './ffmpeg.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('stt');

/**
 * STT provider: local whisper.cpp (whisper-cli). Converts incoming audio → 16 kHz WAV via ffmpeg,
 * runs whisper-cli, returns the transcript. Fully local, no network, modest CPU. Degrades to null.
 */
export class SttProvider {
  constructor(private readonly cfg: VoiceConfig['stt']) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  async transcribe(audio: Buffer): Promise<string | null> {
    if (!this.cfg.enabled) return null;
    let wav: Buffer;
    try {
      wav = await toWhisperWav(this.cfg.ffmpegBin, audio, this.cfg.timeoutMs);
    } catch (err) {
      log.warn({ err }, 'ffmpeg decode failed');
      return null;
    }
    const tmp = join(tmpdir(), `gb-stt-${randomBytes(6).toString('hex')}.wav`);
    try {
      await writeFile(tmp, wav);
      const text = await this.runWhisper(tmp);
      const clean = text.trim();
      return clean.length > 0 ? clean : null;
    } catch (err) {
      log.warn({ err }, 'whisper transcription failed');
      return null;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  private runWhisper(wavPath: string): Promise<string> {
    const args = [
      '-m',
      this.cfg.whisperModel,
      '-f',
      wavPath,
      '-l',
      this.cfg.language,
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
