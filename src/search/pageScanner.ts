import * as cheerio from 'cheerio';
import { childLogger } from '../utils/logger.js';
import { fetchSafeRemoteBuffer } from '../utils/safeRemoteFetch.js';

const log = childLogger('page-scanner');

export interface PageSummary {
  url: string;
  title: string;
  text: string;
  facts: string[];
  outboundLinks: string[];
}

export interface PageScannerConfig {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
}

export class PageScanner {
  constructor(private readonly cfg: PageScannerConfig) {}

  async scan(urls: string[], signal?: AbortSignal): Promise<PageSummary[]> {
    const unique = [...new Set(urls)].slice(0, 4);
    const pages = await Promise.all(
      unique.map((url) => this.scanOne(url, signal).catch(() => null)),
    );
    return pages.filter((p): p is PageSummary => Boolean(p));
  }

  private async scanOne(url: string, signal?: AbortSignal): Promise<PageSummary | null> {
    const parsed = safeUrl(url);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
    try {
      const result = await fetchSafeRemoteBuffer(parsed, {
        timeoutMs: this.cfg.timeoutMs,
        maxBytes: this.cfg.maxBytes,
        signal,
        allowedContentTypes: ['text/html', 'application/xhtml+xml'],
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': this.cfg.userAgent,
        },
      });
      const finalUrl = new URL(result.finalUrl);
      const html = result.buffer.toString('utf8');
      const $ = cheerio.load(html);
      $('script,style,noscript,svg,iframe,form').remove();
      const title = normalizeText(
        $('meta[property="og:title"]').attr('content') || $('title').first().text(),
      ).slice(0, 180);
      const mainText = normalizeText(
        [
          $('meta[name="description"]').attr('content') ?? '',
          $('meta[property="og:description"]').attr('content') ?? '',
          $('main').text() || $('article').text() || $('body').text(),
        ].join(' '),
      ).slice(0, 1800);
      const outboundLinks = $('a[href]')
        .map((_, el) => absolutize($(el).attr('href') ?? '', finalUrl))
        .get()
        .filter((href): href is string => Boolean(href))
        .filter((href, index, arr) => arr.indexOf(href) === index)
        .slice(0, 12);
      return {
        url: finalUrl.toString(),
        title,
        text: mainText,
        facts: extractFacts(mainText),
        outboundLinks,
      };
    } catch (err) {
      log.debug({ err, url }, 'page scan failed');
      return null;
    }
  }
}

function extractFacts(text: string): string[] {
  const facts = new Set<string>();
  for (const match of text.matchAll(/(?:€|\$|£)\s?\d[\d.,]*(?:\s?(?:€|euro|usd|dollars?))?/gi)) {
    facts.add(match[0].trim());
  }
  for (const match of text.matchAll(
    /\b\d[\d.,]*\s?(?:€|euro|usd|dollars?|dollari|gb|tb|kg|km|%)\b/gi,
  )) {
    facts.add(match[0].trim());
  }
  for (const match of text.matchAll(
    /\b(?:available|disponibile|availability|prezzo|price|from|da)\b.{0,80}/gi,
  )) {
    facts.add(normalizeText(match[0]));
  }
  for (const match of text.matchAll(/\+?\d[\d\s()./-]{6,}\d/g)) {
    facts.add(normalizeText(match[0]));
  }
  return [...facts].slice(0, 12);
}

function absolutize(href: string, base: URL): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
