import { lookup as dnsLookupCallback } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { open as openFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { createAbortScope, throwIfAborted } from './abort.js';

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const;
const UNSAFE_REQUEST_HEADERS = [
  'connection',
  'content-length',
  'host',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Re-check the address returned for the actual socket connection. A separate pre-flight DNS check
 * is useful for fast rejection, but is not sufficient by itself because DNS can change between
 * validation and connect.
 */
function guardedLookup(hostname: string, options: any, callback: any): void {
  dnsLookupCallback(hostname, options, (err: any, address: any, family: any) => {
    if (err) {
      callback(err, address, family);
      return;
    }
    const addresses = Array.isArray(address) ? address : [{ address, family }];
    if (
      addresses.some(
        (entry) => typeof entry?.address !== 'string' || isBlockedNetworkAddress(entry.address),
      )
    ) {
      callback(new Error('remote address is not publicly routable'), '', 0);
      return;
    }
    callback(null, address, family);
  });
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup as any } });
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SafeRemoteFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  headers?: RequestInit['headers'];
  /**
   * Exact media types or wildcard families such as `image/*`. When supplied, a missing or
   * mismatching Content-Type is rejected before the body is read.
   */
  allowedContentTypes?: readonly string[];
  maxRedirects?: number;
  /** Optional caller policy, re-applied to the initial URL and every redirect target. */
  validateUrl?: ((url: URL) => void | Promise<void>) | undefined;
}

export interface SafeRemoteFetchResult {
  buffer: Buffer;
  finalUrl: string;
  status: number;
  headers: Headers;
  contentType: string;
}

export interface SafeRemoteDownloadResult {
  bytes: number;
  finalUrl: string;
  status: number;
  headers: Headers;
  contentType: string;
}

interface OpenedResponse {
  response: Response;
  finalUrl: URL;
}

/** Bounded reader for trusted configured endpoints where SSRF filtering must not be applied. */
export async function readBoundedResponseBuffer(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('response byte limit must be a positive integer');
  }
  ensureDeclaredLength(response, maxBytes);
  const chunks: Buffer[] = [];
  const bytes = await consumeBounded(response, maxBytes, signal, async (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  return bytes === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, bytes);
}

/**
 * Reject literal or resolved loopback, private, link-local, metadata, multicast and special-use
 * network targets. Operator-configured provider base URLs intentionally do not use this guard;
 * this is for URLs derived from users, web results or remote provider responses.
 */
export async function assertSafeRemoteUrl(
  rawUrl: string | URL,
  signal?: AbortSignal,
): Promise<URL> {
  throwIfAborted(signal);
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
  } catch {
    throw new Error('invalid remote URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('remote URL protocol is not allowed');
  }
  if (url.username || url.password) {
    throw new Error('remote URL credentials are not allowed');
  }

  const host = normalizeHostname(url.hostname);
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('remote host is not publicly routable');
  }
  if (net.isIP(host) !== 0) {
    if (isBlockedNetworkAddress(host)) {
      throw new Error('remote address is not publicly routable');
    }
    return url;
  }

  const addresses = await raceWithAbort(
    dnsLookup(host, { all: true, verbatim: true }),
    signal,
  ).catch((err: unknown) => {
    if (signal?.aborted) throw abortReason(signal);
    throw err;
  });
  if (addresses.length === 0 || addresses.some((entry) => isBlockedNetworkAddress(entry.address))) {
    throw new Error('remote host is not publicly routable');
  }
  throwIfAborted(signal);
  return url;
}

