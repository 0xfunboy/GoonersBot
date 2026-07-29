import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/index.js';
import type { MediaProcessor } from '../providers/media/index.js';
import type { Storage } from '../storage/index.js';
import { childLogger } from '../utils/logger.js';
import type { GroupQuotaService } from './groupQuota.js';
import type { Localizer } from '../config/i18n.js';
import type { ImagePromptService } from './imagePrompt.js';
import type { ImageFinder } from '../media/imageFinder.js';

const log = childLogger('generated-image-autopost');

export interface GeneratedImagePost {
  text: string;
  imageBuffer: Buffer;
  imageSpoiler: boolean;
  generationAttempts: number;
  visionCalls: number;
}

/**
 * Independent generated-image autopost pipeline. It deliberately has its own scheduler switch,
 * probability and history reservation so it can be tested and enabled without touching news/web
 * autopost behavior.
 */
export class GeneratedImagePoster {
  constructor(
    private readonly media: MediaProcessor,
    private readonly imagePrompts: ImagePromptService,
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly quota: GroupQuotaService,
    private readonly localizer: Localizer,
    private readonly imageFinder: ImageFinder,
  ) {}

  get enabled(): boolean {
    return this.config.auto.generatedImageAutopostEnabled && this.media.canGenerateImage;
  }

  async compose(chatId: number, language: string): Promise<GeneratedImagePost | null> {
    if (!this.enabled) return null;
    if (!(await this.quota.reserve(chatId, 'image')).allowed) return null;
    const subjects = this.config.auto.imageQueryPool;
    const subject = subjects[Math.floor(Math.random() * subjects.length)] ?? 'anime waifu';
    const prompt =
      `${subject}, original adult character, stylish editorial illustration, high detail, ` +
      'cinematic lighting, no text, no logo';
    let generated;
    let prepared;
    let poseVisionCalls = 0;
    try {
      prepared = await this.imagePrompts.prepare(prompt);
      const poseLookup = prepared.poseReferenceQuery
        ? await this.imageFinder.findPoseReferenceWithUsage(prepared.poseReferenceQuery)
        : { image: null, visionCalls: 0 };
      const poseReference = poseLookup.image;
      poseVisionCalls = poseLookup.visionCalls;
      generated = await this.media.generateImage(prepared.prompt, {
        profile: prepared.profile,
        medium: prepared.medium,
        rating: prepared.rating,
        providerPrompts: prepared.providerPrompts,
        qualityBrief: prepared.qualityBrief,
        expectsPeople: prepared.expectsPeople,
        preferredProvider: prepared.preferredProvider,
        negativePrompt: prepared.negativePrompt,
        aspectRatio: prepared.aspectRatio,
        ...(poseReference ? { poseReference: poseReference.buffer } : {}),
      });
    } catch (err) {
      log.warn({ err, chatId }, 'generated image autopost planning failed');
      return null;
    }
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
      text:
        this.localizer.t('generated_image_autopost', {}, language) ?? 'generated_image_autopost',
      imageBuffer: generated.buffer,
      imageSpoiler: prepared.rating !== 'safe',
      generationAttempts: generated.generationAttempts ?? 1,
      visionCalls: poseVisionCalls + (generated.qaVisionCalls ?? 0),
    };
  }
}
