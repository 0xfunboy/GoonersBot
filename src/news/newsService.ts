import { childLogger } from '../utils/logger.js';

const log = childLogger('news');

export interface NewsItem {
  title: string;
  link: string;
  summary: string;
  source: string;
  /** publication time (ms epoch) when the feed provided a parseable date */
  publishedAt?: number;
}

/**
 * Minimal RSS/Atom reader (no dependencies): fetches the configured feeds and returns ONLY items
 * published within `maxAgeHours`, newest first. Parsing is regex-based and degrades to [] on junk.
 * Items without a parseable date are dropped (we cannot prove they are recent).
 */
export class NewsService {
  constructor(
    private readonly feeds: string[],
    private readonly timeoutMs = 8000,
    private readonly maxAgeHours = 12,
  ) {}

  get enabled(): boolean {
    return this.feeds.length > 0;
  }

  /** Fresh items (within maxAgeHours) across all feeds, de-duplicated, newest first. */
  async recent(perFeed = 12): Promise<NewsItem[]> {
    const lists = await Promise.all(this.feeds.map((f) => this.fetchFeed(f, perFeed)));
    const cutoff = Date.now() - this.maxAgeHours * 3600_000;
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    for (const list of lists) {
      for (const item of list) {
        if (item.publishedAt === undefined || item.publishedAt < cutoff) continue;
        const key = item.title.toLowerCase().slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
    out.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return out;
  }

  /** A random pick among the freshest recent items (weighted to the most recent). */
  async pickOne(): Promise<NewsItem | null> {
    const items = await this.recent();
    if (items.length === 0) return null;
    // pick among the top 10 freshest so it stays recent but not always the exact same headline
    return items[Math.floor(Math.random() * Math.min(items.length, 10))] ?? null;
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

/** Parse RSS <item> or Atom <entry> blocks into NewsItems (with publishedAt when present). */
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
    const dateStr = clean(
      pick(block, 'pubDate') ||
        pick(block, 'published') ||
        pick(block, 'updated') ||
        pick(block, 'dc:date'),
    );
    const ts = dateStr ? Date.parse(dateStr) : NaN;
    const item: NewsItem = { title, link, summary, source };
    if (!Number.isNaN(ts)) item.publishedAt = ts;
    items.push(item);
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
