import { childLogger } from '../utils/logger.js';
import type { SearxngProvider } from '../search/searxng.js';
import type { MediaProcessor } from '../providers/media/index.js';

const log = childLogger('image-finder');

const MAX_BYTES = 8 * 1024 * 1024;
// The verified image must read as anime/illustration; reject real photos, NSFW (unless allowed),
// gore and anything off-theme. Heuristic over the vision description.
const ANIME_HINT =
  /\b(anime|manga|illustration|drawing|cartoon|chibi|2d|artwork|digital art|waifu|character)\b/i;
const REJECT_HINT =
  /\b(real (person|photo|woman|man)|photograph of a (real|person)|gore|blood|corpse|nudity|nude|explicit|porn|child|minor|loli|shota|swastika|nazi|isis|beheading)\b/i;

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
    const urls = await this.searxng.searchImages(query, { max: 25 });
    if (urls.length === 0) return null;

    // Try a few random candidates; stop at the first that downloads and passes the vision check.
    for (const url of shuffle(urls).slice(0, 6)) {
      const buffer = await this.download(url);
      if (!buffer) continue;
      const description = await this.media.describeImage(buffer, guessMime(url));
      if (!description) continue;
      if (REJECT_HINT.test(description)) {
        log.debug({ url }, 'image rejected by content check');
        continue;
      }
      if (!ANIME_HINT.test(description) && !ANIME_HINT.test(query)) continue;
      return { buffer, description };
    }
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
