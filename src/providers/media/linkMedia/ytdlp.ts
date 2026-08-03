import { existsSync } from 'node:fs';
import { chmod, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { childLogger } from '../../../utils/logger.js';
import { runProcessChecked } from '../../../utils/process.js';
import { startSafeEgressProxy } from '../../../utils/safeEgressProxy.js';
import { assertSafeUrl, downloadToFile } from './http.js';
import { cleanSocialText } from './socialMetadata.js';
import type { PostStats } from './types.js';

const log = childLogger('link-media-ytdlp');

export interface YtdlpDownloadConfig {
  ytdlpBin: string;
  ffmpegBin: string;
  maxDownloadBytes: number;
  maxDurationSeconds: number;
  timeoutMs: number;
  signal?: AbortSignal;
  proxy?: string | undefined;
  /** Browser-like User-Agent used by yt-dlp. A safe default is used when omitted. */
  userAgent?: string | undefined;
  /** Optional yt-dlp JavaScript runtime specification, e.g. `node:/usr/bin/node`. */
  jsRuntime?: string | undefined;
  /** Optional curl_cffi browser target. Do not set globally unless a site requires it. */
  impersonate?: string | undefined;
  /** either a raw Cookie header string for the host, or a path to a Netscape cookies.txt file */
  cookies?: string | undefined;
  /** Content policy for initial/resolved URLs. Internal yt-dlp targets remain limited by host trust. */
  validateUrl?: ((url: URL) => void | Promise<void>) | undefined;
  /** bubblewrap binary used to force yt-dlp and its ffmpeg children through the guarded proxy */
  bwrapBin?: string | undefined;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const RETRY_COUNT = '5';
const RETRY_BACKOFF = 'exp=1:10';
const FINAL_PATHS_FILE = '.ytdlp-final-paths.txt';
const DURATION_FILE = '.ytdlp-duration-seconds.txt';
const SANDBOX_PROXY_PORT = '39173';
const SANDBOX_PROXY_URL = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;

// Runs inside bubblewrap's private network namespace. Its only reachable endpoint is this loopback
// relay to the parent's mode-0600 Unix socket. DNS and destination policy remain in the parent.
const ISOLATED_PROXY_RELAY = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const [socketPath, portText, bin, ...args] = process.argv.slice(1);
if (!socketPath || !portText || !bin) process.exit(125);
const connections = new Set();
const server = net.createServer((client) => {
  connections.add(client);
  client.once('close', () => connections.delete(client));
  const upstream = net.connect(socketPath);
  connections.add(upstream);
  upstream.once('close', () => connections.delete(upstream));
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on('error', (error) => {
  process.stderr.write('isolated proxy relay failed: ' + error.message + '\n');
  process.exit(125);
});
server.listen(Number(portText), '127.0.0.1', () => {
  const child = spawn(bin, args, { stdio: 'inherit' });
  const stop = (signal) => { try { child.kill(signal); } catch {} };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  child.on('error', (error) => {
    process.stderr.write('isolated child failed: ' + error.message + '\n');
    server.close(() => process.exit(125));
  });
  child.on('exit', (code, signal) => {
    for (const socket of connections) socket.destroy();
    server.close(() => process.exit(code ?? (signal ? 128 : 1)));
  });
});
`;

// Prefer a Telegram-friendly H.264/AAC pair, then progressively relax the codec/container
// constraints. Landscape formats are bounded by height and portrait formats by width: limiting
// height alone rejects perfectly valid 720x1280 Reels. The `?` admits formats whose extractor does
// not report the compared dimension.
export const YTDLP_VIDEO_FORMAT =
  'bestvideo[height<=?720][ext=mp4][vcodec^=avc]+bestaudio[ext=m4a][acodec^=mp4a]/' +
  'bestvideo[width<=?720][ext=mp4][vcodec^=avc]+bestaudio[ext=m4a][acodec^=mp4a]/' +
  'bestvideo[height<=?720][ext=mp4]+bestaudio[ext=m4a]/' +
  'bestvideo[width<=?720][ext=mp4]+bestaudio[ext=m4a]/' +
  'bestvideo[height<=?720]+bestaudio/' +
  'bestvideo[width<=?720]+bestaudio/' +
  'best[height<=?720][ext=mp4]/best[width<=?720][ext=mp4]/' +
  'best[height<=?720]/best[width<=?720]';

// Some extractors expose incomplete dimensions or unusual format layouts. A single bounded retry
// lets yt-dlp choose a valid pair; the byte/duration caps still apply and the normalizer enforces
// Telegram-compatible dimensions and codecs afterwards.
export const YTDLP_RELAXED_VIDEO_FORMAT = 'bestvideo+bestaudio/best';

const VIDEO_EXTENSIONS = new Set([
  '.3g2',
  '.3gp',
  '.avi',
  '.flv',
  '.m2ts',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.mts',
  '.ogv',
  '.ts',
  '.vob',
  '.webm',
]);
const IMPERSONATION_FALLBACK_DOMAINS = [
  'facebook.com',
  'fb.watch',
  'instagram.com',
  'tiktok.com',
] as const;

function safeUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Translate a raw Cookie header into a domain-scoped Netscape jar. Passing `--add-header Cookie:`
 * would send the credential to every CDN/redirect host yt-dlp touches.
 */
async function cookieArgs(
  cookies: string | undefined,
  pageUrl: string,
  workdir: string,
): Promise<string[]> {
  if (!cookies) return [];
  const jar = join(workdir, '.cookies.txt');
  if (existsSync(cookies)) {
    // yt-dlp may update a supplied cookie jar. Never let it mutate an operator-mounted secret;
    // work on a private copy that is removed with the per-download work directory.
    await writeFile(jar, await readFile(cookies), { mode: 0o600 });
    await chmod(jar, 0o600);
    return ['--cookies', jar];
  }
  const url = new URL(pageUrl);
  const domain = cookieDomain(url.hostname);
  const rows = cookies
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .flatMap((pair) => {
      const separator = pair.indexOf('=');
      if (separator <= 0) return [];
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name || /[\t\r\n]/.test(name) || /[\t\r\n]/.test(value)) return [];
      return [
        `.${domain}\tTRUE\t/\t${url.protocol === 'https:' ? 'TRUE' : 'FALSE'}\t0\t${name}\t${value}`,
      ];
    });
  if (rows.length === 0) return [];
  await writeFile(jar, `# Netscape HTTP Cookie File\n${rows.join('\n')}\n`, {
    mode: 0o600,
  });
  await chmod(jar, 0o600);
  return ['--cookies', jar];
}

export interface YtdlpResult {
  file: string;
  title?: string;
  description?: string;
  author?: string;
  authorHandle?: string;
  stats?: PostStats;
  durationSec?: number;
}

/** Expected policy rejection: yt-dlp resolved a VOD whose duration exceeds the configured cap. */
export class YtdlpDurationLimitError extends Error {
  readonly code = 'duration_exceeded' as const;

  constructor(
    readonly durationSeconds: number,
    readonly maxDurationSeconds: number,
  ) {
    super(
      `yt-dlp media duration ${durationSeconds}s exceeds configured limit ${maxDurationSeconds}s`,
    );
    this.name = 'YtdlpDurationLimitError';
  }
}

export interface YtdlpBatchItem extends YtdlpResult {
  sequence: number;
  playlistIndex?: number;
}

export interface YtdlpBatchResult {
  items: YtdlpBatchItem[];
  isPlaylist: true;
  partial: boolean;
  expectedItems?: number;
}

function cleanOption(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !/[\0\r\n]/.test(trimmed) ? trimmed : undefined;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function shouldRetryWithImpersonation(
  pageUrl: string,
  cfg: YtdlpDownloadConfig,
  err: unknown,
): boolean {
  if (cleanOption(cfg.impersonate) || cfg.signal?.aborted) return false;
  // Retry extractor/network HTTP failures only. A missing binary, outer timeout or programming
  // error will not improve by repeating the exact subprocess with a browser fingerprint.
  if (!(err instanceof Error) || !err.message.startsWith('yt-dlp exited ')) return false;
  const message = err.message.toLowerCase();
  if (
    /login required|sign in required|cookies? required|requested format|format is not available|ffmpeg|no space|disk quota|permission denied/.test(
      message,
    )
  ) {
    return false;
  }
  if (
    !/http error 403|\b403 forbidden\b|captcha|anti.?bot|challenge|impersonat|tls fingerprint/.test(
      message,
    )
  )
    return false;
  try {
    const host = new URL(pageUrl).hostname.toLowerCase().replace(/\.$/, '');
    return IMPERSONATION_FALLBACK_DOMAINS.some((domain) => hostMatches(host, domain));
  } catch {
    return false;
  }
}

function isRequestedFormatError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith('yt-dlp exited ') &&
    /requested format|format is not available/i.test(err.message)
  );
}

