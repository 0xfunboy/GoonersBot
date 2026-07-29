import { describe, expect, it, vi } from 'vitest';
import { GeneratedImagePoster } from '../src/services/generatedImagePoster.js';

describe('GeneratedImagePoster', () => {
  it('uses the complete image pipeline and preserves spoiler plus call telemetry', async () => {
    const pose = Buffer.from('pose-reference');
    const bitmap = Buffer.alloc(2_048, 7);
    const prepare = vi.fn(async () => ({
      prompt: 'pony prompt',
      negativePrompt: 'bad anatomy, watermark',
      providerPrompts: {
        agnes: 'natural Agnes prompt',
        pony: 'concise Pony tags',
      },
      scene: {},
      creativeBrief: 'autopost character',
      qualityBrief: 'exactly one visibly mature adult character',
      expectsPeople: true,
      poseReferenceQuery: 'adult standing contrapposto pose',
      profile: 'anime',
      medium: 'anime',
      rating: 'suggestive',
      aspectRatio: '9:16',
      preferredProvider: 'pony',
      model: 'planner',
      usedFallback: false,
    }));
    const findPoseReferenceWithUsage = vi.fn(async () => ({
      image: {
        buffer: pose,
        description: 'an adult standing pose',
        visionCalls: 2,
      },
      visionCalls: 2,
    }));
    const generateImage = vi.fn(async () => ({
      buffer: bitmap,
      model: 'pony',
      provider: 'pony',
      generationAttempts: 2,
      qaVisionCalls: 1,
    }));
    const reserveQuota = vi.fn(async () => ({ allowed: true }));
    const reserveHistory = vi.fn(async () => true);
    const poster = new GeneratedImagePoster(
      { canGenerateImage: true, generateImage } as never,
      { prepare } as never,
      {
        auto: {
          generatedImageAutopostEnabled: true,
          imageQueryPool: ['community cyberpunk character'],
        },
      } as never,
      { autopostHistory: { reserve: reserveHistory } } as never,
      { reserve: reserveQuota } as never,
      { t: vi.fn(() => 'immagine della community') } as never,
      { findPoseReferenceWithUsage } as never,
    );

    const result = await poster.compose(-100, 'it');

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('community cyberpunk character'));
    expect(findPoseReferenceWithUsage).toHaveBeenCalledWith('adult standing contrapposto pose');
    expect(generateImage).toHaveBeenCalledWith(
      'pony prompt',
      expect.objectContaining({
        negativePrompt: 'bad anatomy, watermark',
        providerPrompts: {
          agnes: 'natural Agnes prompt',
          pony: 'concise Pony tags',
        },
        qualityBrief: 'exactly one visibly mature adult character',
        expectsPeople: true,
        preferredProvider: 'pony',
        aspectRatio: '9:16',
        poseReference: pose,
      }),
    );
    expect(reserveQuota).toHaveBeenCalledWith(-100, 'image');
    expect(reserveHistory).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      text: 'immagine della community',
      imageBuffer: bitmap,
      imageSpoiler: true,
      generationAttempts: 2,
      visionCalls: 3,
    });
  });
});
