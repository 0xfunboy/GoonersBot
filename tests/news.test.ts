import { describe, expect, it } from 'vitest';
import { parseFeed } from '../src/news/newsService.js';

const RSS = `<?xml version="1.0"?><rss><channel>
  <item><title>Big thing happened today</title><link>https://ex.com/a</link><description><![CDATA[Some <b>summary</b> here]]></description></item>
  <item><title>Second story</title><link>https://ex.com/b</link><description>Plain &amp; simple</description></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Atom entry one</title><link href="https://ex.com/atom1" rel="alternate"/><summary>atom summary</summary></entry>
</feed>`;

describe('parseFeed', () => {
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
});