function replaceYtdlpFormat(args: string[], format: string): string[] {
  const index = args.indexOf('-f');
  if (index < 0 || index + 1 >= args.length) {
    throw new Error('yt-dlp format policy is missing');
  }
  const updated = [...args];
  updated[index + 1] = format;
  return updated;
}

function socketTimeoutSeconds(timeoutMs: number): string {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return '20';
  return String(Math.max(1, Math.min(20, Math.floor(timeoutMs / 1_000))));
}

/** Add bounded network retries shared by downloads and snapshot URL resolution. */
function appendNetworkArgs(args: string[], cfg: YtdlpDownloadConfig): void {
  args.push(
    '--socket-timeout',
    socketTimeoutSeconds(cfg.timeoutMs),
    '--retries',
    RETRY_COUNT,
    '--fragment-retries',
    RETRY_COUNT,
    '--file-access-retries',
    RETRY_COUNT,
    '--extractor-retries',
    RETRY_COUNT,
    '--retry-sleep',
    `http:${RETRY_BACKOFF}`,
    '--retry-sleep',
    `fragment:${RETRY_BACKOFF}`,
    '--retry-sleep',
    `file_access:${RETRY_BACKOFF}`,
    '--retry-sleep',
    `extractor:${RETRY_BACKOFF}`,
    '--user-agent',
    cleanOption(cfg.userAgent) ?? DEFAULT_USER_AGENT,
  );

  const jsRuntime = cleanOption(cfg.jsRuntime);
  if (jsRuntime) args.push('--js-runtimes', jsRuntime);
  // The official executable already bundles curl_cffi. Impersonation is deliberately opt-in since
  // forcing it for every request can make otherwise-working extractors less reliable.
  const impersonate = cleanOption(cfg.impersonate);
  if (impersonate) args.push('--impersonate', impersonate);
}

