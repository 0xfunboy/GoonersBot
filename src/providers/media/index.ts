import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { childLogger } from '../../utils/logger.js';
import type { ImageResult, LLMProvider } from '../llm/types.js';
import type { SttProvider } from '../voice/stt.js';
import { extractVideoFrame } from '../voice/ffmpeg.js';

const log = childLogger('media');

export interface FfmpegConfig {
  bin: string;
  available: boolean;
  timeoutMs: number;
}

/**
 * MediaProcessor routes media through the active providers. Voice transcription prefers the local
 * whisper.cpp STT provider when enabled, falling back to the LLM provider's transcription endpoint.
 * Every method degrades gracefully (returns null + logs) so one missing capability never crashes.
 */
export class MediaProcessor {
  constructor(
    private readonly llm: LLMProvider,
    private readonly stt?: SttProvider,
    private readonly ffmpeg?: FfmpegConfig,
  ) {}

  get canDescribeImage(): boolean {
    return this.llm.capabilities.vision && typeof this.llm.visionCompletion === 'function';
  }

  /** True if we can turn a video into a still frame for vision. */
  get canFrameVideo(): boolean {
    return Boolean(this.ffmpeg?.available);
  }

  /**
   * Extract one representative still frame (JPEG) from a video so it can be fed to the vision
   * model. Returns null when ffmpeg is unavailable or extraction fails.
   */
  async frameFromVideo(video: Buffer): Promise<Buffer | null> {
    if (!this.ffmpeg?.available) return null;
    const tmp = join(tmpdir(), `gb-frame-${randomBytes(6).toString('hex')}.bin`);
    try {
      await writeFile(tmp, video);
      const frame = await extractVideoFrame(this.ffmpeg.bin, tmp, this.ffmpeg.timeoutMs);
      return frame.length > 64 ? frame : null;
    } catch (err) {
      log.warn({ err }, 'video frame extraction failed');
      return null;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  get canTranscribe(): boolean {
    return (
      Boolean(this.stt?.enabled) ||
      (this.llm.capabilities.transcription && typeof this.llm.transcribeAudio === 'function')
    );
  }

  get canGenerateImage(): boolean {
    return this.llm.capabilities.imageGeneration && typeof this.llm.generateImage === 'function';
  }

  /** Describe an image; returns null when vision is unavailable. Retries once if the model is flaky. */
  async describeImage(buffer: Buffer, mime: string): Promise<string | null> {
    if (!this.canDescribeImage || !this.llm.visionCompletion) {
      log.info('vision capability unavailable - skipping image description');
      return null;
    }
    const imageBase64 = buffer.toString('base64');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.llm.visionCompletion({
          prompt:
            'Describe what is actually in this image for chat context: the main subject, who/what ' +
            'it is, the setting, and anything notable. 1-2 sentences, concrete, no refusals.',
          imageBase64,
          imageMime: mime,
          maxTokens: 220,
        });
        const desc = result.text.trim();
        if (desc) return desc;
        log.warn({ attempt }, 'image description empty, retrying');
      } catch (err) {
        log.warn({ err, attempt }, 'image description failed');
      }
    }
    return null;
  }

  /**
   * Identify the main subject of an image for reverse-image grounding: name the specific
   * person/character/product/brand if recognizable, plus a few search keywords. Returns a short
   * line suitable as a web-search query, or null when vision is unavailable/fails.
   */
  async identifyImage(buffer: Buffer, mime: string): Promise<string | null> {
    if (!this.canDescribeImage || !this.llm.visionCompletion) return null;
    try {
      const result = await this.llm.visionCompletion({
        prompt:
          'Identify the MAIN subject of this image as precisely as possible. If it is a known ' +
          'person, fictional/anime character, brand, product or place, give its specific name. ' +
          'Reply with ONLY a short search query (name + 2-4 keywords), no sentences, no preamble.',
        imageBase64: buffer.toString('base64'),
        imageMime: mime,
        maxTokens: 60,
      });
      const line = result.text.replace(/\s+/g, ' ').trim();
      return line.length > 1 ? line.slice(0, 120) : null;
    } catch (err) {
      log.warn({ err }, 'image identification failed');
      return null;
    }
  }

  /** Transcribe a voice message; prefers local whisper.cpp, then the LLM provider. */
  async transcribeVoice(
    buffer: Buffer,
    mime: string,
    opts: { fileName?: string; language?: string } = {},
  ): Promise<string | null> {
    if (this.stt?.enabled) {
      const local = await this.stt.transcribe(buffer, opts.language);
      if (local !== null) return local;
    }
    if (!this.llm.capabilities.transcription || typeof this.llm.transcribeAudio !== 'function') {
      log.info('transcription capability unavailable - skipping voice transcription');
      return null;
    }
    try {
      const req: { audio: Buffer; mime: string; fileName?: string } = { audio: buffer, mime };
      if (opts.fileName !== undefined) req.fileName = opts.fileName;
      const text = await this.llm.transcribeAudio(req);
      return text.trim() || null;
    } catch (err) {
      log.warn({ err }, 'voice transcription failed');
      return null;
    }
  }

  /** Generate an image; returns null when generation is unavailable or fails. */
  async generateImage(prompt: string): Promise<ImageResult | null> {
    if (!this.canGenerateImage || !this.llm.generateImage) {
      log.info('image generation capability unavailable - skipping');
      return null;
    }
    try {
      return await this.llm.generateImage({ prompt });
    } catch (err) {
      log.warn({ err }, 'image generation failed');
      return null;
    }
  }
}
