import type { VoiceConfig } from '../../config/index.js';
import { toTelegramVoice } from './ffmpeg.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('tts');

/**
 * TTS provider: OpenAI-compatible `/v1/audio/speech` (Kokoro-FastAPI as used by airi-stack).
 * Synthesizes text, then transcodes to Telegram-ready OGG/Opus via ffmpeg. Degrades to null.
 */
export class TtsProvider {
  constructor(private readonly cfg: VoiceConfig['tts']) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Synthesize text → OGG/Opus voice-note Buffer, or null if disabled/failed/empty. */
  async synth(text: string): Promise<Buffer | null> {
    if (!this.cfg.enabled || !this.cfg.baseUrl) return null;
    const input = sanitize(text).slice(0, this.cfg.maxChars);
    if (input.length === 0) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.cfg.apiKey) headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;
      const res = await fetch(`${this.cfg.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.cfg.model,
          input,
          voice: this.cfg.voice,
          response_format: this.cfg.format,
          speed: this.cfg.speed,
        }),
      });
      if (!res.ok) {
        log.warn({ status: res.status }, 'tts request failed');
        return null;
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length < 64) return null;
      return await toTelegramVoice(this.cfg.ffmpegBin, audio, this.cfg.timeoutMs);
    } catch (err) {
      log.warn({ err }, 'tts synth failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Strip markup/emojis-heavy noise that TTS reads badly; keep it speakable. */
function sanitize(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