/** Build the complete argv without a shell; exported so option hardening stays regression-tested. */
export async function buildYtdlpDownloadArgs(
  pageUrl: string,
  workdir: string,
  cfg: YtdlpDownloadConfig,
): Promise<string[]> {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--playlist-items',
    '1',
    '--no-warnings',
    '--quiet',
    '--no-progress',
    '--ffmpeg-location',
    cfg.ffmpegBin,
    '-f',
    YTDLP_VIDEO_FORMAT,
    '--merge-output-format',
    'mp4',
    '--max-filesize',
    String(Math.floor(cfg.maxDownloadBytes)),
    // Skip VODs longer than the cap. Unknown-duration/live streams fail closed here and can use the
    // separately SSRF-guarded snapshot path below.
    '--match-filter',
    `duration<=${cfg.maxDurationSeconds}`,
    '--write-info-json',
    '--print-to-file',
    'after_move:filepath',
    join(workdir, FINAL_PATHS_FILE),
    // `pre_process` runs after metadata extraction but before `--match-filter`, so an overlong VOD
    // leaves a typed, workdir-confined reason even though yt-dlp exits successfully without a file.
    '--print-to-file',
    'pre_process:%(duration)s',
    join(workdir, DURATION_FILE),
    '-o',
    join(workdir, 'video.%(ext)s'),
  ];
  appendNetworkArgs(args, cfg);
  if (cfg.proxy) args.push('--proxy', cfg.proxy);
  args.push(...(await cookieArgs(cfg.cookies, pageUrl, workdir)));
  args.push(pageUrl);
  return args;
}

