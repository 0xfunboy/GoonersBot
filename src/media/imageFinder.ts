import { childLogger } from '../utils/logger.js';
import type { SearxngProvider } from '../search/searxng.js';
import type { MediaProcessor } from '../providers/media/index.js';
import { throwIfAborted } from '../utils/abort.js';
import { fetchSafeRemoteBuffer } from '../utils/safeRemoteFetch.js';
import { containsMinorMediaReference } from '../safety/mediaSafety.js';

const log = childLogger('image-finder');

const MAX_BYTES = 8 * 1024 * 1024;
// Permissive policy: pass almost everything (nudity/suggestive included). Block ONLY explicit
// genitalia / penetration acts, plus the non-negotiable minor red line (kept regardless of config).
const HARDCORE_RE =
  /\b(penis|penises|dick|cock|erect\w*|hard-?on|penetrat\w*|intercourse|blow\s?job|fellatio|cum\s?shot|cumming|ejaculat\w*|insertion|gang\s?bang|deep\s?throat|anal sex|vaginal sex)\b/i;
const POSE_CACHE_TTL_MS = 30 * 60_000;
const POSE_CACHE_MAX_ENTRIES = 8;

export interface FoundImage {
  buffer: Buffer;
  /** vision description (the bot "looked at it") for an on-theme comment */
  description: string;
  /** Actual vision requests spent vetting candidates before this result was selected. */
  visionCalls: number;
}

export interface ImageFindResult {
  image: FoundImage | null;
  /** Includes rejected candidates, so a miss is still accounted correctly. */
  visionCalls: number;
}

interface DownloadedImage {
  buffer: Buffer;
  mime: string;
}

/**
 * Finds a safe, on-theme (waifu/anime) image online via SearXNG image search, then VERIFIES it by
 * downloading and having the vision model look at it before it is ever sent. Returns null unless a
 * candidate both downloads and passes the anime/safety check. Free (SearXNG + local-ish vision).
 */
export class ImageFinder {
  private readonly poseCache = new Map<string, { image: FoundImage; expiresAt: number }>();

  constructor(
    private readonly searxng: SearxngProvider,
    private readonly media: MediaProcessor,
    private readonly queryPool: string[],
  ) {}

  get enabled(): boolean {
    return this.searxng.enabled && this.media.canDescribeImage;
  }

  /** Pick a query (a hint, or a random one from the pool) and return a verified image + description. */
  async find(hint?: string, signal?: AbortSignal): Promise<FoundImage | null> {
    const result = await this.findWithUsage(hint, signal);
    return result.image;
  }

  async findWithUsage(hint?: string, signal?: AbortSignal): Promise<ImageFindResult> {
    if (!this.enabled) return { image: null, visionCalls: 0 };
    const query = (hint && hint.trim()) || this.randomQuery();
    const urls = await this.searxng.searchImages(query, { max: 30, signal });
    if (urls.length === 0) {
      log.debug({ query }, 'no image candidates from search');
      return { image: null, visionCalls: 0 };
    }

    // Try several candidates; send the first that downloads and is not hardcore/minor content.
    let visionCalls = 0;
    for (const url of shuffle(urls).slice(0, 8)) {
      throwIfAborted(signal);
      const image = await this.download(url, signal);
      if (!image) continue;
      const described = await this.media.describeImageWithUsage(image.buffer, image.mime, signal);
      visionCalls += described.visionCalls;
      const description = described.text;
      // No description means vision could not look at it: skip (cannot vet it).
      if (!description) continue;
      if (containsMinorMediaReference(description) || HARDCORE_RE.test(description)) {
        log.debug({ url }, 'image rejected (hardcore/minor)');
        continue;
      }
      return {
        image: { buffer: image.buffer, description, visionCalls },
        visionCalls,
      };
    }
    log.debug({ query, tried: Math.min(urls.length, 8) }, 'no candidate passed verification');
    return { image: null, visionCalls };
  }

  /**
   * Find a neutral visual reference used only as an OpenPose source. It is never sent to Telegram
   * or written to disk: Forge receives its pose map in the generation request.
   */
  async findPoseReference(hint: string, signal?: AbortSignal): Promise<FoundImage | null> {
    const result = await this.findPoseReferenceWithUsage(hint, signal);
    return result.image;
  }

  async findPoseReferenceWithUsage(hint: string, signal?: AbortSignal): Promise<ImageFindResult> {
    if (!this.enabled) return { image: null, visionCalls: 0 };
    const cacheKey = hint.trim().toLowerCase();
    const cached = this.poseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { image: { ...cached.image, visionCalls: 0 }, visionCalls: 0 };
    }
    if (cached) this.poseCache.delete(cacheKey);
    const urls = await this.searxng.searchImages(`${hint} pose reference full body`, {
      max: 8,
      signal,
    });
    let visionCalls = 0;
    for (const url of shuffle(urls).slice(0, 2)) {
      throwIfAborted(signal);
      const image = await this.download(url, signal);
      if (!image) continue;
      const described = await this.media.describeImageWithUsage(image.buffer, image.mime, signal);
      visionCalls += described.visionCalls;
      const description = described.text;
      if (!description || containsMinorMediaReference(description) || HARDCORE_RE.test(description))
        continue;
      if (!/\b(person|people|man|woman|adult|standing|pose|body)\b/i.test(description)) continue;
      const found = { buffer: image.buffer, description, visionCalls };
      this.rememberPose(cacheKey, { ...found, visionCalls: 0 });
      log.info({ hint }, 'selected SearXNG image as an in-memory OpenPose reference');
      return { image: found, visionCalls };
    }
    log.info({ hint }, 'no suitable SearXNG OpenPose reference found');
    return { image: null, visionCalls };
  }

  private randomQuery(): string {
    return this.queryPool[Math.floor(Math.random() * this.queryPool.length)] ?? 'anime waifu';
  }

  private rememberPose(key: string, image: FoundImage): void {
    if (this.poseCache.size >= POSE_CACHE_MAX_ENTRIES) {
      const oldest = this.poseCache.keys().next().value as string | undefined;
      if (oldest) this.poseCache.delete(oldest);
    }
    this.poseCache.set(key, { image, expiresAt: Date.now() + POSE_CACHE_TTL_MS });
  }

  private async download(url: string, signal?: AbortSignal): Promise<DownloadedImage | null> {
    try {
      const result = await fetchSafeRemoteBuffer(url, {
        timeoutMs: 10_000,
        maxBytes: MAX_BYTES,
        signal,
        allowedContentTypes: ['image/*'],
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8' },
      });
      if (result.buffer.length < 1024) return null;
      return {
        buffer: result.buffer,
        mime: result.contentType || guessMime(result.finalUrl),
      };
    } catch {
      return null;
    }
  }
}

function guessMime(url: string): string {
  if (/\.png(\?|$)/i.test(url)) return 'image/png';
  if (/\.webp(\?|$)/i.test(url)) return 'image/webp';
  if (/\.gif(\?|$)/i.test(url)) return 'image/gif';
  return 'image/jpeg';
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}
