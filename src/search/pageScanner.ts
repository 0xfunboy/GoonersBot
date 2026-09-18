import * as cheerio from 'cheerio';
import { childLogger } from '../utils/logger.js';
import { fetchSafeRemoteBuffer } from '../utils/safeRemoteFetch.js';
import { extractUrls } from '../providers/media/linkMedia/url.js';

const log = childLogger('page-scanner');

export interface PageSummary {
  url: string;
  title: string;
  text: string;
  facts: string[];
  outboundLinks: string[];
}

/**
 * A bounded, passive audit of one public HTML page. This deliberately reports observable
 * indicators only: it never submits forms, executes JavaScript, crawls authentication boundaries,
 * probes ports, or claims that an indicator is an exploitable vulnerability.
 */
export interface PageAudit {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  title: string;
  quality: {
    score: number;
    title: boolean;
    description: boolean;
    language: boolean;
    viewport: boolean;
    canonical: boolean;
    h1Count: number;
    imageCount: number;
    imagesMissingAlt: number;
    formCount: number;
    scriptCount: number;
    externalScriptCount: number;
    textCharacters: number;
  };
  security: {
    score: number;
    https: boolean;
    strictTransportSecurity: boolean;
    contentSecurityPolicy: boolean;
    frameProtection: boolean;
    contentTypeOptions: boolean;
    referrerPolicy: boolean;
    permissionsPolicy: boolean;
    mixedContentCount: number;
    insecureFormCount: number;
    inlineScriptCount: number;
    findings: string[];
  };
  recommendations: string[];
  limitations: string[];
}

export interface PageScannerConfig {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
}