/** Build a one-process, bounded social-carousel download without enabling unbounded feed crawling. */
export async function buildYtdlpBatchDownloadArgs(
  pageUrl: string,
  workdir: string,
  cfg: YtdlpDownloadConfig,
  maxEntries: number,
): Promise<string[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 50) {
    throw new Error('yt-dlp playlist limit must be an integer between 1 and 50');
  }
  const args = await buildYtdlpDownloadArgs(pageUrl, workdir, cfg);
  const singleItemLimit = args.indexOf('--playlist-items');
  if (singleItemLimit >= 0) args.splice(singleItemLimit, 2);
  const playlistFlag = args.indexOf('--no-playlist');
  if (playlistFlag < 0) throw new Error('yt-dlp playlist policy is missing');
  args.splice(
    playlistFlag,
    1,
    '--yes-playlist',
    '--playlist-items',
    `1:${maxEntries}`,
    '--concat-playlist',
    'never',
    '--no-write-playlist-metafiles',
  );
  const output = args.indexOf('-o');
  if (output < 0 || output + 1 >= args.length) throw new Error('yt-dlp output policy is missing');
  args[output + 1] = join(workdir, 'item-%(playlist_index,autonumber)05d.%(ext)s');
  return args;
}

function isFinalVideoPath(workdir: string, candidate: string): boolean {
  const root = resolve(workdir);
  const file = resolve(root, candidate);
  const local = relative(root, file);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return false;
  if (local.includes(sep) || !/^video\.[^.]+$/i.test(local)) return false;
  return VIDEO_EXTENSIONS.has(extname(local).toLowerCase());
}

type YtdlpInfoMetadata = Omit<YtdlpResult, 'file'>;

function metadataCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function infoText(
  info: Record<string, unknown>,
  fields: readonly string[],
  maxLength: number,
): string | undefined {
  for (const field of fields) {
    const text = cleanSocialText(info[field], maxLength);
    if (text) return text;
  }
  return undefined;
}

function plausibleAuthorHandle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const stripped = value.replace(/^@/, '');
  // YouTube's opaque UC... channel id is not a human-readable handle. Other common extractor IDs
  // (X/TikTok/Instagram usernames) are useful attribution even if yt-dlp omits the leading @.
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(stripped)) return undefined;
  return /^[A-Za-z0-9_.-]{1,100}$/.test(stripped) ? stripped : undefined;
}

/** Convert the stable public yt-dlp info fields into platform-neutral social metadata. */
export function socialMetadataFromYtdlpInfo(info: Record<string, unknown>): YtdlpInfoMetadata {
  const title = infoText(info, ['title', 'fulltitle'], 2_000);
  const description = infoText(info, ['description'], 20_000);
  const author = infoText(info, ['uploader', 'channel', 'creator', 'artist'], 300);
  const authorHandle = plausibleAuthorHandle(
    infoText(info, ['uploader_id', 'channel_id', 'creator_id'], 200),
  );
  const durationSec =
    typeof info.duration === 'number' && Number.isFinite(info.duration) && info.duration >= 0
      ? info.duration
      : undefined;
  const stats: PostStats = {};
  const likes = metadataCount(info.like_count);
  const reposts = metadataCount(info.repost_count);
  const shares = metadataCount(info.share_count);
  const replies = metadataCount(info.reply_count);
  const comments = metadataCount(info.comment_count);
  const views = metadataCount(info.view_count);
  if (likes !== undefined) stats.likes = likes;
  if (reposts !== undefined) stats.reposts = reposts;
  if (shares !== undefined) stats.shares = shares;
  if (replies !== undefined) stats.replies = replies;
  if (comments !== undefined) stats.comments = comments;
  if (views !== undefined) stats.views = views;

  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(authorHandle ? { authorHandle } : {}),
    ...(Object.keys(stats).length > 0 ? { stats } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
  };
}

/**
 * Resolve yt-dlp's actual post-processed path, falling back to the deterministic output template.
 * Manifest paths are constrained to the work directory before any filesystem access.
 */
