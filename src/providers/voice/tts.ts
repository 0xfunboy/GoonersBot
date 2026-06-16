import type { VoiceConfig } from '../../config/index.js';
import { toTelegramVoice } from './ffmpeg.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('tts');

/**
 * TTS provider: OpenAI-compatible `/v1/audio/speech` (Kokoro-FastAPI as used by airi-stack).
 * Synthesizes text, then transcodes to Telegram-ready OGG/Opus via ffmpeg. Degrades to null.
 */
/**
 * Per-language voice. Kokoro covers it/en/es (and more); no Russian voice exists, so it falls back
 * to the configured default. The chat's `/language` drives the selection.
 */
const VOICE_BY_LANGUAGE: Record<string, string> = {
  italian: 'im_nicola',
  english: 'am_michael',
  spanish: 'em_alex',
};

export class TtsProvider {
  constructor(private readonly cfg: VoiceConfig['tts']) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  private voiceFor(language?: string): string {
    return (language && VOICE_BY_LANGUAGE[language]) || this.cfg.voice;
  }

  /** Synthesize text → OGG/Opus voice-note Buffer, or null if disabled/failed/empty. */
  async synth(text: string, language?: string): Promise<Buffer | null> {
    if (!this.cfg.enabled || !this.cfg.baseUrl) return null;
    const input = sanitize(text).slice(0, this.cfg.maxChars);
    if (input.length === 0) return null;
    const voice = this.voiceFor(language);

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
          voice,
          response_format: this.cfg.format,
          speed: this.cfg.speed,
        }),
      });
      if (!res.ok) {
        log.warn({ status: res.status }, 'tts request failed');
        return null;
      }
      const audio = Buffer.from(await res.arrayBuffer());
      // OGG/Opus straight from the server is Telegram-ready: NO local ffmpeg needed (server-side
      // encoding). Other formats (wav/mp3) are transcoded locally to OGG/Opus.
      if (this.cfg.format === 'opus') {
        // Kokoro returns an empty (~header-only) opus on very short inputs; treat tiny output as failure.
        if (audio.length < 1024) {
          log.warn(
            { bytes: audio.length },
            'remote opus too small (short input?) — skipping voice',
          );
          return null;
        }
        return audio;
      }
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
