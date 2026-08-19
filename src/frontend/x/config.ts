import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_NOVNC_PORT = 6088;
const DEFAULT_VNC_PORT = 5908;
const DEFAULT_DISPLAY = ':98';
const DEFAULT_BROWSER_MAX_RSS_MB = 1_536;
const DEFAULT_BROWSER_MAX_CPU_PERCENT = 300;
const DEFAULT_BROWSER_MAX_SESSION_MINUTES = 360;
const DEFAULT_MEDIA_GUARD_INTERVAL_SECONDS = 15;

export interface XFrontendConfig {
  readonly bindHost: string;
  readonly noVncPort: number;
  readonly vncPort: number;
  readonly display: string;
  readonly cookieJarPath: string;
  readonly profileDir: string;
  /** Memory ceiling for the Snap Firefox tree (PSS, with RSS only as a fallback). */
  readonly browserMaxRssBytes: number;
  /** Sustained aggregate CPU ceiling where one fully occupied logical core is 100%. */
  readonly browserMaxCpuPercent: number;
  /** Hard recycle interval: persistent profiles survive, browser processes do not. */
  readonly browserMaxSessionMs: number;
  /** How often the runtime reapplies the page-level media guard. */
  readonly mediaGuardIntervalMs: number;
}

export class XFrontendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XFrontendConfigError';
  }
}

/**
 * Resolve the isolated X viewer configuration without loading the Telegram bot's environment.
 * Every network listener is forced onto loopback and every session-bearing path is validated
 * before a browser process can start.
 */
export async function loadXFrontendConfig(
  raw: NodeJS.ProcessEnv = process.env,
): Promise<XFrontendConfig> {
  const bindHost = optionalValue(raw, 'SOCIAL_X_FRONTEND_HOST') ?? DEFAULT_BIND_HOST;
  if (bindHost !== DEFAULT_BIND_HOST) {
    throw new XFrontendConfigError('SOCIAL_X_FRONTEND_HOST must be 127.0.0.1');
  }

  const noVncPort = parsePort(raw, 'SOCIAL_X_FRONTEND_PORT', DEFAULT_NOVNC_PORT);
  const vncPort = parsePort(raw, 'SOCIAL_X_VNC_PORT', DEFAULT_VNC_PORT);
  if (noVncPort === vncPort) {
    throw new XFrontendConfigError('frontend and VNC ports must be different');
  }

  const display = optionalValue(raw, 'SOCIAL_X_DISPLAY') ?? DEFAULT_DISPLAY;
  if (!/^:[1-9][0-9]{0,3}$/u.test(display)) {
    throw new XFrontendConfigError('SOCIAL_X_DISPLAY must be an isolated X display such as :98');
  }

  const cookieJarPath = requiredAbsolutePath(raw, 'SOCIAL_X_COOKIE_JAR_FILE');
  const profileDir = requiredAbsolutePath(raw, 'SOCIAL_X_BROWSER_PROFILE_DIR');
  if (cookieJarPath === profileDir) {
    throw new XFrontendConfigError('cookie jar and browser profile paths must be different');
  }

  await validatePrivatePath(cookieJarPath, 'cookie jar', 'file', 0o600);
  await validatePrivatePath(profileDir, 'browser profile', 'directory', 0o700);

  const browserMaxRssMb = parseBoundedInteger(
    raw,
    'SOCIAL_X_BROWSER_MAX_RSS_MB',
    DEFAULT_BROWSER_MAX_RSS_MB,
    256,
    8_192,
  );
  const browserMaxSessionMinutes = parseBoundedInteger(
    raw,
    'SOCIAL_X_BROWSER_MAX_SESSION_MINUTES',
    DEFAULT_BROWSER_MAX_SESSION_MINUTES,
    15,
    1_440,
  );
  const browserMaxCpuPercent = parseBoundedInteger(
    raw,
    'SOCIAL_X_BROWSER_MAX_CPU_PERCENT',
    DEFAULT_BROWSER_MAX_CPU_PERCENT,
    100,
    800,
  );
  const mediaGuardIntervalSeconds = parseBoundedInteger(
    raw,
    'SOCIAL_X_MEDIA_GUARD_INTERVAL_SECONDS',
    DEFAULT_MEDIA_GUARD_INTERVAL_SECONDS,
    5,
    60,
  );

  return Object.freeze({
    bindHost,
    noVncPort,
    vncPort,
    display,
    cookieJarPath,
    profileDir,
    browserMaxRssBytes: browserMaxRssMb * 1024 * 1024,
    browserMaxCpuPercent,
    browserMaxSessionMs: browserMaxSessionMinutes * 60_000,
    mediaGuardIntervalMs: mediaGuardIntervalSeconds * 1_000,
  });
}

function optionalValue(raw: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = raw[key]?.trim();
  return value ? value : undefined;
}

function parsePort(raw: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = optionalValue(raw, key);
  if (value === undefined) return fallback;
  if (!/^[0-9]{1,5}$/u.test(value)) {
    throw new XFrontendConfigError(`${key} must be an integer TCP port`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new XFrontendConfigError(`${key} must be between 1024 and 65535`);
  }
  return port;
}

function parseBoundedInteger(
  raw: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = optionalValue(raw, key);
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/u.test(value)) {
    throw new XFrontendConfigError(`${key} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new XFrontendConfigError(`${key} must be between ${min} and ${max}`);
  }
  return parsed;
}

function requiredAbsolutePath(raw: NodeJS.ProcessEnv, key: string): string {
  const value = optionalValue(raw, key);
  if (value === undefined) throw new XFrontendConfigError(`${key} is required`);
  if (!isAbsolute(value)) throw new XFrontendConfigError(`${key} must be an absolute path`);
  return resolve(value);
}

async function validatePrivatePath(
  path: string,
  label: string,
  expectedKind: 'file' | 'directory',
  expectedMode: number,
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new XFrontendConfigError(`${label} does not exist or is not accessible`);
  }

  if (info.isSymbolicLink()) {
    throw new XFrontendConfigError(`${label} must not be a symbolic link`);
  }
  const correctKind = expectedKind === 'file' ? info.isFile() : info.isDirectory();
  if (!correctKind) throw new XFrontendConfigError(`${label} must be a regular ${expectedKind}`);
  if ((info.mode & 0o777) !== expectedMode) {
    throw new XFrontendConfigError(
      `${label} permissions must be exactly ${expectedMode.toString(8)}`,
    );
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new XFrontendConfigError(`${label} must be owned by the service user`);
  }

  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new XFrontendConfigError(`${label} cannot be resolved safely`);
  }
  if (canonical !== path) {
    throw new XFrontendConfigError(`${label} path must not traverse symbolic links`);
  }
}