export async function discoverYtdlpResult(
  workdir: string,
  maxDownloadBytes: number,
): Promise<YtdlpResult | null> {
  const reported = await readFile(join(workdir, FINAL_PATHS_FILE), 'utf8')
    .then((value) =>
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse(),
    )
    .catch(() => [] as string[]);
  const discovered = await readdir(workdir).catch(() => [] as string[]);
  const candidates = [...reported, ...discovered.filter((name) => isFinalVideoPath(workdir, name))];

  let file: string | undefined;
  for (const candidate of new Set(candidates)) {
    if (!isFinalVideoPath(workdir, candidate)) continue;
    const absolute = resolve(workdir, candidate);
    const entry = await lstat(absolute).catch(() => null);
    if (
      entry?.isFile() &&
      entry.size > 0 &&
      Number.isFinite(maxDownloadBytes) &&
      entry.size <= maxDownloadBytes
    ) {
      file = absolute;
      break;
    }
  }
  if (!file) return null;

  const result: YtdlpResult = { file };
  try {
    const json = JSON.parse(await readFile(join(workdir, 'video.info.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    Object.assign(result, socialMetadataFromYtdlpInfo(json));
  } catch {
    // Metadata is optional; an unreadable sidecar must not discard a valid download.
  }
  return result;
}

async function discoveredYtdlpDuration(workdir: string): Promise<number | undefined> {
  const marker = join(workdir, DURATION_FILE);
  const entry = await lstat(marker).catch(() => null);
  if (!entry?.isFile() || entry.size < 1 || entry.size > 4_096) return undefined;
  const values = (await readFile(marker, 'utf8').catch(() => ''))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(line))
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return values.length > 0 ? Math.max(...values) : undefined;
}

async function throwIfYtdlpDurationExceeded(
  workdir: string,
  maxDurationSeconds: number,
): Promise<void> {
  const durationSeconds = await discoveredYtdlpDuration(workdir);
  if (durationSeconds !== undefined && durationSeconds > maxDurationSeconds) {
    throw new YtdlpDurationLimitError(durationSeconds, maxDurationSeconds);
  }
}

/** Discover ordered carousel outputs while rejecting escapes, links and intermediate files. */
export async function discoverYtdlpResults(
  workdir: string,
  maxDownloadBytes: number,
  maxEntries: number,
): Promise<YtdlpBatchResult | null> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 50) return null;
  const reported = await readFile(join(workdir, FINAL_PATHS_FILE), 'utf8')
    .then((value) =>
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .catch(() => [] as string[]);
  const discovered = await readdir(workdir).catch(() => [] as string[]);
  const candidates = [...reported, ...discovered];
  const bySequence = new Map<number, string>();

  for (const candidate of candidates) {
    const sequence = batchVideoSequence(workdir, candidate);
    if (sequence === null || sequence > maxEntries || bySequence.has(sequence)) continue;
    const absolute = resolve(workdir, candidate);
    const entry = await lstat(absolute).catch(() => null);
    if (
      !entry?.isFile() ||
      entry.size < 1 ||
      !Number.isFinite(maxDownloadBytes) ||
      entry.size > maxDownloadBytes
    ) {
      continue;
    }
    bySequence.set(sequence, absolute);
  }

  const items: YtdlpBatchItem[] = [];
  let expectedItems: number | undefined;
  for (const [sequence, file] of [...bySequence.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    const item: YtdlpBatchItem = { file, sequence };
    try {
      const sidecar = join(workdir, `item-${String(sequence).padStart(5, '0')}.info.json`);
      const json = JSON.parse(await readFile(sidecar, 'utf8')) as Record<string, unknown>;
      Object.assign(item, socialMetadataFromYtdlpInfo(json));
      if (typeof json.playlist_index === 'number') item.playlistIndex = json.playlist_index;
      const rawExpected = [json.n_entries, json.playlist_count]
        .filter(
          (value): value is number => typeof value === 'number' && Number.isSafeInteger(value),
        )
        .map((value) => Math.max(0, Math.min(maxEntries, value)));
      if (rawExpected.length > 0) {
        expectedItems = Math.max(expectedItems ?? 0, ...rawExpected);
      }
    } catch {
      // Per-entry metadata is optional; the constrained regular file remains usable.
    }
    items.push(item);
  }

  if (items.length === 0) return null;
  return {
    items,
    isPlaylist: true,
    partial: expectedItems !== undefined && items.length < expectedItems,
    ...(expectedItems !== undefined ? { expectedItems } : {}),
  };
}

function batchVideoSequence(workdir: string, candidate: string): number | null {
  const root = resolve(workdir);
  const file = resolve(root, candidate);
  const local = relative(root, file);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return null;
  if (local.includes(sep) || !VIDEO_EXTENSIONS.has(extname(local).toLowerCase())) return null;
  const match = /^item-(\d{5})\.[^.]+$/i.exec(local);
  if (!match?.[1]) return null;
  const sequence = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

async function runYtdlp(cfg: YtdlpDownloadConfig, args: string[], workdir: string): Promise<void> {
  await runYtdlpProcess(cfg, args, workdir, false);
}

/**
 * Download the best <=720p video for a page URL via the yt-dlp binary (handles YouTube and ~1800
 * other sites including adult/cam). yt-dlp merges video+audio with ffmpeg. Returns the file path and
 * metadata, or null when SSRF checks/filtering/size caps intentionally skip it. Extractor,
 * authentication and subprocess failures are propagated so callers do not mistake them for a live
 * stream and attempt a snapshot with the same broken credentials.
 */
export async function downloadWithYtdlp(
  pageUrl: string,
  workdir: string,
  cfg: YtdlpDownloadConfig,
): Promise<YtdlpResult | null> {
  try {
    const safe = await assertSafeUrl(pageUrl, cfg.signal);
    await cfg.validateUrl?.(safe);
  } catch {
    return null;
  }

  let attemptCfg = cfg;
  let relaxedFormat = false;
  // At most three subprocesses: normal, one relaxed-format retry, and one site-scoped browser
  // impersonation retry. Either failure can occur first, so retain the successful fallback choice.
  for (;;) {
    const standardArgs = await buildYtdlpDownloadArgs(pageUrl, workdir, attemptCfg);
    const args = relaxedFormat
      ? replaceYtdlpFormat(standardArgs, YTDLP_RELAXED_VIDEO_FORMAT)
      : standardArgs;

    try {
      await runYtdlp(attemptCfg, args, workdir);
      break;
    } catch (err) {
      log.debug({ err, url: safeUrlForLog(pageUrl) }, 'yt-dlp download failed');
      if (!relaxedFormat && isRequestedFormatError(err)) {
        relaxedFormat = true;
        log.debug({ url: safeUrlForLog(pageUrl) }, 'retrying yt-dlp with relaxed format selection');
        continue;
      }
      if (!shouldRetryWithImpersonation(pageUrl, attemptCfg, err)) throw err;

      // curl_cffi is bundled by the official executable. Some anti-bot frontends need its Chrome
      // fingerprint, but forcing it globally is harmful, so retry once only for these social hosts.
      log.debug(
        { url: safeUrlForLog(pageUrl) },
        'retrying yt-dlp with site-scoped Chrome impersonation',
      );
      attemptCfg = { ...attemptCfg, impersonate: 'chrome' };
    }
  }

  const result = await discoverYtdlpResult(workdir, cfg.maxDownloadBytes);
  if (result) return result;
  await throwIfYtdlpDurationExceeded(workdir, cfg.maxDurationSeconds);
  return null;
}

/** Download at most `maxEntries` videos belonging to one explicitly classified carousel URL. */
export async function downloadManyWithYtdlp(
  pageUrl: string,
  workdir: string,
  cfg: YtdlpDownloadConfig,
  maxEntries: number,
): Promise<YtdlpBatchResult | null> {
  try {
    const safe = await assertSafeUrl(pageUrl, cfg.signal);
    await cfg.validateUrl?.(safe);
  } catch {
    return null;
  }

  const runAndDiscover = async (
    runCfg: YtdlpDownloadConfig,
  ): Promise<{ result: YtdlpBatchResult | null; error?: unknown }> => {
    const args = await buildYtdlpBatchDownloadArgs(pageUrl, workdir, runCfg, maxEntries);
    try {
      await runYtdlp(runCfg, args, workdir);
      const result = await discoverYtdlpResults(workdir, runCfg.maxDownloadBytes, maxEntries);
      if (!result) await throwIfYtdlpDurationExceeded(workdir, runCfg.maxDurationSeconds);
      return {
        result,
      };
    } catch (error) {
      const result = await discoverYtdlpResults(workdir, runCfg.maxDownloadBytes, maxEntries);
      return result ? { result: { ...result, partial: true }, error } : { result: null, error };
    }
  };

  const first = await runAndDiscover(cfg);
  const retryWithImpersonation =
    first.error !== undefined && shouldRetryWithImpersonation(pageUrl, cfg, first.error);
  if (first.result && !retryWithImpersonation) return first.result;
  if (retryWithImpersonation) {
    log.debug(
      { url: safeUrlForLog(pageUrl) },
      'retrying yt-dlp carousel with site-scoped Chrome impersonation',
    );
    const fallback = await runAndDiscover({ ...cfg, impersonate: 'chrome' });
    if (fallback.result) return fallback.result;
    // Do not discard entries successfully completed before the retryable failure if the fallback
    // itself cannot improve the batch.
    if (first.result) return first.result;
    if (fallback.error) throw fallback.error;
    return null;
  }
  if (first.error) throw first.error;
  return null;
}

/** Run yt-dlp and capture stdout (used for -g URL resolution). */
async function runYtdlpCapture(
  cfg: YtdlpDownloadConfig,
  args: string[],
  workdir: string,
): Promise<string> {
  const r = await runYtdlpProcess(cfg, args, workdir, true, Math.min(cfg.timeoutMs, 60_000));
  return r.stdout.toString();
}

async function runYtdlpProcess(
  cfg: YtdlpDownloadConfig,
  args: string[],
  workdir: string,
  collectStdout: boolean,
  timeoutMs = cfg.timeoutMs,
) {
  if (!cfg.bwrapBin) {
    return runProcessChecked(
      cfg.ytdlpBin,
      args,
      { timeoutMs, collectStdout, signal: cfg.signal },
      'yt-dlp',
    );
  }

  const socketPath = join(workdir, '.safe-egress.sock');
  const proxy = await startSafeEgressProxy(socketPath, {
    signal: cfg.signal,
    validateUrl: cfg.validateUrl,
  });
  try {
    const proxiedArgs = withProxyArgument(args, SANDBOX_PROXY_URL);
    return await runProcessChecked(
      cfg.bwrapBin,
      buildYtdlpSandboxArgs(cfg.ytdlpBin, proxiedArgs, workdir, socketPath),
      { timeoutMs, collectStdout, signal: cfg.signal },
      'yt-dlp',
    );
  } finally {
    await proxy.close();
  }
}

/** Pure argv builder kept exported so the namespace boundary is regression-tested. */
export function buildYtdlpSandboxArgs(
  ytdlpBin: string,
  ytdlpArgs: string[],
  workdir: string,
  proxySocketPath: string,
): string[] {
  return [
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-pid',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/',
    '/',
    '--dev-bind',
    '/dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/run',
    '--bind',
    workdir,
    workdir,
    '--setenv',
    'HOME',
    workdir,
    '--setenv',
    'TMPDIR',
    workdir,
    '--setenv',
    'http_proxy',
    SANDBOX_PROXY_URL,
    '--setenv',
    'https_proxy',
    SANDBOX_PROXY_URL,
    '--setenv',
    'HTTP_PROXY',
    SANDBOX_PROXY_URL,
    '--setenv',
    'HTTPS_PROXY',
    SANDBOX_PROXY_URL,
    '--setenv',
    'ALL_PROXY',
    SANDBOX_PROXY_URL,
    '--setenv',
    'NO_PROXY',
    '',
    process.execPath,
    '-e',
    ISOLATED_PROXY_RELAY,
    proxySocketPath,
    SANDBOX_PROXY_PORT,
    ytdlpBin,
    ...ytdlpArgs,
  ];
}

function withProxyArgument(args: string[], proxyUrl: string): string[] {
  const clean: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--proxy') {
      index += 1;
      continue;
    }
    clean.push(args[index]!);
  }
  const input = clean.pop();
  return input ? [...clean, '--proxy', proxyUrl, input] : [...clean, '--proxy', proxyUrl];
}

async function ffmpegGrabFrame(
  bin: string,
  localInput: string,
  out: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await runProcessChecked(
    bin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      localInput,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-vf',
      "scale='min(1024,iw)':-2",
      out,
    ],
    { timeoutMs, signal },
    'ffmpeg snapshot',
  );
}

