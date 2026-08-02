import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { SocialCredentialReference, SocialPlatform } from './types.js';

const DEFAULT_MAX_COOKIE_JAR_BYTES = 8 * 1024 * 1024;

export const SOCIAL_COOKIE_JAR_PATH_ENV: Readonly<Record<SocialPlatform, string>> = Object.freeze({
  x: 'SOCIAL_X_COOKIE_JAR_FILE',
  instagram: 'SOCIAL_INSTAGRAM_COOKIE_JAR_FILE',
  facebook: 'SOCIAL_FACEBOOK_COOKIE_JAR_FILE',
  tiktok: 'SOCIAL_TIKTOK_COOKIE_JAR_FILE',
  youtube: 'SOCIAL_YOUTUBE_COOKIE_JAR_FILE',
});

export const SOCIAL_COOKIE_DOMAINS: Readonly<Record<SocialPlatform, readonly string[]>> =
  Object.freeze({
    x: Object.freeze(['x.com', 'twitter.com']),
    instagram: Object.freeze(['instagram.com']),
    facebook: Object.freeze(['facebook.com', 'fb.com']),
    tiktok: Object.freeze(['tiktok.com']),
    // A dedicated YouTube-only browser profile may need Google-scoped session cookies.
    youtube: Object.freeze(['youtube.com', 'google.com']),
  });

export interface ImportNetscapeCookieJarOptions {
  platform: SocialPlatform;
  /** Explicitly exported file; the importer never discovers or opens a browser profile. */
  sourcePath: string;
  /** Destination should be outside the repository and referenced through the platform env var. */
  destinationPath: string;
  overwrite?: boolean;
  maxBytes?: number;
}

export interface ImportedCookieJarSummary {
  platform: SocialPlatform;
  importedCookies: number;
  rejectedCookies: number;
}

export class SocialCookieJarImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialCookieJarImportError';
  }
}

export function cookieJarReferenceForPlatform(platform: SocialPlatform): SocialCredentialReference {
  return { kind: 'cookie_jar', pathEnv: SOCIAL_COOKIE_JAR_PATH_ENV[platform] };
}

export function isAllowedCookieDomain(platform: SocialPlatform, rawDomain: string): boolean {
  const domain = normalizeCookieDomain(rawDomain);
  if (domain === null) return false;
  return SOCIAL_COOKIE_DOMAINS[platform].some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`),
  );
}

/**
 * Imports a manually exported Netscape jar without retaining comments or out-of-scope domains.
 * The destination is installed atomically with mode 0600; no cookie values are returned or logged.
 */
export async function importNetscapeCookieJar(
  options: ImportNetscapeCookieJarOptions,
): Promise<ImportedCookieJarSummary> {
  const sourcePath = requireAbsolutePath(options.sourcePath, 'sourcePath');
  const destinationPath = requireAbsolutePath(options.destinationPath, 'destinationPath');
  if (sourcePath === destinationPath) {
    throw new SocialCookieJarImportError('source and destination must be different files');
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_COOKIE_JAR_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new SocialCookieJarImportError('maxBytes must be a positive integer');
  }

  let contents: string;
  const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      if (isErrorWithCode(error, 'ELOOP')) {
        throw new SocialCookieJarImportError(
          'source must be an explicit regular file, not a symlink',
        );
      }
      throw error;
    },
  );
  try {
    const sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile()) {
      throw new SocialCookieJarImportError('source must be an explicit regular file');
    }
    if ((sourceInfo.mode & 0o077) !== 0) {
      throw new SocialCookieJarImportError(
        'source cookie jar must not be accessible by group or others',
      );
    }
    if (sourceInfo.size > maxBytes) {
      throw new SocialCookieJarImportError('source cookie jar exceeds the configured size limit');
    }
    contents = await sourceHandle.readFile('utf8');
  } finally {
    await sourceHandle.close();
  }
  const parsed = filterNetscapeCookieJar(contents, options.platform);
  if (parsed.lines.length === 0) {
    throw new SocialCookieJarImportError('cookie jar contains no valid cookie for this platform');
  }

  const destinationDirectory = dirname(destinationPath);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  if ((await realpath(destinationDirectory)) !== resolve(destinationDirectory)) {
    throw new SocialCookieJarImportError('destination directory must not traverse symbolic links');
  }

  if (options.overwrite === true) {
    const existing = await lstat(destinationPath).catch((error: unknown) => {
      if (isErrorWithCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new SocialCookieJarImportError('existing destination must be a regular file');
    }
  }

  const temporaryPath = join(destinationDirectory, `.cookie-import-${randomUUID()}.tmp`);
  const output = [
    '# Netscape HTTP Cookie File',
    '# Filtered by GoonersBot social client importer; do not edit or commit.',
    ...parsed.lines,
    '',
  ].join('\n');

  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(output, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);

    if (options.overwrite === true) {
      await rename(temporaryPath, destinationPath);
    } else {
      // A hard-link install is atomic and fails with EEXIST instead of overwriting a concurrent file.
      await link(temporaryPath, destinationPath);
      await unlink(temporaryPath);
    }
    await chmod(destinationPath, 0o600);
    const installed = await stat(destinationPath);
    if (!installed.isFile() || (installed.mode & 0o777) !== 0o600) {
      throw new SocialCookieJarImportError('destination cookie jar permissions are not 0600');
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (isErrorWithCode(error, 'EEXIST')) {
      throw new SocialCookieJarImportError(
        'destination already exists; set overwrite only for an intentional rotation',
      );
    }
    throw error;
  }

  return {
    platform: options.platform,
    importedCookies: parsed.lines.length,
    rejectedCookies: parsed.rejected,
  };
}

function filterNetscapeCookieJar(
  contents: string,
  platform: SocialPlatform,
): { lines: string[]; rejected: number } {
  const accepted: string[] = [];
  let rejected = 0;

  for (const originalLine of contents.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const line = originalLine.trimEnd();
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;

    if (containsControlCharacter(line, true)) {
      rejected += 1;
      continue;
    }

    const fields = line.split('\t');
    if (fields.length !== 7) {
      rejected += 1;
      continue;
    }
    const rawDomainField = fields[0] ?? '';
    const httpOnly = rawDomainField.startsWith('#HttpOnly_');
    const rawDomain = httpOnly ? rawDomainField.slice('#HttpOnly_'.length) : rawDomainField;
    const includeSubdomains = fields[1];
    const cookiePath = fields[2];
    const secure = fields[3];
    const expires = fields[4];
    const name = fields[5];

    if (
      !isAllowedCookieDomain(platform, rawDomain) ||
      (includeSubdomains !== 'TRUE' && includeSubdomains !== 'FALSE') ||
      !cookiePath?.startsWith('/') ||
      (secure !== 'TRUE' && secure !== 'FALSE') ||
      !/^\d+$/u.test(expires ?? '') ||
      !name ||
      containsControlCharacter(name)
    ) {
      rejected += 1;
      continue;
    }

    accepted.push(line);
  }

  return { lines: accepted, rejected };
}

function normalizeCookieDomain(rawDomain: string): string | null {
  const domain = rawDomain.trim().toLowerCase().replace(/^\.+/u, '');
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

function containsControlCharacter(value: string, allowTab: boolean = false): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 32 && !(allowTab && code === 9)) || code === 127) return true;
  }
  return false;
}

function requireAbsolutePath(value: string, field: string): string {
  if (!isAbsolute(value)) {
    throw new SocialCookieJarImportError(`${field} must be an explicit absolute path`);
  }
  return resolve(value);
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
