import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_COOKIE_JAR_BYTES = 8 * 1024 * 1024;
const MAX_COOKIE_LINE_BYTES = 16 * 1024;
const X_COOKIE_DOMAINS = ['x.com', 'twitter.com'] as const;
const REQUIRED_SESSION_COOKIES = ['auth_token', 'ct0'] as const;

export interface XNetscapeCookie {
  readonly name: string;
  readonly value: string;
  /** Normalized ASCII domain without the Netscape leading dot. */
  readonly domain: string;
  readonly includeSubdomains: boolean;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Unix timestamp in seconds; undefined denotes a session cookie. */
  readonly expiresAt: number | undefined;
}

export interface ParseXNetscapeCookiesOptions {
  nowSeconds?: number;
  requireAuthenticatedSession?: boolean;
}

export class XNetscapeCookieJarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XNetscapeCookieJarError';
  }
}

/**
 * Parse only X/Twitter Netscape rows. Malformed, expired and out-of-scope rows are ignored without
 * ever interpolating their names or values into an exception.
 */
export function parseXNetscapeCookies(
  contents: string,
  options: ParseXNetscapeCookiesOptions = {},
): readonly XNetscapeCookie[] {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new XNetscapeCookieJarError('invalid cookie validation clock');
  }

  const cookies = new Map<string, XNetscapeCookie>();
  for (const originalLine of contents.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    if (Buffer.byteLength(originalLine, 'utf8') > MAX_COOKIE_LINE_BYTES) continue;
    const parsed = parseLine(originalLine, nowSeconds);
    if (parsed === null) continue;
    const key = `${parsed.domain}\u0000${parsed.path}\u0000${parsed.name}`;
    cookies.set(key, parsed);
  }

  const result = Object.freeze([...cookies.values()].map((cookie) => Object.freeze(cookie)));
  if (options.requireAuthenticatedSession !== false) assertAuthenticatedCookieSet(result);
  return result;
}

/**
 * Open a pre-validated jar without following a final symlink and re-check its size/mode at use time.
 */
export async function readXNetscapeCookieJar(
  cookieJarPath: string,
  options: ParseXNetscapeCookiesOptions = {},
): Promise<readonly XNetscapeCookie[]> {
  if (!isAbsolute(cookieJarPath)) {
    throw new XNetscapeCookieJarError('X cookie jar path must be absolute');
  }

  const handle = await open(cookieJarPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new XNetscapeCookieJarError('X cookie jar is unavailable');
  });
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw new XNetscapeCookieJarError('X cookie jar must be a regular mode-0600 file');
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new XNetscapeCookieJarError('X cookie jar must be owned by the service user');
    }
    if (info.size > MAX_COOKIE_JAR_BYTES) {
      throw new XNetscapeCookieJarError('X cookie jar exceeds the maximum size');
    }
    return parseXNetscapeCookies(await handle.readFile('utf8'), options);
  } finally {
    await handle.close();
  }
}

function parseLine(originalLine: string, nowSeconds: number): XNetscapeCookie | null {
  const line = originalLine.trimEnd();
  if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) return null;
  if (hasControlCharacter(line, true)) return null;

  const httpOnly = line.startsWith('#HttpOnly_');
  const netscapeLine = httpOnly ? line.slice('#HttpOnly_'.length) : line;
  const fields = netscapeLine.split('\t');
  if (fields.length !== 7) return null;

  const [rawDomain, rawIncludeSubdomains, path, rawSecure, rawExpiresAt, name, value] = fields;
  const domain = normalizeDomain(rawDomain ?? '');
  if (
    domain === null ||
    !isXCookieDomain(domain) ||
    (rawIncludeSubdomains !== 'TRUE' && rawIncludeSubdomains !== 'FALSE') ||
    !path?.startsWith('/') ||
    hasControlCharacter(path) ||
    (rawSecure !== 'TRUE' && rawSecure !== 'FALSE') ||
    !/^[0-9]+$/u.test(rawExpiresAt ?? '') ||
    !isCookieName(name ?? '') ||
    !isCookieValue(value ?? '')
  ) {
    return null;
  }

  const expiresAtNumber = Number(rawExpiresAt);
  if (!Number.isSafeInteger(expiresAtNumber) || expiresAtNumber < 0) return null;
  if (expiresAtNumber > 0 && expiresAtNumber <= nowSeconds) return null;

  return {
    name: name ?? '',
    value: value ?? '',
    domain,
    includeSubdomains: rawIncludeSubdomains === 'TRUE',
    path,
    secure: rawSecure === 'TRUE',
    httpOnly,
    expiresAt: expiresAtNumber === 0 ? undefined : expiresAtNumber,
  };
}

function assertAuthenticatedCookieSet(cookies: readonly XNetscapeCookie[]): void {
  const names = new Set(cookies.map((cookie) => cookie.name));
  if (!REQUIRED_SESSION_COOKIES.every((name) => names.has(name))) {
    throw new XNetscapeCookieJarError(
      'X cookie jar does not contain a complete authenticated session',
    );
  }
}

function normalizeDomain(rawDomain: string): string | null {
  const domain = rawDomain.trim().toLowerCase().replace(/^\.+/u, '').replace(/\.+$/u, '');
  if (!domain || domain.includes('..') || !/^[a-z0-9.-]+$/u.test(domain)) return null;
  const labels = domain.split('.');
  if (
    labels.some(
      (label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'),
    )
  ) {
    return null;
  }
  return domain;
}

function isXCookieDomain(domain: string): boolean {
  return X_COOKIE_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function isCookieName(value: string): boolean {
  if (value.length === 0) return false;
  const forbidden = new Set([
    '(',
    ')',
    ',',
    '/',
    ':',
    ';',
    '<',
    '=',
    '>',
    '?',
    '@',
    '[',
    ']',
    '{',
    '}',
  ]);
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 32 || code === 127 || forbidden.has(character)) return false;
  }
  return true;
}

function isCookieValue(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 32 || code === 127 || character === ';') return false;
  }
  return true;
}

function hasControlCharacter(value: string, allowTab: boolean = false): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 32 && !(allowTab && code === 9)) || code === 127) return true;
  }
  return false;
}