/** Fetch a user/result-derived URL into memory without ever allocating more than `maxBytes`. */
export async function fetchSafeRemoteBuffer(
  rawUrl: string | URL,
  opts: SafeRemoteFetchOptions,
): Promise<SafeRemoteFetchResult> {
  return withSafeRemoteResponse(rawUrl, opts, async ({ response, finalUrl, contentType }) => {
    const chunks: Buffer[] = [];
    const bytes = await consumeBounded(response, opts.maxBytes, opts.signal, async (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    return {
      buffer: bytes === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, bytes),
      finalUrl: finalUrl.toString(),
      status: response.status,
      headers: new Headers(response.headers),
      contentType,
    };
  });
}

/** Stream a user/result-derived URL to a file while enforcing the same network and byte guards. */
export async function downloadSafeRemoteFile(
  rawUrl: string | URL,
  destination: string,
  opts: SafeRemoteFetchOptions,
): Promise<SafeRemoteDownloadResult> {
  return withSafeRemoteResponse(rawUrl, opts, async ({ response, finalUrl, contentType }) => {
    const file = await openFile(destination, 'w');
    let position = 0;
    try {
      const bytes = await consumeBounded(response, opts.maxBytes, opts.signal, async (chunk) => {
        const buffer = Buffer.from(chunk);
        let offset = 0;
        while (offset < buffer.length) {
          const written = await file.write(
            buffer,
            offset,
            buffer.length - offset,
            position + offset,
          );
          if (written.bytesWritten <= 0) throw new Error('remote file write made no progress');
          offset += written.bytesWritten;
        }
        position += buffer.length;
      });
      return {
        bytes,
        finalUrl: finalUrl.toString(),
        status: response.status,
        headers: new Headers(response.headers),
        contentType,
      };
    } catch (err) {
      await file.close().catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      throw err;
    } finally {
      await file.close().catch(() => undefined);
    }
  });
}

export function isBlockedNetworkAddress(rawAddress: string): boolean {
  const address = normalizeHostname(rawAddress);
  const version = net.isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version !== 6) return true;

  const words = parseIpv6(address);
  if (!words) return true;
  const [first = 0, second = 0] = words;

  if (words.every((word) => word === 0)) return true; // unspecified
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true; // loopback
  if ((first & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && second === 0x0db8) return true; // documentation

  // IPv4-mapped/compatible forms, including URL-canonicalized ::ffff:7f00:1.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    return isBlockedIpv4(embeddedIpv4(words));
  }

  // Well-known NAT64 prefix; a public-looking IPv6 literal can otherwise tunnel to private IPv4.
  if (first === 0x0064 && second === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    return isBlockedIpv4(embeddedIpv4(words));
  }
  // 6to4 embeds the destination IPv4 address in the next 32 bits.
  if (first === 0x2002) {
    const high = words[1] ?? 0;
    const low = words[2] ?? 0;
    return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return false;
}

async function withSafeRemoteResponse<T>(
  rawUrl: string | URL,
  opts: SafeRemoteFetchOptions,
  consume: (opened: OpenedResponse & { contentType: string }) => Promise<T>,
): Promise<T> {
  validateLimits(opts);
  const scope = createAbortScope(opts.timeoutMs, opts.signal, 'remote fetch');
  let opened: OpenedResponse | undefined;
  try {
    opened = await openSafeResponse(rawUrl, opts, scope.signal);
    ensureSuccessful(opened.response);
    ensureDeclaredLength(opened.response, opts.maxBytes);
    const contentType = normalizedContentType(opened.response.headers.get('content-type'));
    ensureContentType(contentType, opts.allowedContentTypes);
    return await consume({ ...opened, contentType });
  } finally {
    if (opened && !opened.response.bodyUsed) {
      await opened.response.body?.cancel().catch(() => undefined);
    }
    scope.dispose();
  }
}

async function openSafeResponse(
  rawUrl: string | URL,
  opts: SafeRemoteFetchOptions,
  signal: AbortSignal,
): Promise<OpenedResponse> {
  let current = await assertSafeRemoteUrl(rawUrl, signal);
  await opts.validateUrl?.(new URL(current));
  let headers = sanitizedHeaders(opts.headers);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  for (let hop = 0; ; hop += 1) {
    throwIfAborted(signal);
    const requestInit = {
      method: 'GET',
      redirect: 'manual' as const,
      signal,
    };
    // Unit tests replace the global transport to exercise redirects, limits and cancellation
    // without opening sockets. Production always uses the matching undici fetch+Agent pair so the
    // connect-time DNS guard cannot be bypassed by a rebinding between validation and the socket.
    const response =
      process.env['NODE_ENV'] === 'test'
        ? await fetch(current, { ...requestInit, headers })
        : await undiciFetch(current, {
            ...requestInit,
            headers: Object.fromEntries(headers.entries()),
            dispatcher: guardedAgent,
          });

    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current };
    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: current };
    await response.body?.cancel().catch(() => undefined);
    if (hop >= maxRedirects) throw new Error('too many remote redirects');

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error('invalid remote redirect');
    }
    next = await assertSafeRemoteUrl(next, signal);
    await opts.validateUrl?.(new URL(next));
    if (next.origin !== current.origin) {
      headers = new Headers(headers);
      for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name);
    }
    current = next;
  }
}

