import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewsService, parseFeed, rankNews } from '../src/news/newsService.js';

const RSS = `<?xml version="1.0"?><rss><channel>
  <item><title>Big thing happened today</title><link>https://ex.com/a</link><description><![CDATA[Some <b>summary</b> here]]></description></item>
  <item><title>Second story</title><link>https://ex.com/b</link><description>Plain &amp; simple</description></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Atom entry one</title><link href="https://ex.com/atom1" rel="alternate"/><summary>atom summary</summary></entry>
</feed>`;

describe('parseFeed', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('parses RSS items with link + cleaned summary', () => {
    const items = parseFeed(RSS, 'ex.com');
    expect(items.length).toBe(2);
    expect(items[0]?.title).toBe('Big thing happened today');
    expect(items[0]?.link).toBe('https://ex.com/a');
    expect(items[0]?.summary).toBe('Some summary here');
    expect(items[1]?.summary).toBe('Plain & simple');
  });

  it('parses Atom entries with href links', () => {
    const items = parseFeed(ATOM, 'ex.com');
    expect(items.length).toBe(1);
    expect(items[0]?.title).toBe('Atom entry one');
    expect(items[0]?.link).toBe('https://ex.com/atom1');
  });

  it('returns [] on junk', () => {
    expect(parseFeed('not xml at all', 'x')).toEqual([]);
  });

  it('ranks fresh group-themed news above generic headlines', () => {
    const now = Date.UTC(2026, 5, 19, 10, 0, 0);
    const ranked = rankNews(
      [
        {
          title: 'Government announces a routine transport plan',
          link: 'https://ex.com/generic',
          summary: 'A normal policy story with no group angle',
          source: 'generic.example',
          publishedAt: now,
        },
        {
          title: 'New AI model exploited by hackers to generate phishing malware',
          link: 'https://ex.com/ai-cyber',
          summary: 'Security researchers warn about LLM abuse and ransomware payloads',
          source: 'security.example',
          publishedAt: now - 60_000,
        },
      ],
      {
        dynamicTerms: ['LLM', 'malware', 'waifu'],
        lore: ['Gooners talk about cybersecurity, AI models and anime waifu posts'],
      },
    );

    expect(ranked[0]?.link).toBe('https://ex.com/ai-cyber');
    expect(ranked[0]?.matchedTopics).toEqual(expect.arrayContaining(['AI', 'cybersecurity']));
  });

  it('keeps only items from today with a parseable date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T10:00:00Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () => `<?xml version="1.0"?><rss><channel>
          <item><title>Today AI story</title><link>https://ex.com/today</link><pubDate>Fri, 19 Jun 2026 09:00:00 GMT</pubDate></item>
          <item><title>Yesterday AI story</title><link>https://ex.com/yesterday</link><pubDate>Thu, 18 Jun 2026 23:30:00 GMT</pubDate></item>
          <item><title>No date story</title><link>https://ex.com/nodate</link></item>
        </channel></rss>`,
      })),
    );

    const service = new NewsService(['https://feed.example/rss'], 500, 24);
    const items = await service.recent();
    expect(items.map((i) => i.link)).toEqual(['https://ex.com/today']);
  });
});
