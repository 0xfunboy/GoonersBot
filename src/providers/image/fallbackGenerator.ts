import type { ImageResult } from '../llm/types.js';
import { childLogger } from '../../utils/logger.js';
import type { ImageGenerator, ImageGenerationOptions } from './stableDiffusion.js';
import { assertMediaGenerationSafe } from '../../safety/mediaSafety.js';

const log = childLogger('image-fallback');
const PRIMARY_FAILURE_THRESHOLD = 2;
const PRIMARY_COOLDOWN_MS = 5 * 60_000;

/**
 * Tries the remote generator (Agnes) first and falls back to the local one (Stable Diffusion) on any
 * failure, so a remote outage or quota never kills image generation.
 *
 * Pose-reference jobs go straight to the local generator: only Forge/ControlNet can honour an
 * OpenPose reference, so sending them remotely would silently drop the pose.
 */
export class FallbackImageGenerator implements ImageGenerator {
  private primaryFailures = 0;
  private primaryUnavailableUntil = 0;
  private fallbackFailures = 0;
  private fallbackUnavailableUntil = 0;

  constructor(
    private readonly primary: ImageGenerator,
    private readonly fallback: ImageGenerator,
  ) {}

  get enabled(): boolean {
    return this.primary.enabled || this.fallback.enabled;
  }

  async generate(prompt: string, options: ImageGenerationOptions = {}): Promise<ImageResult> {
    assertMediaGenerationSafe(prompt);
    const needsLocal = Boolean(options.poseReference);
    if (needsLocal) {
      if (!this.fallback.enabled) {
        throw new Error('Pony is required for pose-guided generation but is disabled');
      }
      if (!this.fallbackAvailable()) {
        throw new Error('Pony image generator is temporarily cooling down');
      }
      try {
        return await this.generateFallback(prompt, options);
      } catch (error) {
        if (!countsAsProviderFailure(error, options.signal)) throw error;
        throw withAttemptCount(error, 1);
      }
    }
    if (options.rating === 'explicit') {
      if (!this.fallback.enabled) {
        throw new Error('Pony is required for explicit image generation but is disabled');
      }
      if (!this.fallbackAvailable()) {
        throw new Error('Pony image generator is temporarily cooling down');
      }
      try {
        return await this.generateFallback(prompt, options);
      } catch (error) {
        if (!countsAsProviderFailure(error, options.signal)) throw error;
        throw withAttemptCount(error, 1);
      }
    }

    if (options.preferredProvider === 'pony' && this.fallback.enabled && this.fallbackAvailable()) {
      try {
        return await this.generateFallback(prompt, options);
      } catch (err) {
        if (!countsAsProviderFailure(err, options.signal)) throw err;
        if (!this.primary.enabled || !this.primaryAvailable()) throw err;
        log.warn({ err }, 'preferred Pony generation failed - trying Agnes');
        try {
          return addSuccessfulAttempts(await this.generatePrimary(prompt, options), 1);
        } catch (primaryError) {
          throw withAttemptCount(primaryError, 2);
        }
      }
    }

    let primaryError: unknown;
    if (this.primary.enabled && this.primaryAvailable()) {
      try {
        return await this.generatePrimary(prompt, options);
      } catch (err) {
        if (!countsAsProviderFailure(err, options.signal)) throw err;
        primaryError = err;
        if (!this.fallback.enabled) throw err;
        log.warn({ err }, 'remote image generation failed - falling back to local');
      }
    }
    if (this.fallback.enabled && this.fallbackAvailable()) {
      try {
        return addSuccessfulAttempts(
          await this.generateFallback(prompt, options),
          primaryError ? 1 : 0,
        );
      } catch (fallbackError) {
        throw withAttemptCount(fallbackError, primaryError ? 2 : 1);
      }
    }
    // Never spend the same remote request twice in one routing attempt just because the fallback
    // circuit is cooling down. Surface the first real provider failure instead.
    if (primaryError) throw primaryError;
    throw new Error('all configured image generators are temporarily unavailable');
  }

  private primaryAvailable(): boolean {
    return Date.now() >= this.primaryUnavailableUntil;
  }

  private fallbackAvailable(): boolean {
    return Date.now() >= this.fallbackUnavailableUntil;
  }

  private async generatePrimary(
    prompt: string,
    options: ImageGenerationOptions,
  ): Promise<ImageResult> {
    try {
      const result = await this.primary.generate(prompt, options);
      this.primaryFailures = 0;
      this.primaryUnavailableUntil = 0;
      return result;
    } catch (error) {
      if (!countsAsProviderFailure(error, options.signal)) throw error;
      this.primaryFailures += 1;
      if (this.primaryFailures >= PRIMARY_FAILURE_THRESHOLD) {
        this.primaryUnavailableUntil = Date.now() + PRIMARY_COOLDOWN_MS;
        log.warn(
          { failures: this.primaryFailures, cooldownMs: PRIMARY_COOLDOWN_MS },
          'remote image generator circuit opened',
        );
      }
      throw error;
    }
  }

  private async generateFallback(
    prompt: string,
    options: ImageGenerationOptions,
  ): Promise<ImageResult> {
    try {
      const result = await this.fallback.generate(prompt, options);
      this.fallbackFailures = 0;
      this.fallbackUnavailableUntil = 0;
      return result;
    } catch (error) {
      if (!countsAsProviderFailure(error, options.signal)) throw error;
      this.fallbackFailures += 1;
      if (this.fallbackFailures >= PRIMARY_FAILURE_THRESHOLD) {
        this.fallbackUnavailableUntil = Date.now() + PRIMARY_COOLDOWN_MS;
        log.warn(
          { failures: this.fallbackFailures, cooldownMs: PRIMARY_COOLDOWN_MS },
          'Pony image generator circuit opened',
        );
      }
      throw error;
    }
  }
}

function countsAsProviderFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return name !== 'AbortError' && !/\b(?:abort|cancel(?:led|ed)?)\b/i.test(message);
}

function addSuccessfulAttempts(result: ImageResult, failedAttempts: number): ImageResult {
  return {
    ...result,
    generationAttempts: (result.generationAttempts ?? 1) + failedAttempts,
  };
}

function withAttemptCount(
  error: unknown,
  attempts: number,
): Error & { generationAttempts: number } {
  const resolved = error instanceof Error ? error : new Error(String(error));
  return Object.assign(resolved, {
    generationAttempts: Math.max(
      attempts,
      Number(
        'generationAttempts' in resolved
          ? (resolved as { generationAttempts?: unknown }).generationAttempts
          : 0,
      ) || 0,
    ),
  });
}