/** Extract an explicit URL, or a bare public-looking domain such as `example.org` from a request. */
export function extractPageAuditUrl(text: string): URL | null {
  const explicit = extractUrls(text, 1)[0];
  if (explicit) return explicit;
  const bare = text.match(
    /(?<![@\w])(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,}(?::\d{1,5})?(?:\/[^\s<>()]*)?/i,
  )?.[0];
  if (!bare) return null;
  try {
    return new URL(`https://${bare}`);
  } catch {
    return null;
  }
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

  /** Scan a single public page without active testing or authenticated access. */
  async audit(url: string, signal?: AbortSignal): Promise<PageAudit | null> {
    const parsed = safeUrl(url);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
    try {
      const result = await fetchSafeRemoteBuffer(parsed, {
        timeoutMs: this.cfg.timeoutMs,
        // An audit needs a little more than ordinary grounding, but remains firmly bounded.
        maxBytes: Math.min(Math.max(this.cfg.maxBytes, 256_000), 1_500_000),
        signal,
        allowedContentTypes: ['text/html', 'application/xhtml+xml'],
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9',
          'User-Agent': this.cfg.userAgent,
        },
      });
      const finalUrl = new URL(result.finalUrl);
      const html = result.buffer.toString('utf8');
      const $ = cheerio.load(html, { xmlMode: false });
      const title = normalizeText(
        $('meta[property="og:title"]').attr('content') || $('title').first().text(),
      ).slice(0, 180);
      const description = normalizeText(
        $('meta[name="description"]').attr('content') ??
          $('meta[property="og:description"]').attr('content') ??
          '',
      );
      const language = Boolean($('html').attr('lang')?.trim());
      const viewport = Boolean($('meta[name="viewport"]').attr('content')?.trim());
      const canonical = Boolean($('link[rel="canonical"]').attr('href')?.trim());
      const h1Count = $('h1').length;
      const imageCount = $('img').length;
      const imagesMissingAlt = $('img').filter((_, element) => {
        const alt = $(element).attr('alt');
        return alt === undefined || alt.trim() === '';
      }).length;
      const formCount = $('form').length;
      const scriptCount = $('script').length;
      const externalScriptCount = $('script[src]').filter((_, element) => {
        const source = $(element).attr('src');
        if (!source) return false;
        try {
          return new URL(source, finalUrl).hostname !== finalUrl.hostname;
        } catch {
          return false;
        }
      }).length;
      const bodyText = normalizeText($('body').text());
      const mixedContentCount = $(`[src], [href]`)
        .toArray()
        .filter((element) => {
          const value = $(element).attr('src') ?? $(element).attr('href') ?? '';
          return finalUrl.protocol === 'https:' && /^http:\/\//i.test(value);
        }).length;
      const insecureFormCount = $('form[action]')
        .toArray()
        .filter((element) => {
          const action = $(element).attr('action') ?? '';
          return finalUrl.protocol === 'https:' && /^http:\/\//i.test(action);
        }).length;
      const inlineScriptCount = $('script:not([src])').filter((_, element) => {
        return Boolean($(element).text().trim());
      }).length;
      const header = (name: string): boolean => Boolean(result.headers.get(name)?.trim());
      const https = finalUrl.protocol === 'https:';
      const strictTransportSecurity = header('strict-transport-security');
      const contentSecurityPolicy = header('content-security-policy');
      const frameProtection =
        header('x-frame-options') ||
        /(?:^|;)\s*frame-ancestors\s+/i.test(result.headers.get('content-security-policy') ?? '');
      const contentTypeOptions = /nosniff/i.test(
        result.headers.get('x-content-type-options') ?? '',
      );
      const referrerPolicy = header('referrer-policy');
      const permissionsPolicy = header('permissions-policy');
      const findings: string[] = [];
      if (!https) findings.push('La pagina non usa HTTPS.');
      if (https && !strictTransportSecurity) findings.push('Manca Strict-Transport-Security.');
      if (!contentSecurityPolicy) findings.push('Manca Content-Security-Policy.');
      if (!frameProtection) findings.push('Manca una protezione osservabile dal framing.');
      if (!contentTypeOptions) findings.push('Manca X-Content-Type-Options: nosniff.');
      if (mixedContentCount > 0)
        findings.push(`${mixedContentCount} risorse HTTP su una pagina HTTPS.`);
      if (insecureFormCount > 0) findings.push(`${insecureFormCount} form invia dati via HTTP.`);
      const qualityIssues = [
        !title,
        !description,
        !language,
        !viewport,
        !canonical,
        h1Count !== 1,
        imageCount > 0 && imagesMissingAlt > 0,
      ].filter(Boolean).length;
      const qualityScore = Math.max(0, Math.round(100 - qualityIssues * 12));
      const securityChecks = [
        https,
        !https || strictTransportSecurity,
        contentSecurityPolicy,
        frameProtection,
        contentTypeOptions,
        referrerPolicy,
        permissionsPolicy,
        mixedContentCount === 0,
        insecureFormCount === 0,
      ];
      const securityScore = Math.round(
        (securityChecks.filter(Boolean).length / securityChecks.length) * 100,
      );
      const recommendations = [
        ...(!title ? ['Aggiungere un title descrittivo e unico.'] : []),
        ...(!description ? ['Aggiungere una meta description utile.'] : []),
        ...(!language ? ['Dichiarare lang sull’elemento html.'] : []),
        ...(!viewport ? ['Aggiungere il meta viewport per il mobile.'] : []),
        ...(h1Count !== 1 ? ['Usare un solo H1 coerente con il contenuto principale.'] : []),
        ...(imagesMissingAlt > 0 ? ['Aggiungere alt testuali alle immagini informative.'] : []),
        ...findings.slice(0, 8),
      ];
      return {
        url: parsed.toString(),
        finalUrl: finalUrl.toString(),
        status: result.status,
        contentType: result.contentType,
        bytes: result.buffer.byteLength,
        title,
        quality: {
          score: qualityScore,
          title: Boolean(title),
          description: Boolean(description),
          language,
          viewport,
          canonical,
          h1Count,
          imageCount,
          imagesMissingAlt,
          formCount,
          scriptCount,
          externalScriptCount,
          textCharacters: bodyText.length,
        },
        security: {
          score: securityScore,
          https,
          strictTransportSecurity,
          contentSecurityPolicy,
          frameProtection,
          contentTypeOptions,
          referrerPolicy,
          permissionsPolicy,
          mixedContentCount,
          insecureFormCount,
          inlineScriptCount,
          findings,
        },
        recommendations: [...new Set(recommendations)].slice(0, 16),
        limitations: [
          'Analisi passiva della sola pagina HTML pubblica; non è un pentest e non prova vulnerabilità sfruttabili.',
          'Non sono stati analizzati codice server-side, autenticazione, database o endpoint non linkati.',
        ],
      };
    } catch (err) {
      log.debug({ err, url }, 'page audit failed');
      return null;
    }
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

/** Small functional entry point for callers that do not need to keep a scanner instance. */
export function scanPublicPage(
  url: string,
  config: PageScannerConfig,
  signal?: AbortSignal,
): Promise<PageAudit | null> {
  return new PageScanner(config).audit(url, signal);
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
