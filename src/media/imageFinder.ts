import { childLogger } from '../utils/logger.js';
import type { SearxngProvider } from '../search/searxng.js';
import type { MediaProcessor } from '../providers/media/index.js';
import { throwIfAborted } from '../utils/abort.js';
import { fetchSafeRemoteBuffer } from '../utils/safeRemoteFetch.js';

const log = childLogger('image-finder');

const MAX_BYTES = 8 * 1024 * 1024;
// Permissive policy: pass almost everything (nudity/suggestive included). Block ONLY explicit
// genitalia / penetration acts, plus the non-negotiable minor red line (kept regardless of config).
const HARDCORE_RE =
  /\b(penis|penises|dick|cock|erect\w*|hard-?on|penetrat\w*|intercourse|blow\s?job|fellatio|cum\s?shot|cumming|ejaculat\w*|insertion|gang\s?bang|deep\s?throat|anal sex|vaginal sex)\b/i;
const MINOR_BLOCK_RE =
  /\b(child|children|minor|under\s?age|underaged|loli|shota|toddler|infant|preteen|pre-teen|cp|csam)\b/i;

export interface FoundImage {
  buffer: Buffer;
  /** vision description (the bot "looked at it") for an on-theme comment */
  description: string;
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
    if (!this.enabled) return null;
    const query = (hint && hint.trim()) || this.randomQuery();
    const urls = await this.searxng.searchImages(query, { max: 30, signal });
    if (urls.length === 0) {
      log.debug({ query }, 'no image candidates from search');
      return null;
    }

    // Try several candidates; send the first that downloads and is not hardcore/minor content.
    for (const url of shuffle(urls).slice(0, 8)) {
      throwIfAborted(signal);
      const image = await this.download(url, signal);
      if (!image) continue;
      const description = await this.media.describeImage(image.buffer, image.mime, signal);
      // No description means vision could not look at it: skip (cannot vet it).
      if (!description) continue;
      if (MINOR_BLOCK_RE.test(description) || HARDCORE_RE.test(description)) {
        log.debug({ url }, 'image rejected (hardcore/minor)');
        continue;
      }
      return { buffer: image.buffer, description };
    }
    log.debug({ query, tried: Math.min(urls.length, 8) }, 'no candidate passed verification');
    return null;
  }

  /**
   * Find a neutral visual reference used only as an OpenPose source. It is never sent to Telegram
   * or written to disk: Forge receives its pose map in the generation request.
   */
  async findPoseReference(hint: string, signal?: AbortSignal): Promise<FoundImage | null> {
    if (!this.enabled) return null;
    const urls = await this.searxng.searchImages(`${hint} pose reference full body`, {
      max: 20,
      signal,
    });
    for (const url of shuffle(urls).slice(0, 8)) {
      throwIfAborted(signal);
      const image = await this.download(url, signal);
      if (!image) continue;
      const description = await this.media.describeImage(image.buffer, image.mime, signal);
      if (!description || MINOR_BLOCK_RE.test(description) || HARDCORE_RE.test(description))
        continue;
      if (!/\b(person|people|man|woman|adult|standing|pose|body)\b/i.test(description)) continue;
      log.info({ hint }, 'selected SearXNG image as an in-memory OpenPose reference');
      return { buffer: image.buffer, description };
    }
    log.info({ hint }, 'no suitable SearXNG OpenPose reference found');
    return null;
  }

  private randomQuery(): string {
    return this.queryPool[Math.floor(Math.random() * this.queryPool.length)] ?? 'anime waifu';
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
