import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { childLogger } from '../../../utils/logger.js';
import { runProcessChecked } from '../../../utils/process.js';
import { assertSafeUrl } from './http.js';

const log = childLogger('link-media-ytdlp');

export interface YtdlpDownloadConfig {
  ytdlpBin: string;
  ffmpegBin: string;
  maxDownloadBytes: number;
  maxDurationSeconds: number;
  timeoutMs: number;
  proxy?: string | undefined;
  /** either a raw Cookie header string for the host, or a path to a Netscape cookies.txt file */
  cookies?: string | undefined;
}

/** Translate the cookies config into the right yt-dlp args (file -> --cookies, else header). */
function cookieArgs(cookies?: string): string[] {
  if (!cookies) return [];
  if (existsSync(cookies)) return ['--cookies', cookies];
  return ['--add-header', `Cookie:${cookies}`];
}

export interface YtdlpResult {
  file: string;
  title?: string;
  durationSec?: number;
}

async function runYtdlp(bin: string, args: string[], timeoutMs: number): Promise<void> {
  await runProcessChecked(bin, args, { timeoutMs }, 'yt-dlp');
}

/**
 * Download the best <=720p video for a page URL via the yt-dlp binary (handles YouTube and ~1800
 * other sites including adult/cam). yt-dlp merges video+audio with ffmpeg. Returns the file path and
 * metadata, or null on failure / filtered-out (too long, too large).
 */
export async function downloadWithYtdlp(
  pageUrl: string,
  workdir: string,
  cfg: YtdlpDownloadConfig,
): Promise<YtdlpResult | null> {
  const out = join(workdir, 'video.%(ext)s');
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    '--no-progress',
    '--ffmpeg-location',
    cfg.ffmpegBin,
    '-f',
    'best[height<=720][ext=mp4]/best[height<=720]/best',
    '--merge-output-format',
    'mp4',
    '--max-filesize',
    String(Math.floor(cfg.maxDownloadBytes)),
    // skip VODs longer than the cap (live streams without a duration are skipped too, by design:
    // we cannot bound an endless cam capture). VODs are the realistic group case.
    '--match-filter',
    `duration<=${cfg.maxDurationSeconds}`,
    '--write-info-json',
    '-o',
    out,
  ];
  if (cfg.proxy) args.push('--proxy', cfg.proxy);
  args.push(...cookieArgs(cfg.cookies));
  args.push(pageUrl);

  try {
    await runYtdlp(cfg.ytdlpBin, args, cfg.timeoutMs);
  } catch (err) {
    log.debug({ err, url: pageUrl }, 'yt-dlp download failed');
    return null;
  }

  const files = await readdir(workdir).catch(() => [] as string[]);
  const videoFile = files.find((f) => /^video\.(mp4|mkv|webm|mov)$/i.test(f));
  if (!videoFile) return null;

  const result: YtdlpResult = { file: join(workdir, videoFile) };
  const infoFile = files.find((f) => f.endsWith('.info.json'));
  if (infoFile) {
    try {
      const json = JSON.parse(await readFile(join(workdir, infoFile), 'utf8')) as Record<string, unknown>;
      if (typeof json.title === 'string') result.title = json.title;
      if (typeof json.duration === 'number') result.durationSec = json.duration;
    } catch {
      // ignore unreadable info json
    }
  }
  return result;
}

/** Run yt-dlp and capture stdout (used for -g URL resolution). */
async function runYtdlpCapture(bin: string, args: string[], timeoutMs: number): Promise<string> {
  const r = await runProcessChecked(bin, args, { timeoutMs, collectStdout: true }, 'yt-dlp');
  return r.stdout.toString();
}

async function ffmpegGrabFrame(bin: string, streamUrl: string, out: string, timeoutMs: number): Promise<void> {
  await runProcessChecked(
    bin,
    ['-hide_banner', '-loglevel', 'error', '-y', '-user_agent', 'Mozilla/5.0', '-i', streamUrl, '-frames:v', '1', '-q:v', '2', '-vf', "scale='min(1024,iw)':-2", out],
    { timeoutMs },
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
  const args = ['--no-warnings', '--no-playlist', '-f', 'best[height<=720]/best', '-g'];
  if (cfg.proxy) args.push('--proxy', cfg.proxy);
  args.push(...cookieArgs(cfg.cookies));
  args.push(pageUrl);

  let streamUrl: string;
  try {
    const stdout = await runYtdlpCapture(cfg.ytdlpBin, args, Math.min(cfg.timeoutMs, 60000));
    const first = stdout
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean);
    if (!first) return null;
    streamUrl = first;
  } catch (err) {
    log.debug({ err, url: pageUrl }, 'snapshot stream-url resolution failed');
    return null;
  }

  try {
    await assertSafeUrl(streamUrl);
  } catch {
    return null; // refuse private/loopback resolved targets
  }

  const out = join(workdir, 'snap.jpg');
  try {
    await ffmpegGrabFrame(cfg.ffmpegBin, streamUrl, out, Math.min(cfg.timeoutMs, 45000));
  } catch (err) {
    log.debug({ err, url: pageUrl }, 'snapshot ffmpeg grab failed');
    return null;
  }
  return existsSync(out) ? out : null;
}
