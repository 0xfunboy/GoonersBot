import type { AgnesImageConfig } from '../../config/index.js';
import type { ImageResult } from '../llm/types.js';
import { childLogger } from '../../utils/logger.js';
import type { ImageGenerator, ImageGenerationOptions } from './stableDiffusion.js';
import { assertMediaGenerationSafe } from '../../safety/mediaSafety.js';
import { createAbortScope } from '../../utils/abort.js';
import { fetchSafeRemoteBuffer, readBoundedResponseBuffer } from '../../utils/safeRemoteFetch.js';

const log = childLogger('agnes-image');
const MAX_JSON_HARD_CAP_BYTES = 64 * 1024 * 1024;
const JSON_ENVELOPE_BYTES = 64 * 1024;

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
    assertMediaGenerationSafe(prompt);
    const providerPrompt = options.providerPrompts?.agnes;
    const styled = providerPrompt
      ? [
          providerPrompt,
          options.retryFeedback
            ? `Correction required after visual inspection: ${options.retryFeedback}.`
            : '',
        ]
          .filter(Boolean)
          .join(' ')
      : `${prompt}${options.profile ? `, ${styleHint(options.profile)}` : ''}`;
    assertMediaGenerationSafe(styled);
    const ratio = options.aspectRatio ?? '1:1';
    // GemRouter exposes Agnes through an OpenAI-compatible validator. It accepts the standard
    // DALL-E canvas values but currently rejects Agnes' native `size: "1K"` + `ratio` pair.
    // The upstream model accepts these legacy exact sizes and preserves the requested orientation.
    const size = openAiCompatibleSize(ratio);

    const scope = createAbortScope(this.cfg.timeoutMs, options.signal, 'Agnes image generation');
    try {
      const res = await fetch(`${this.cfg.baseUrl}/v1/images/generations`, {
        method: 'POST',
        signal: scope.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          prompt: styled,
          size,
          n: 1,
        }),
      });
      const json = await readAgnesJson(res, scope.signal, this.cfg.maxBytes);
      if (!res.ok) {
        throw new Error(
          `agnes image HTTP ${res.status}: ${json.error?.message ?? 'unknown error'}`,
        );
      }
      const first = json.data?.[0];
      if (first?.b64_json) {
        return {
          buffer: decodeBoundedBase64(first.b64_json, this.cfg.maxBytes),
          model: this.cfg.model,
          provider: 'agnes',
        };
      }
      if (!first?.url) throw new Error('agnes image response had no url');
      const buffer = await this.download(first.url, scope.signal);
      log.info(
        { model: this.cfg.model, ratio, size, bytes: buffer.length },
        'agnes image generated',
      );
      return { buffer, model: this.cfg.model, provider: 'agnes' };
    } finally {
      scope.dispose();
    }
  }

  private async download(url: string, signal: AbortSignal): Promise<Buffer> {
    const result = await fetchSafeRemoteBuffer(url, {
      timeoutMs: this.cfg.timeoutMs,
      maxBytes: this.cfg.maxBytes,
      signal,
      allowedContentTypes: ['image/*'],
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
    });
    const buf = result.buffer;
    if (buf.length === 0) throw new Error('agnes image download was empty');
    return buf;
  }
}

function openAiCompatibleSize(ratio: NonNullable<ImageGenerationOptions['aspectRatio']>): string {
  if (ratio === '16:9') return '1792x1024';
  if (ratio === '9:16') return '1024x1792';
  return '1024x1024';
}

async function readAgnesJson(
  res: Response,
  signal: AbortSignal,
  maxImageBytes: number,
): Promise<AgnesImageResponse> {
  // Inline Base64 is ~4/3 the binary size. Keep the envelope bounded while allowing the configured
  // image limit; the previous fixed 1 MB cap rejected perfectly valid 1K results.
  const maxJsonBytes = Math.min(
    MAX_JSON_HARD_CAP_BYTES,
    Math.ceil(maxImageBytes / 3) * 4 + JSON_ENVELOPE_BYTES,
  );
  const raw = await readBoundedResponseBuffer(res, maxJsonBytes, signal);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as AgnesImageResponse;
  } catch {
    return {};
  }
}

function decodeBoundedBase64(raw: string, maxBytes: number): Buffer {
  const encoded = raw.replace(/^data:image\/[\w.+-]+;base64,/i, '').replace(/\s+/g, '');
  if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error('agnes image too large');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0) throw new Error('agnes image was empty');
  if (buffer.length > maxBytes) throw new Error('agnes image too large');
  return buffer;
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
