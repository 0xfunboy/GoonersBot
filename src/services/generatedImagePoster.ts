import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/index.js';
import type { MediaProcessor } from '../providers/media/index.js';
import type { Storage } from '../storage/index.js';
import { childLogger } from '../utils/logger.js';
import type { GroupQuotaService } from './groupQuota.js';

const log = childLogger('generated-image-autopost');

export interface GeneratedImagePost {
  text: string;
  imageBuffer: Buffer;
}

/**
 * Independent generated-image autopost pipeline. It deliberately has its own scheduler switch,
 * probability and history reservation so it can be tested and enabled without touching news/web
 * autopost behavior.
 */
export class GeneratedImagePoster {
  constructor(
    private readonly media: MediaProcessor,
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly quota: GroupQuotaService,
  ) {}

  get enabled(): boolean {
    return this.config.auto.generatedImageAutopostEnabled && this.media.canGenerateImage;
  }

  async compose(chatId: number): Promise<GeneratedImagePost | null> {
    if (!this.enabled) return null;
    if (!(await this.quota.reserve(chatId, 'image')).allowed) return null;
    const subjects = this.config.auto.imageQueryPool;
    const subject = subjects[Math.floor(Math.random() * subjects.length)] ?? 'anime waifu';
    const prompt =
      `${subject}, original adult character, stylish editorial illustration, high detail, ` +
      'cinematic lighting, no text, no logo';
    const generated = await this.media.generateImage(prompt);
    if (!generated?.buffer || generated.buffer.length < 1_024) return null;

    const dedupeKey = `image:${createHash('sha256').update(generated.buffer).digest('hex')}`;
    try {
      const reserved = await this.storage.autopostHistory.reserve(chatId, 'image', dedupeKey);
      if (!reserved) return null;
    } catch (err) {
      log.warn({ err, chatId }, 'generated image dedupe reservation failed');
      return null;
    }
    return {
      text: 'Originale appena sfornata. Non fate i critici d’arte per finta.',
      imageBuffer: generated.buffer,
    };
  }
}
