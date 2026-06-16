import { childLogger } from '../utils/logger.js';
import type { SearxngProvider } from '../search/searxng.js';
import type { MediaProcessor } from '../providers/media/index.js';

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
  async find(hint?: string): Promise<FoundImage | null> {
    if (!this.enabled) return null;
    const query = (hint && hint.trim()) || this.randomQuery();
    const urls = await this.searxng.searchImages(query, { max: 30 });
    if (urls.length === 0) {
      log.debug({ query }, 'no image candidates from search');
      return null;
    }

    // Try several candidates; send the first that downloads and is not hardcore/minor content.
    for (const url of shuffle(urls).slice(0, 8)) {
      const buffer = await this.download(url);
      if (!buffer) continue;
      const description = await this.media.describeImage(buffer, guessMime(url));
      // No description means vision could not look at it: skip (cannot vet it).
      if (!description) continue;
      if (MINOR_BLOCK_RE.test(description) || HARDCORE_RE.test(description)) {
        log.debug({ url }, 'image rejected (hardcore/minor)');
        continue;
      }
      return { buffer, description };
    }
    log.debug({ query, tried: Math.min(urls.length, 8) }, 'no candidate passed verification');
    return null;
  }

  private randomQuery(): string {
    return this.queryPool[Math.floor(Math.random() * this.queryPool.length)] ?? 'anime waifu';
  }

  private async download(url: string): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024 || buf.length > MAX_BYTES) return null;
      return buf;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
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
