import { hostMatchesAny } from '../../providers/media/linkMedia/hosts.js';
import { fetchSafeRemoteBuffer } from '../../utils/safeRemoteFetch.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ARCHIVE_TEXT_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'application/json',
  'text/plain',
] as const;

export interface AnimeArchiveHttpRequest {
  allowedHosts: readonly string[];
  signal?: AbortSignal | undefined;
  referer?: string | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  allowedContentTypes?: readonly string[] | undefined;
}

export interface AnimeArchiveHttpResponse {
  text: string;
  finalUrl: string;
  contentType: string;
}

/** Small injectable boundary so adapter fixtures never need a live source. */
export interface AnimeArchiveHttpClient {
  fetchText(url: string | URL, request: AnimeArchiveHttpRequest): Promise<AnimeArchiveHttpResponse>;
}

export interface SafeAnimeArchiveHttpClientOptions {
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  userAgent?: string | undefined;
  maxRedirects?: number | undefined;
}

/**
 * Bounded fetcher backed by the repository's DNS-rebinding/SSRF-safe transport. The per-request
 * validator is applied both to the initial URL and to every redirect hop.
 */
export class SafeAnimeArchiveHttpClient implements AnimeArchiveHttpClient {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly userAgent: string;
  private readonly maxRedirects: number;

  constructor(options: SafeAnimeArchiveHttpClientOptions = {}) {
    this.timeoutMs = positiveInteger(options.timeoutMs, 15_000, 'timeout');
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      2 * 1024 * 1024,
      'response byte limit',
    );
    this.maxRedirects = nonNegativeInteger(options.maxRedirects, 3, 'redirect limit');
    this.userAgent = options.userAgent?.trim() || DEFAULT_USER_AGENT;
  }

  async fetchText(
    rawUrl: string | URL,
    request: AnimeArchiveHttpRequest,
  ): Promise<AnimeArchiveHttpResponse> {
    const initial = assertAllowedArchiveUrl(rawUrl, request.allowedHosts);
    const result = await fetchSafeRemoteBuffer(initial, {
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxResponseBytes,
      maxRedirects: this.maxRedirects,
      signal: request.signal,
      allowedContentTypes: request.allowedContentTypes ?? ARCHIVE_TEXT_CONTENT_TYPES,
      validateUrl: (url) => {
        assertAllowedArchiveUrl(url, request.allowedHosts);
      },
      headers: {
        'user-agent': this.userAgent,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.7',
        ...(request.referer ? { referer: safeReferer(request.referer) } : {}),
        ...(request.headers ?? {}),
      },
    });
    return {
      text: result.buffer.toString('utf8'),
      finalUrl: result.finalUrl,
      contentType: result.contentType,
    };
  }
}

/** Synchronous host boundary check; the shared transport additionally checks resolved addresses. */
export function assertAllowedArchiveUrl(
  rawUrl: string | URL,
  allowedHosts: readonly string[],
): URL {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
  } catch {
    throw new Error('invalid anime archive URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('anime archive URL protocol is not allowed');
  }
  if (url.username || url.password) {
    throw new Error('anime archive URL credentials are not allowed');
  }
  if (!hostMatchesAny(url, allowedHosts)) {
    throw new Error('anime archive URL host is not allowed');
  }
  return url;
}

/** Safe representation for logs/errors: keep the useful host/path and hide the entire query. */
export function redactSignedUrl(rawUrl: string | URL): string {
  try {
    const url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
    url.username = '';
    url.password = '';
    if (url.search) url.search = '?[redacted]';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

export function expiryFromUrl(rawUrl: string | URL): Date | undefined {
  try {
    const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
    const seconds = Number(url.searchParams.get('expires'));
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  } catch {
    return undefined;
  }
}

function safeReferer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid anime archive referer');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('anime archive referer is not allowed');
  }
  return url.toString();
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${label} must be positive`);
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be non-negative`);
  }
  return resolved;
}
