import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { childLogger } from '../utils/logger.js';
import { fetchSafeRemoteBuffer } from '../utils/safeRemoteFetch.js';
import { extractUrls } from '../providers/media/linkMedia/url.js';
import { createAbortScope } from '../utils/abort.js';
import { redactSecrets } from '../utils/secrets.js';

const log = childLogger('page-scanner');

export interface PageSummary {
  url: string;
  /** Original requested identity survives a validated redirect; url is the final citation. */
  requestedUrl?: string;
  inspectedAt?: string;
  extractedTextSha256?: string;
  title: string;
  text: string;
  facts: string[];
  outboundLinks: string[];
}

/**
 * A bounded, passive audit of a public HTML page and selected same-origin public sources.
 * This deliberately reports observable
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
  inspectedAt?: string;
  sha256?: string;
  sources?: PageAuditSource[];
  coverage?: {
    maxBytes: number;
    consumedBudgetBytes: number;
    downloadedBytes: number;
    elapsedMs: number;
    omittedCandidates: number;
    budgetExhausted: boolean;
    rendered: false;
  };
}

export interface PageAuditSource {
  url: string;
  kind: 'script' | 'stylesheet' | 'page';
  status: 'inspected' | 'unavailable' | 'budget_exhausted';
  finalUrl?: string;
  contentType?: string;
  bytes?: number;
  sha256?: string;
  title?: string;
  observations: Array<{ description: string; line?: number; excerpt?: string }>;
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

  /** Inspect public sources within one byte/time budget, without active testing or authentication. */
  async audit(url: string, signal?: AbortSignal): Promise<PageAudit | null> {
    const parsed = safeUrl(url);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
    const startedAt = Date.now();
    const scope = createAbortScope(this.cfg.timeoutMs, signal, 'passive site audit');
    const mainByteLimit = Math.min(Math.max(this.cfg.maxBytes, 256_000), 1_500_000);
    const totalByteLimit = Math.min(mainByteLimit * 2, 2_000_000);
    try {
      const result = await fetchSafeRemoteBuffer(parsed, {
        timeoutMs: this.cfg.timeoutMs,
        // An audit needs a little more than ordinary grounding, but remains firmly bounded.
        maxBytes: mainByteLimit,
        signal: scope.signal,
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
        // Empty alt is valid for decorative images; intent cannot be inferred from HTML alone.
        return alt === undefined;
      }).length;
      const formCount = $('form').length;
      const scriptCount = $('script').length;
      const externalScriptCount = $('script[src]').filter((_, element) => {
        const source = $(element).attr('src');
        if (!source) return false;
        try {
          return new URL(source, finalUrl).origin !== finalUrl.origin;
        } catch {
          return false;
        }
      }).length;
      const visibleBody = $('body').clone();
      visibleBody.find('script,style,noscript').remove();
      const bodyText = normalizeText(visibleBody.text());
      const mixedContentCount = $(
        'img[src],script[src],iframe[src],audio[src],video[src],source[src],link[rel~="stylesheet"][href]',
      )
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
      const inspection = await inspectLinkedSources($, finalUrl, {
        deadline: startedAt + this.cfg.timeoutMs,
        maxBytes: totalByteLimit,
        usedBytes: result.buffer.byteLength,
        userAgent: this.cfg.userAgent,
        signal: scope.signal,
      });
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
          'Analisi passiva di HTML e fonti pubbliche elencate; non è un pentest e non prova vulnerabilità sfruttabili.',
          'JavaScript non eseguito: comportamento dinamico, aspetto renderizzato e percorsi di dati non sono verificati.',
          'Non sono stati analizzati codice server-side, autenticazione, database o endpoint non linkati.',
          ...(inspection.coverage.omittedCandidates > 0
            ? ['Il campione è limitato: altre risorse e pagine non sono state lette.']
            : []),
          ...(inspection.coverage.budgetExhausted
            ? [
                'Il budget condiviso di tempo o byte è stato raggiunto; le fonti non lette sono indicate.',
              ]
            : []),
          ...(inspection.sources.some((source) => source.status === 'unavailable')
            ? [
                'Alcune fonti non sono state acquisite; la loro disponibilità o il motivo del mancato accesso non sono dedotti.',
              ]
            : []),
        ],
        inspectedAt: new Date(startedAt).toISOString(),
        sha256: hashSource(result.buffer),
        sources: inspection.sources,
        coverage: { ...inspection.coverage, elapsedMs: Date.now() - startedAt, rendered: false },
      };
    } catch (err) {
      log.debug({ err, url }, 'page audit failed');
      return null;
    } finally {
      scope.dispose();
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
        requestedUrl: url,
        inspectedAt: new Date().toISOString(),
        extractedTextSha256: createHash('sha256').update(mainText).digest('hex'),
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

type SourceCandidate = Pick<PageAuditSource, 'url' | 'kind'>;

async function inspectLinkedSources(
  $: cheerio.CheerioAPI,
  origin: URL,
  options: {
    deadline: number;
    maxBytes: number;
    usedBytes: number;
    userAgent: string;
    signal: AbortSignal;
  },
): Promise<{
  sources: PageAuditSource[];
  coverage: {
    maxBytes: number;
    consumedBudgetBytes: number;
    downloadedBytes: number;
    omittedCandidates: number;
    budgetExhausted: boolean;
  };
}> {
  const candidates: SourceCandidate[] = [];
  const seen = new Set([origin.toString().split('#')[0]]);
  let documentBase = origin;
  try {
    documentBase = new URL($('base[href]').first().attr('href') ?? origin.toString(), origin);
  } catch {
    // Invalid base tags fall back to the response URL, as for the page itself.
  }
  const add = (raw: string | undefined, kind: SourceCandidate['kind']): void => {
    if (!raw || raw.startsWith('#')) return;
    try {
      const target = new URL(raw, documentBase);
      target.hash = '';
      if (
        target.origin !== origin.origin ||
        target.username ||
        target.password ||
        seen.has(target.toString())
      )
        return;
      // Follow only linked public documents, never login/logout, account actions, APIs or downloads.
      if (
        kind === 'page' &&
        (/(?:^|\/)(?:api|admin|login|logout|signin|signout|signup|register|account|checkout|delete|remove)(?:\/|[.?_-]|$)/i.test(
          target.pathname,
        ) ||
          /(?:^|[?&])(?:action|logout|delete|remove|token|key|auth)=/i.test(target.search) ||
          (/\.[a-z\d]{2,6}$/i.test(target.pathname) &&
            !/\.(?:html?|php|aspx?)$/i.test(target.pathname)))
      )
        return;
      seen.add(target.toString());
      candidates.push({ url: target.toString(), kind });
    } catch {
      // Invalid links are not acquisition targets.
    }
  };
  $('script[src]').each((_, element) => add($(element).attr('src'), 'script'));
  $('link[rel~="stylesheet"][href]').each((_, element) =>
    add($(element).attr('href'), 'stylesheet'),
  );
  $('a[href]:not([download])').each((_, element) => add($(element).attr('href'), 'page'));
  const scripts = candidates.filter((candidate) => candidate.kind === 'script');
  const styles = candidates.filter((candidate) => candidate.kind === 'stylesheet');
  // Cover both kinds when available, rather than spending every asset slot on a script bundle.
  const assets = [scripts[0], styles[0], ...scripts.slice(1), ...styles.slice(1)]
    .filter((candidate): candidate is SourceCandidate => candidate !== undefined)
    .slice(0, 3);
  const selected = [
    ...assets,
    ...candidates.filter((candidate) => candidate.kind === 'page').slice(0, 2),
  ];
  let consumedBudgetBytes = options.usedBytes;
  let downloadedBytes = options.usedBytes;
  let budgetExhausted = false;
  const sources: PageAuditSource[] = [];
  for (const candidate of selected) {
    const remainingMs = options.deadline - Date.now();
    const allowance = Math.min(256_000, options.maxBytes - consumedBudgetBytes);
    if (remainingMs < 1 || allowance < 1 || options.signal.aborted) {
      budgetExhausted = true;
      sources.push({ ...candidate, status: 'budget_exhausted', observations: [] });
      continue;
    }
    try {
      const result = await fetchSafeRemoteBuffer(candidate.url, {
        timeoutMs: remainingMs,
        maxBytes: allowance,
        signal: options.signal,
        maxRedirects: 2,
        validateUrl: (target) => {
          if (target.origin !== origin.origin)
            throw new Error('audit source redirected outside the selected origin');
        },
        allowedContentTypes:
          candidate.kind === 'page'
            ? ['text/html', 'application/xhtml+xml']
            : candidate.kind === 'stylesheet'
              ? ['text/css']
              : [
                  'text/javascript',
                  'application/javascript',
                  'application/x-javascript',
                  'text/ecmascript',
                  'application/ecmascript',
                ],
        headers: {
          'User-Agent': options.userAgent,
          Accept: candidate.kind === 'page' ? 'text/html,application/xhtml+xml' : '*/*',
        },
      });
      consumedBudgetBytes += result.buffer.byteLength;
      downloadedBytes += result.buffer.byteLength;
      const text = result.buffer.toString('utf8');
      const page = candidate.kind === 'page' ? cheerio.load(text) : undefined;
      sources.push({
        ...candidate,
        status: 'inspected',
        finalUrl: result.finalUrl,
        contentType: result.contentType,
        bytes: result.buffer.byteLength,
        sha256: hashSource(result.buffer),
        ...(page ? { title: normalizeText(page('title').first().text()).slice(0, 180) } : {}),
        observations: inspectSourceText(candidate.kind, text, page),
      });
    } catch {
      // The fetcher may have consumed a partial body. Reserve its entire allowance so failed
      // acquisitions cannot reset the shared byte budget and repeatedly download large sources.
      consumedBudgetBytes += allowance;
      budgetExhausted ||=
        options.signal.aborted ||
        Date.now() >= options.deadline ||
        consumedBudgetBytes >= options.maxBytes;
      sources.push({ ...candidate, status: 'unavailable', observations: [] });
    }
  }
  return {
    sources,
    coverage: {
      maxBytes: options.maxBytes,
      consumedBudgetBytes,
      downloadedBytes,
      omittedCandidates: candidates.length - selected.length,
      budgetExhausted,
    },
  };
}

function inspectSourceText(
  kind: SourceCandidate['kind'],
  text: string,
  page?: cheerio.CheerioAPI,
): PageAuditSource['observations'] {
  if (page) {
    const observations = [
      {
        description: `HTML acquisito: H1=${page('h1').length}; immagini=${page('img').length}; form=${page('form').length}; script=${page('script').length}.`,
      },
    ];
    page('script,style,noscript').remove();
    const excerpt = normalizeText(page('main,article').first().text() || page('body').text()).slice(
      0,
      400,
    );
    if (excerpt)
      observations.push({ description: `Estratto del contenuto: ${redactSecrets(excerpt)}` });
    return observations;
  }
  const patterns =
    kind === 'script'
      ? [
          { pattern: /\b(?:innerHTML|outerHTML)\s*=/, label: 'assegnazione HTML' },
          { pattern: /\bdocument\.write\s*\(/, label: 'document.write' },
          { pattern: /\beval\s*\(|\bnew\s+Function\s*\(/, label: 'valutazione dinamica di codice' },
        ]
      : [
          { pattern: /@media\b/, label: 'media query' },
          { pattern: /@supports\b/, label: 'feature query CSS' },
          { pattern: /!important\b/, label: 'override !important' },
        ];
  const observations: PageAuditSource['observations'] = [];
  for (const { pattern, label } of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length;
    const start = Math.max(text.lastIndexOf('\n', match.index) + 1, match.index - 60);
    const endOfLine = text.indexOf('\n', match.index);
    const end = Math.min(endOfLine === -1 ? text.length : endOfLine, match.index + 140);
    observations.push({
      description: `Pattern testuale «${label}» presente; contesto ed esecuzione non verificati${kind === 'script' ? ', non dimostra una vulnerabilità' : ''}.`,
      line,
      excerpt: redactSecrets(text.slice(start, end)),
    });
  }
  if (!observations.length)
    observations.push({
      description:
        'Fonte acquisita; nessuno dei pattern limitati controllati è presente. Non è una valutazione completa della correttezza.',
    });
  return observations;
}

function hashSource(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
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
