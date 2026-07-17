import type { ImageResult } from '../llm/types.js';
import { childLogger } from '../../utils/logger.js';
import type { ImageGenerator, ImageGenerationOptions } from './stableDiffusion.js';

const log = childLogger('image-fallback');

/**
 * Tries the remote generator (Agnes) first and falls back to the local one (Stable Diffusion) on any
 * failure, so a remote outage or quota never kills image generation.
 *
 * Pose-reference jobs go straight to the local generator: only Forge/ControlNet can honour an
 * OpenPose reference, so sending them remotely would silently drop the pose.
 */
export class FallbackImageGenerator implements ImageGenerator {
  constructor(
    private readonly primary: ImageGenerator,
    private readonly fallback: ImageGenerator,
  ) {}

  get enabled(): boolean {
    return this.primary.enabled || this.fallback.enabled;
  }

  async generate(prompt: string, options: ImageGenerationOptions = {}): Promise<ImageResult> {
    const needsLocal = Boolean(options.poseReference);
    if (needsLocal && this.fallback.enabled) return this.fallback.generate(prompt, options);

    if (this.primary.enabled) {
      try {
        return await this.primary.generate(prompt, options);
      } catch (err) {
        if (!this.fallback.enabled) throw err;
        log.warn({ err }, 'remote image generation failed - falling back to local');
      }
    }
    return this.fallback.generate(prompt, options);
  }
}
