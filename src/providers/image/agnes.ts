import type { AgnesImageConfig } from '../../config/index.js';
import type { ImageResult } from '../llm/types.js';
import { childLogger } from '../../utils/logger.js';
import type { ImageGenerator, ImageGenerationOptions } from './stableDiffusion.js';

const log = childLogger('agnes-image');

interface AgnesImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string; code?: string };
}

/**
 * Agnes AI text-to-image through the router's OpenAI-compatible surface
 * (POST /v1/images/generations -> { data: [{ url }] }). The image is fetched and returned as bytes.
 *
 * It has no ControlNet/pose support and no local model profiles: the caller (FallbackImageGenerator)
 * routes pose-reference jobs to the local Stable Diffusion instead, and profile hints are folded
 * into the prompt.
 */
export class AgnesImageGenerator implements ImageGenerator {
  constructor(private readonly cfg: AgnesImageConfig) {}

  get enabled(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.baseUrl) && Boolean(this.cfg.model);
  }

  async generate(prompt: string, options: ImageGenerationOptions = {}): Promise<ImageResult> {
    if (!this.enabled) throw new Error('Agnes image generation is disabled');
    const styled = options.profile ? `${prompt}, ${styleHint(options.profile)}` : prompt;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/v1/images/generations`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.cfg.model, prompt: styled, n: 1 }),
      });
      const json = (await res.json().catch(() => ({}))) as AgnesImageResponse;
      if (!res.ok) {
        throw new Error(`agnes image HTTP ${res.status}: ${json.error?.message ?? 'unknown error'}`);
      }
      const first = json.data?.[0];
      if (first?.b64_json) {
        return { buffer: Buffer.from(first.b64_json, 'base64'), model: this.cfg.model };
      }
      if (!first?.url) throw new Error('agnes image response had no url');
      const buffer = await this.download(first.url, controller.signal);
      log.info({ model: this.cfg.model, bytes: buffer.length }, 'agnes image generated');
      return { buffer, model: this.cfg.model };
    } finally {
      clearTimeout(timer);
    }
  }

  private async download(url: string, signal: AbortSignal): Promise<Buffer> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`agnes image download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('agnes image download was empty');
    if (buf.length > this.cfg.maxBytes) throw new Error('agnes image too large');
    return buf;
  }
}

function styleHint(profile: NonNullable<ImageGenerationOptions['profile']>): string {
  switch (profile) {
    case 'manga':
      return 'manga style, detailed line art';
    case 'anime':
      return 'anime style, vibrant colors';
    case 'nsfw':
      return 'explicit adult content, uncensored';
    case 'realistic':
    default:
      return 'photorealistic, highly detailed';
  }
}
