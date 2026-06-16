import { childLogger } from '../utils/logger.js';

const log = childLogger('news');

export interface NewsItem {
  title: string;
  link: string;
  summary: string;
  source: string;
}

/**
 * Minimal RSS/Atom reader (no dependencies): fetches the configured feeds and returns recent items.
 * Parsing is regex-based - robust enough for standard feeds, and it degrades to [] on anything weird.
 */
export class NewsService {
  constructor(
    private readonly feeds: string[],
    private readonly timeoutMs = 8000,
  ) {}

  get enabled(): boolean {
    return this.feeds.length > 0;
  }

  /** Fetch all feeds (in parallel) and return a flat, de-duplicated list of recent items. */
  async recent(perFeed = 6): Promise<NewsItem[]> {
    const lists = await Promise.all(this.feeds.map((f) => this.fetchFeed(f, perFeed)));
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    for (const list of lists) {
      for (const item of list) {
        const key = item.title.toLowerCase().slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
    return out;
  }

  /** A single random recent item across all feeds (or null). */
  async pickOne(): Promise<NewsItem | null> {
    const items = await this.recent();
    if (items.length === 0) return null;
    return items[Math.floor(Math.random() * Math.min(items.length, 15))] ?? null;
  }

  private async fetchFeed(url: string, limit: number): Promise<NewsItem[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'GoonersBot/1.0 (+rss)',
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return parseFeed(xml, hostOf(url)).slice(0, limit);
    } catch (err) {
      log.debug({ err, url }, 'feed fetch failed');
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse RSS <item> or Atom <entry> blocks into NewsItems. */
export function parseFeed(xml: string, source: string): NewsItem[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const items: NewsItem[] = [];
  for (const block of blocks) {
    const title = clean(pick(block, 'title'));
    if (!title) continue;
    const link = clean(pickLink(block));
    const summary = clean(
      pick(block, 'description') || pick(block, 'summary') || pick(block, 'content'),
    ).slice(0, 280);
    items.push({ title, link, summary, source });
  }
  return items;
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m?.[1] ?? '';
}

/** RSS <link>url</link> or Atom <link href="url" />. */
function pickLink(block: string): string {
  const rss = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (rss?.[1]?.trim()) return rss[1];
  const atom = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  return atom?.[1] ?? '';
}

function clean(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'rss';
  }
}
