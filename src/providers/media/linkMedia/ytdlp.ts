import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { childLogger } from '../../../utils/logger.js';

const log = childLogger('link-media-ytdlp');

export interface YtdlpDownloadConfig {
  ytdlpBin: string;
  ffmpegBin: string;
  maxDownloadBytes: number;
  maxDurationSeconds: number;
  timeoutMs: number;
  proxy?: string | undefined;
  /** raw Cookie header string for the target host, if any */
  cookies?: string | undefined;
}

export interface YtdlpResult {
  file: string;
  title?: string;
  durationSec?: number;
}

function runYtdlp(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('yt-dlp timed out'));
    }, timeoutMs);
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited ${code}: ${err.slice(-400)}`));
    });
  });
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
  if (cfg.cookies) args.push('--add-header', `Cookie:${cfg.cookies}`);
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
