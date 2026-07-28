import type { AgnesVideoConfig } from '../../config/index.js';
import { Cooldown } from '../../utils/rateLimit.js';
import { childLogger } from '../../utils/logger.js';
import { assertMediaGenerationSafe } from '../../safety/mediaSafety.js';
import { createAbortScope } from '../../utils/abort.js';
import { fetchSafeRemoteBuffer, readBoundedResponseBuffer } from '../../utils/safeRemoteFetch.js';

const log = childLogger('agnes-video');
const MAX_JSON_BYTES = 1024 * 1024;

export interface VideoResult {
  buffer: Buffer;
  mime: string;
  /** clip length reported by the provider, in seconds */
  seconds?: number;
}

export interface VideoGenerationOptions {
  signal?: AbortSignal;
  durationSeconds?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1';
}

/** Thrown when the upstream 1-request-per-minute video limit (or our local guard) is hit. */
export class VideoRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('video generation rate limited');
    this.name = 'VideoRateLimitError';
  }
}

interface AgnesVideoResponse {
  data?: Array<{ url?: string; seconds?: string | number }>;
  error?: { message?: string; code?: string };
}

// The router surfaces the upstream 1/min cap in more than one shape: a 502 carrying
// "rate limit exceeded", or a plain 429 ("video submit failed (HTTP 429)").
const RATE_LIMIT_RE = /rate limit|too many requests|\b429\b/i;

/**
 * Agnes AI text-to-video through the router (POST /v1/videos). The router polls the provider
 * internally, so this call BLOCKS until the clip is ready (~1-2 minutes) and then returns
 * { data: [{ url, seconds }] }.
 *
 * Upstream allows one request per minute, so a local cooldown gates callers before we spend the
 * slot, and an upstream rate-limit response is surfaced as VideoRateLimitError.
 */
export class AgnesVideoGenerator {
  private readonly cooldown: Cooldown;
  private static readonly KEY = 'agnes-video';

  constructor(private readonly cfg: AgnesVideoConfig) {
    this.cooldown = new Cooldown(cfg.minIntervalMs);
  }

  get enabled(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.baseUrl) && Boolean(this.cfg.model);
  }

  /** Milliseconds until another clip may be requested (0 when free). */
  cooldownMs(): number {
    return this.cooldown.remainingMs(AgnesVideoGenerator.KEY);
  }

  async generate(
    prompt: string,
    options: VideoGenerationOptions | AbortSignal = {},
  ): Promise<VideoResult> {
    const resolvedOptions = isAbortSignal(options) ? { signal: options } : options;
    if (!this.enabled) throw new Error('Agnes video generation is disabled');
    assertMediaGenerationSafe(prompt);
    if (!this.cooldown.tryAcquire(AgnesVideoGenerator.KEY)) {
      throw new VideoRateLimitError(this.cooldownMs());
    }

    const scope = createAbortScope(
      this.cfg.timeoutMs,
      resolvedOptions.signal,
      'Agnes video generation',
    );
    try {
      const res = await fetch(`${this.cfg.baseUrl}/v1/videos`, {
        method: 'POST',
        signal: scope.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          prompt,
          ...(resolvedOptions.durationSeconds
            ? { duration_seconds: resolvedOptions.durationSeconds }
            : {}),
          ...(resolvedOptions.aspectRatio ? { aspect_ratio: resolvedOptions.aspectRatio } : {}),
        }),
      });
      const json = await readAgnesJson(res, scope.signal);
      if (!res.ok) {
        const message = json.error?.message ?? `HTTP ${res.status}`;
        if (res.status === 429 || RATE_LIMIT_RE.test(message)) {
          throw new VideoRateLimitError(this.cfg.minIntervalMs);
        }
        throw new Error(`agnes video: ${message}`);
      }
      const first = json.data?.[0];
      if (!first?.url) throw new Error('agnes video response had no url');

      const buffer = await this.download(first.url, scope.signal);
      const seconds = Number(first.seconds);
      log.info({ model: this.cfg.model, bytes: buffer.length, seconds }, 'agnes video generated');
      return {
        buffer,
        mime: 'video/mp4',
        ...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}),
      };
    } finally {
      scope.dispose();
    }
  }

  private async download(url: string, signal: AbortSignal): Promise<Buffer> {
    const result = await fetchSafeRemoteBuffer(url, {
      timeoutMs: this.cfg.timeoutMs,
      maxBytes: this.cfg.maxBytes,
      signal,
      allowedContentTypes: ['video/*', 'application/octet-stream'],
      headers: { Accept: 'video/mp4,video/webm,video/*;q=0.9,application/octet-stream;q=0.5' },
    });
    const buf = result.buffer;
    if (buf.length === 0) throw new Error('agnes video download was empty');
    return buf;
  }
}

async function readAgnesJson(res: Response, signal: AbortSignal): Promise<AgnesVideoResponse> {
  const raw = await readBoundedResponseBuffer(res, MAX_JSON_BYTES, signal);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as AgnesVideoResponse;
  } catch {
    return {};
  }
}

function isAbortSignal(value: VideoGenerationOptions | AbortSignal): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof value.addEventListener === 'function'
  );
}
