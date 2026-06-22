import { request, type Dispatcher } from 'undici';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 5;

export interface HttpFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  headers?: Record<string, string>;
}

/**
 * GET that follows redirects MANUALLY, re-running the SSRF guard on every hop. Auto-following (undici
 * interceptors) would let an initial public URL 30x-redirect to a private/metadata address and bypass
 * the guard, so we must validate each Location ourselves.
 */
async function safeGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Dispatcher.ResponseData> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current);
    // undici request does not follow redirects unless a redirect dispatcher is set, so each call is
    // a single hop that we inspect and follow manually.
    const res = await request(current, {
      method: 'GET',
      headers,
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
      await res.body.dump().catch(() => undefined); // free the socket before the next hop
      if (!loc) throw new Error('redirect without location');
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

/** True for loopback / private / link-local / unique-local addresses (SSRF guard). */
export function isPrivateAddress(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const version = net.isIP(h);
  if (version === 4) {
    const parts = h.split('.').map((p) => Number(p));
    const [a, b] = [parts[0] ?? 0, parts[1] ?? 0];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (version === 6) {
    return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
  }
  return false;
}

/**
 * SSRF guard: only http/https, and the host must not resolve to a private/loopback address.
 * Throws on violation. Call before every outbound fetch of a user-supplied URL.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateAddress(host)) throw new Error('private address blocked');
  // Literal-hostname hosts (no dots and not an IP) like "localhost" are suspicious.
  if (host === 'localhost') throw new Error('private address blocked');
  if (net.isIP(host) === 0) {
    // resolve and check every returned address
    const addrs = await lookup(host, { all: true }).catch(() => []);
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) throw new Error('private address blocked');
    }
  }
}

export async function fetchText(url: string, opts: HttpFetchOptions): Promise<string> {
  const res = await safeGet(
    url,
    {
      'user-agent': opts.userAgent,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...(opts.headers ?? {}),
    },
    opts.timeoutMs,
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode}`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > opts.maxBytes) throw new Error('response too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function downloadToFile(url: string, dest: string, opts: HttpFetchOptions): Promise<void> {
  const res = await safeGet(
    url,
    {
      'user-agent': opts.userAgent,
      accept: '*/*',
      ...(opts.headers ?? {}),
    },
    opts.timeoutMs,
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode}`);
  }

  const len = Number(res.headers['content-length'] ?? 0);
  if (len > opts.maxBytes) throw new Error('file too large');

  let total = 0;
  const guard = async function* () {
    for await (const chunk of res.body) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > opts.maxBytes) throw new Error('file too large');
      yield b;
    }
  };

  await pipeline(guard(), createWriteStream(dest));
}