async function consumeBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) return 0;
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        return total;
      }
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('remote response exceeds byte limit');
      await onChunk(value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function validateLimits(opts: SafeRemoteFetchOptions): void {
  if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1) {
    throw new Error('remote byte limit must be a positive integer');
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1) {
    throw new Error('remote timeout must be positive');
  }
  if (
    opts.maxRedirects !== undefined &&
    (!Number.isSafeInteger(opts.maxRedirects) || opts.maxRedirects < 0)
  ) {
    throw new Error('remote redirect limit must be a non-negative integer');
  }
}

function ensureSuccessful(response: Response): void {
  if (!response.ok) throw new Error(`remote HTTP ${response.status}`);
}

function ensureDeclaredLength(response: Response, maxBytes: number): void {
  const raw = response.headers.get('content-length')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return;
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    throw new Error('remote response exceeds byte limit');
  }
}

function ensureContentType(contentType: string, allowed?: readonly string[]): void {
  if (!allowed || allowed.length === 0) return;
  if (!contentType) throw new Error('remote response has no Content-Type');
  const matches = allowed.some((entry) => {
    const normalized = entry.toLowerCase().trim();
    if (normalized.endsWith('/*')) return contentType.startsWith(normalized.slice(0, -1));
    return contentType === normalized;
  });
  if (!matches) throw new Error(`remote Content-Type is not allowed: ${contentType}`);
}

function normalizedContentType(raw: string | null): string {
  return (raw?.split(';', 1)[0] ?? '').trim().toLowerCase();
}

function sanitizedHeaders(input?: RequestInit['headers']): Headers {
  const headers = new Headers(input);
  for (const name of UNSAFE_REQUEST_HEADERS) headers.delete(name);
  return headers;
}

function embeddedIpv4(words: number[]): string {
  const high = words[6] ?? 0;
  const low = words[7] ?? 0;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function normalizeHostname(raw: string): string {
  return raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local / common metadata address
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224; // multicast, reserved and limited broadcast
}

function parseIpv6(address: string): number[] | null {
  let source = address;
  const zone = source.indexOf('%');
  if (zone >= 0) source = source.slice(0, zone);

  if (source.includes('.')) {
    const lastColon = source.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = source.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    source = `${source.slice(0, lastColon)}:${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(
      16,
    )}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }

  const doubleColon = source.indexOf('::');
  if (doubleColon !== source.lastIndexOf('::')) return null;
  const left =
    doubleColon >= 0 ? source.slice(0, doubleColon).split(':').filter(Boolean) : source.split(':');
  const right =
    doubleColon >= 0
      ? source
          .slice(doubleColon + 2)
          .split(':')
          .filter(Boolean)
      : [];
  const missing = doubleColon >= 0 ? 8 - left.length - right.length : 0;
  if ((doubleColon < 0 && left.length !== 8) || (doubleColon >= 0 && missing < 1)) {
    return null;
  }
  const parts = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[\da-f]{1,4}$/i.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('remote fetch aborted');
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
