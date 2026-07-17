import type { AgnesVideoConfig } from '../../config/index.js';
import { Cooldown } from '../../utils/rateLimit.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('agnes-video');

export interface VideoResult {
  buffer: Buffer;
  mime: string;
  /** clip length reported by the provider, in seconds */
  seconds?: number;
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

  async generate(prompt: string): Promise<VideoResult> {
    if (!this.enabled) throw new Error('Agnes video generation is disabled');
    if (!this.cooldown.tryAcquire(AgnesVideoGenerator.KEY)) {
      throw new VideoRateLimitError(this.cooldownMs());
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/v1/videos`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.cfg.model, prompt }),
      });
      const json = (await res.json().catch(() => ({}))) as AgnesVideoResponse;
      if (!res.ok) {
        const message = json.error?.message ?? `HTTP ${res.status}`;
        if (res.status === 429 || RATE_LIMIT_RE.test(message)) {
          throw new VideoRateLimitError(this.cfg.minIntervalMs);
        }
        throw new Error(`agnes video: ${message}`);
      }
      const first = json.data?.[0];
      if (!first?.url) throw new Error('agnes video response had no url');

      const buffer = await this.download(first.url, controller.signal);
      const seconds = Number(first.seconds);
      log.info({ model: this.cfg.model, bytes: buffer.length, seconds }, 'agnes video generated');
      return {
        buffer,
        mime: 'video/mp4',
        ...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async download(url: string, signal: AbortSignal): Promise<Buffer> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`agnes video download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('agnes video download was empty');
    if (buf.length > this.cfg.maxBytes) throw new Error('agnes video too large');
    return buf;
  }
}
