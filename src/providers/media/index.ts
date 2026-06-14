import { childLogger } from '../../utils/logger.js';
import type { ImageResult, LLMProvider } from '../llm/types.js';

const log = childLogger('media');

/**
 * MediaProcessor routes media through the active LLM provider's capabilities.
 * Every method degrades gracefully: if the capability is missing or the call fails, it returns
 * null (and logs) instead of throwing, so a single missing capability never crashes the bot.
 */
export class MediaProcessor {
  constructor(private readonly llm: LLMProvider) {}

  get canDescribeImage(): boolean {
    return this.llm.capabilities.vision && typeof this.llm.visionCompletion === 'function';
  }

  get canTranscribe(): boolean {
    return this.llm.capabilities.transcription && typeof this.llm.transcribeAudio === 'function';
  }

  get canGenerateImage(): boolean {
    return this.llm.capabilities.imageGeneration && typeof this.llm.generateImage === 'function';
  }

  /** Describe an image; returns null when vision is unavailable or fails. */
  async describeImage(buffer: Buffer, mime: string): Promise<string | null> {
    if (!this.canDescribeImage || !this.llm.visionCompletion) {
      log.info('vision capability unavailable — skipping image description');
      return null;
    }
    try {
      const result = await this.llm.visionCompletion({
        prompt: 'Describe this image concisely for chat context. One or two sentences.',
        imageBase64: buffer.toString('base64'),
        imageMime: mime,
        maxTokens: 200,
      });
      return result.text.trim() || null;
    } catch (err) {
      log.warn({ err }, 'image description failed');
      return null;
    }
  }

  /** Transcribe a voice message; returns null when transcription is unavailable or fails. */
  async transcribeVoice(buffer: Buffer, mime: string, fileName?: string): Promise<string | null> {
    if (!this.canTranscribe || !this.llm.transcribeAudio) {
      log.info('transcription capability unavailable — skipping voice transcription');
      return null;
    }
    try {
      const opts: { audio: Buffer; mime: string; fileName?: string } = { audio: buffer, mime };
      if (fileName !== undefined) opts.fileName = fileName;
      const text = await this.llm.transcribeAudio(opts);
      return text.trim() || null;
    } catch (err) {
      log.warn({ err }, 'voice transcription failed');
      return null;
    }
  }

  /** Generate an image; returns null when generation is unavailable or fails. */
  async generateImage(prompt: string): Promise<ImageResult | null> {
    if (!this.canGenerateImage || !this.llm.generateImage) {
      log.info('image generation capability unavailable — skipping');
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
