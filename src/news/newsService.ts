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

export interface NewsRankingProfile {
  /** Stable chat identity/name, useful only for debug/log context. */
  chatName?: string | undefined;
  /** Terms inferred from recent chat messages and durable lore. */
  dynamicTerms?: string[] | undefined;
  /** Lore snippets used to bias the ranker toward the group's actual culture. */
  lore?: string[] | undefined;
}

export interface RankedNewsItem extends NewsItem {
  score: number;
  matchedTopics: string[];
  matchedTerms: string[];
}

const TOPIC_RULES: { topic: string; weight: number; terms: RegExp[] }[] = [
  {
    topic: 'AI',
    weight: 3.5,
    terms: [
      /\b(ai|artificial intelligence|intelligenza artificiale|llm|gpt|openai|gemini|claude|ollama)\b/i,
      /\b(model|modello|neural|machine learning|deep learning|generative|prompt|token|inference)\b/i,
    ],
  },
  {
    topic: 'cybersecurity',
    weight: 3.4,
    terms: [
      /\b(cyber|security|sicurezza|hacker|hackers|hacking|malware|ransomware|phishing|exploit)\b/i,
      /\b(vulnerability|vulnerabilit|cve|zero-day|breach|data leak|password|botnet|infosec)\b/i,
    ],
  },
  {
    topic: 'waifu/anime',
    weight: 3.2,
    terms: [
      /\b(waifu|anime|manga|vtuber|cosplay|gacha|hentai|ahegao|kawaii|best girl)\b/i,
      /\b(japan|giappone|tokyo|nintendo|playstation|gaming|otaku|idol)\b/i,
    ],
  },
  {
    topic: 'finance/crypto',
    weight: 2.6,
    terms: [
      /\b(finance|finanza|market|markets|borsa|stock|stocks|crypto|bitcoin|ethereum|solana)\b/i,
      /\b(etf|fed|inflation|inflazione|trading|bond|yield|wallet|token|defi|memecoin)\b/i,
    ],
  },
  {
    topic: 'dating/social chaos',
    weight: 1.9,
    terms: [
      /\b(dating|tinder|onlyfans|instagram|tiktok|influencer|creator|sex|nsfw|adult)\b/i,
      /\b(figa|ragazza|ragazze|donna|donne|relazioni|relationship|appuntamenti)\b/i,
    ],
  },
];

const BASE_GOONERS_TERMS = [
  'waifu',
  'anime',
  'manga',
  'cybersecurity',
  'sicurezza',
  'hacker',
  'malware',
  'AI',
  'LLM',
  'OpenAI',
  'Gemini',
  'Ollama',
  'finanza',
  'crypto',
  'bitcoin',
  'figa',
  'dating',
];

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
    const today = startOfUtcDay(Date.now());
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    for (const list of lists) {
      for (const item of list) {
        if (
          item.publishedAt === undefined ||
          item.publishedAt < cutoff ||
          item.publishedAt < today
        ) {
          continue;
        }
        const key = item.title.toLowerCase().slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
    out.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return out;
  }

  /** Fresh items ranked for the target chat/group. */
  async ranked(profile: NewsRankingProfile = {}, perFeed = 16): Promise<RankedNewsItem[]> {
    const items = await this.recent(perFeed);
    return rankNews(items, profile);
  }

  /** A pick among fresh, on-theme recent items. */
  async pickOne(profile: NewsRankingProfile = {}): Promise<RankedNewsItem | null> {
    const items = await this.recent();
    if (items.length === 0) return null;
    const ranked = rankNews(items, profile);
    const pool = ranked.slice(0, Math.min(ranked.length, 5));
    return weightedPick(pool);
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

export function rankNews(items: NewsItem[], profile: NewsRankingProfile = {}): RankedNewsItem[] {
  const dynamicTerms = normalizeTerms([
    ...BASE_GOONERS_TERMS,
    ...(profile.dynamicTerms ?? []),
    ...(profile.lore ?? []),
  ]);
  const newest = Math.max(0, ...items.map((i) => i.publishedAt ?? 0));
  const sixHours = 6 * 3600_000;

  return items
    .map((item) => {
      const haystack = `${item.title} ${item.summary} ${item.source}`.toLowerCase();
      const matchedTopics: string[] = [];
      const matchedTerms: string[] = [];
      let score = 0;

      for (const rule of TOPIC_RULES) {
        const hits = rule.terms.filter((r) => r.test(haystack)).length;
        if (hits > 0) {
          matchedTopics.push(rule.topic);
          score += rule.weight + Math.min(1.5, hits * 0.5);
        }
      }

      for (const term of dynamicTerms) {
        if (term.length < 3) continue;
        if (haystack.includes(term.toLowerCase())) {
          matchedTerms.push(term);
          score += term.length > 6 ? 0.9 : 0.45;
        }
      }

      const age = newest > 0 && item.publishedAt ? newest - item.publishedAt : 0;
      score += Math.max(0, 2 - age / sixHours);
      if (matchedTopics.length === 0 && matchedTerms.length === 0) score -= 2.5;

      return { ...item, score, matchedTopics, matchedTerms: matchedTerms.slice(0, 8) };
    })
    .sort((a, b) => b.score - a.score || (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
}

function weightedPick(items: RankedNewsItem[]): RankedNewsItem | null {
  if (items.length === 0) return null;
  const min = Math.min(...items.map((i) => i.score));
  const weights = items.map((i) => Math.max(0.25, i.score - min + 0.5));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return items[i] ?? null;
  }
  return items[0] ?? null;
}

function normalizeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    for (const term of raw.split(/[^a-zA-Z0-9À-ÿ+#.]+/)) {
      const cleaned = term.trim();
      if (cleaned.length < 3 || STOPWORDS.has(cleaned.toLowerCase())) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
      if (out.length >= 80) return out;
    }
  }
  return out;
}

function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const STOPWORDS = new Set([
  'che',
  'con',
  'del',
  'della',
  'delle',
  'degli',
  'gli',
  'per',
  'una',
  'uno',
  'the',
  'and',
  'for',
  'you',
  'are',
  'from',
  'this',
  'that',
  'have',
  'has',
  'not',
  'but',
  'come',
  'sono',
  'non',
  'sul',
  'nel',
  'tra',
]);

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
