import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileToTelegramVoice } from '../voice/ffmpeg.js';
import { childLogger } from '../../utils/logger.js';
import { runProcessChecked } from '../../utils/process.js';

const log = childLogger('music');

export interface MusicConfig {
  enabled: boolean;
  /** path to the yt-dlp binary (absolute, or a name resolvable on PATH) */
  ytdlpBin: string;
  /** path to ffmpeg (reused from the voice toolchain) */
  ffmpegBin: string;
  ffmpegAvailable: boolean;
  /** hard cap on extracted audio length, in seconds */
  maxDurationSeconds: number;
  /** total time budget for one search+download+transcode, in ms */
  timeoutMs: number;
  /** optional outbound proxy passed to yt-dlp (e.g. http://user:pass@host:port) */
  proxy?: string | undefined;
}

export interface MusicResult {
  /** Telegram-ready OGG/Opus voice-note bytes */
  ogg: Buffer;
  title: string;
  url: string;
  durationSec: number | null;
  /** true when the source was longer than the cap and the audio was truncated */
  truncated: boolean;
}

const URL_RE = /^https?:\/\/(?:[\w-]+\.)?(?:youtube\.com|youtu\.be|music\.youtube\.com)\//i;

/**
 * Music fetcher: searches YouTube (or takes a direct YouTube URL), downloads the first
 * `maxDurationSeconds` of the best audio track via yt-dlp, and transcodes it to a Telegram-ready
 * OGG/Opus voice note. Degrades to null on any failure (no result, timeout, tooling missing).
 */
export class MusicService {
  constructor(private readonly cfg: MusicConfig) {}

  get enabled(): boolean {
    if (!this.cfg.enabled || !this.cfg.ffmpegAvailable) return false;
    // An absolute yt-dlp path must exist; a bare name is assumed resolvable on PATH.
    if (isAbsolute(this.cfg.ytdlpBin)) return existsSync(this.cfg.ytdlpBin);
    return true;
  }

  /** Resolve a query (free text or a YouTube URL) to a playable voice note, or null. */
  async fetch(query: string): Promise<MusicResult | null> {
    if (!this.enabled) return null;
    const q = query.trim();
    if (!q) return null;

    const target = URL_RE.test(q) ? q : `ytsearch1:${q}`;
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'goon-music-'));
      const outTemplate = join(dir, 'track.%(ext)s');
      const args = [
        '--no-playlist',
        '--no-warnings',
        '--quiet',
        '--no-progress',
        '--ffmpeg-location',
        this.cfg.ffmpegBin,
        // Guard against pathologically long sources; the opening window is what we keep anyway
        // (trimmed to maxDurationSeconds during transcode below). Section-cutting in yt-dlp
        // segfaults the static ffmpeg build, so we download then trim ourselves.
        '--max-filesize',
        '80M',
        '-f',
        'bestaudio/best',
        '-x',
        '--audio-format',
        'opus',
        '--audio-quality',
        '0',
        '--write-info-json',
        '-o',
        outTemplate,
      ];
      if (this.cfg.proxy) args.push('--proxy', this.cfg.proxy);
      args.push(target);

      await this.runYtdlp(args);

      const files = await readdir(dir);
      const audioFile = files.find((f) => /\.(opus|ogg|m4a|webm|mp3)$/i.test(f));
      if (!audioFile) {
        log.warn({ query: q }, 'yt-dlp produced no audio file');
        return null;
      }
      const meta = await this.readInfo(dir, files);
      const ogg = await fileToTelegramVoice(this.cfg.ffmpegBin, join(dir, audioFile), {
        maxDurationSec: this.cfg.maxDurationSeconds,
        timeoutMs: this.cfg.timeoutMs,
      });
      if (!ogg.length) return null;

      const durationSec = meta.duration ?? null;
      return {
        ogg,
        title: meta.title || q,
        url: meta.webpage_url || (URL_RE.test(q) ? q : ''),
        durationSec,
        truncated: durationSec !== null && durationSec > this.cfg.maxDurationSeconds,
      };
    } catch (err) {
      log.warn({ err, query: q }, 'music fetch failed');
      return null;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readInfo(
    dir: string,
    files: string[],
  ): Promise<{ title?: string; webpage_url?: string; duration?: number }> {
    const infoFile = files.find((f) => f.endsWith('.info.json'));
    if (!infoFile) return {};
    try {
      const raw = await readFile(join(dir, infoFile), 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      return {
        title: typeof json.title === 'string' ? json.title : undefined,
        webpage_url: typeof json.webpage_url === 'string' ? json.webpage_url : undefined,
        duration: typeof json.duration === 'number' ? json.duration : undefined,
      };
    } catch {
      return {};
    }
  }

  private async runYtdlp(args: string[]): Promise<void> {
    await runProcessChecked(this.cfg.ytdlpBin, args, { timeoutMs: this.cfg.timeoutMs }, 'yt-dlp');
  }
}
