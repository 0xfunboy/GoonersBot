import { childLogger } from '../../utils/logger.js';
import type { ImageResult, LLMProvider } from '../llm/types.js';
import type { SttProvider } from '../voice/stt.js';

const log = childLogger('media');

/**
 * MediaProcessor routes media through the active providers. Voice transcription prefers the local
 * whisper.cpp STT provider when enabled, falling back to the LLM provider's transcription endpoint.
 * Every method degrades gracefully (returns null + logs) so one missing capability never crashes.
 */
export class MediaProcessor {
  constructor(
    private readonly llm: LLMProvider,
    private readonly stt?: SttProvider,
  ) {}

  get canDescribeImage(): boolean {
    return this.llm.capabilities.vision && typeof this.llm.visionCompletion === 'function';
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
      log.info('transcription capability unavailable — skipping voice transcription');
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