/**
 * Grab a single still frame ("snapshot") from a page that is a live/unbounded stream or that we
 * could not download as a bounded video. yt-dlp resolves the playable stream URL, ffmpeg pulls one
 * frame. The resolved URL is SSRF-checked before ffmpeg ever touches it.
 */
export async function snapshotStream(
  pageUrl: string,
  workdir: string,
  cfg: YtdlpDownloadConfig,
): Promise<string | null> {
  try {
    const safe = await assertSafeUrl(pageUrl, cfg.signal);
    await cfg.validateUrl?.(safe);
  } catch {
    return null;
  }
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--no-playlist',
    '--playlist-items',
    '1',
    '-f',
    'best[height<=720]/best',
    '-g',
  ];
  appendNetworkArgs(args, cfg);
  if (cfg.proxy) args.push('--proxy', cfg.proxy);
  args.push(...(await cookieArgs(cfg.cookies, pageUrl, workdir)));
  args.push(pageUrl);

  let streamUrl: string;
  try {
    const stdout = await runYtdlpCapture(cfg, args, workdir);
    const first = stdout
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean);
    if (!first) return null;
    streamUrl = first;
  } catch (err) {
    log.debug({ err, url: safeUrlForLog(pageUrl) }, 'snapshot stream-url resolution failed');
    return null;
  }

  try {
    const safe = await assertSafeUrl(streamUrl, cfg.signal);
    await cfg.validateUrl?.(safe);
  } catch {
    return null; // refuse private/loopback resolved targets
  }

  // Never let ffmpeg resolve/follow a remote URL itself: fetch through the guarded HTTP client
  // first. HLS/DASH manifests that require nested network requests consequently fail closed.
  const localInput = join(workdir, 'snapshot-source.bin');
  try {
    await downloadToFile(streamUrl, localInput, {
      timeoutMs: Math.min(cfg.timeoutMs, 45_000),
      maxBytes: Math.min(cfg.maxDownloadBytes, 32 * 1024 * 1024),
      userAgent: 'Mozilla/5.0',
      signal: cfg.signal,
      allowedContentTypes: ['video/*', 'image/*', 'application/octet-stream'],
      validateUrl: cfg.validateUrl,
    });
  } catch {
    return null;
  }

  const out = join(workdir, 'snap.jpg');
  try {
    await ffmpegGrabFrame(
      cfg.ffmpegBin,
      localInput,
      out,
      Math.min(cfg.timeoutMs, 45_000),
      cfg.signal,
    );
  } catch (err) {
    log.debug({ err, url: safeUrlForLog(pageUrl) }, 'snapshot ffmpeg grab failed');
    return null;
  }
  return existsSync(out) ? out : null;
}

function cookieDomain(hostname: string): string {
  const host = hostname
    .replace(/\.$/, '')
    .replace(/^www\./, '')
    .toLowerCase();
  if (hostMatches(host, 'instagr.am')) return 'instagram.com';
  if (hostMatches(host, 'fb.watch')) return 'facebook.com';
  if (hostMatches(host, 'youtu.be') || hostMatches(host, 'youtube-nocookie.com'))
    return 'youtube.com';
  if (
    hostMatches(host, 'fxtwitter.com') ||
    hostMatches(host, 'vxtwitter.com') ||
    hostMatches(host, 'fixupx.com')
  )
    return 'x.com';
  for (const domain of [
    'instagram.com',
    'tiktok.com',
    'facebook.com',
    'youtube.com',
    'x.com',
    'twitter.com',
  ]) {
    if (hostMatches(host, domain)) return domain === 'youtu.be' ? 'youtube.com' : domain;
  }
  return host;
}
