import { readFile } from 'node:fs/promises';

interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expiresAt: number;
  name: string;
  value: string;
}

/**
 * Convert either a raw Cookie header or a Netscape cookies.txt file into the minimal header needed
 * for one HTTP request. A jar is filtered by host, path, TLS and expiry, so a shared multi-site jar
 * is never forwarded wholesale to an extractor or CDN.
 */
export async function cookieHeaderForUrl(
  source: string | undefined,
  target: string | URL,
): Promise<string | undefined> {
  const trimmed = source?.trim();
  if (!trimmed) return undefined;

  const url = target instanceof URL ? target : safeUrl(target);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined;

  // Raw cookie headers necessarily contain at least one name=value pair. Anything else is treated
  // as a file path; an unreadable/missing file fails closed instead of leaking the path as a header.
  if (trimmed.includes('=')) return sanitizeRawCookieHeader(trimmed);

  const jar = await readFile(trimmed, 'utf8').catch(() => null);
  if (jar === null) return undefined;

  const nowSeconds = Math.floor(Date.now() / 1_000);
  const pairs: string[] = [];
  for (const line of jar.split(/\r?\n/)) {
    const cookie = parseNetscapeLine(line);
    if (!cookie) continue;
    if (!cookieMatches(cookie, url, nowSeconds)) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.length > 0 ? [...new Set(pairs)].join('; ') : undefined;
}

function parseNetscapeLine(line: string): NetscapeCookie | null {
  let value = line.trim();
  if (!value || (value.startsWith('#') && !value.startsWith('#HttpOnly_'))) return null;
  value = value.replace(/^#HttpOnly_/, '');
  const fields = value.split('\t');
  if (fields.length < 7) return null;

  const [rawDomain, rawSubdomains, rawPath, rawSecure, rawExpiry, name, ...valueParts] = fields;
  const domain = rawDomain?.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  const path = rawPath?.trim() || '/';
  const expiresAt = Number(rawExpiry);
  const cookieValue = valueParts.join('\t');
  if (
    !domain ||
    !name ||
    !Number.isFinite(expiresAt) ||
    /[\0\r\n;=]/.test(name) ||
    /[\0\r\n]/.test(cookieValue)
  ) {
    return null;
  }
  return {
    domain,
    includeSubdomains: rawSubdomains?.trim().toUpperCase() === 'TRUE',
    path: path.startsWith('/') ? path : '/',
    secure: rawSecure?.trim().toUpperCase() === 'TRUE',
    expiresAt,
    name,
    value: cookieValue,
  };
}

function cookieMatches(cookie: NetscapeCookie, url: URL, nowSeconds: number): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const domainMatches = cookie.includeSubdomains
    ? host === cookie.domain || host.endsWith(`.${cookie.domain}`)
    : host === cookie.domain;
  if (!domainMatches) return false;
  if (cookie.secure && url.protocol !== 'https:') return false;
  if (cookie.expiresAt > 0 && cookie.expiresAt <= nowSeconds) return false;
  return pathMatches(url.pathname || '/', cookie.path);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

function sanitizeRawCookieHeader(value: string): string | undefined {
  const pairs = value.split(';').flatMap((entry) => {
    const pair = entry.trim();
    const separator = pair.indexOf('=');
    if (separator <= 0) return [];
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!name || /[\0\r\n;=]/.test(name) || /[\0\r\n]/.test(cookieValue)) return [];
    return [`${name}=${cookieValue}`];
  });
  return pairs.length > 0 ? [...new Set(pairs)].join('; ') : undefined;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
