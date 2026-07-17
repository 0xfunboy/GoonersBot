import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeVideo,
  remuxFaststart,
  videoThumbnail,
  type VideoProbe,
} from '../media/linkMedia/normalizer.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('video-prepare');

export interface PreparedVideo {
  buffer: Buffer;
  width?: number;
  height?: number;
  duration?: number;
  /** small JPEG poster so Telegram shows a preview instead of a bare file */
  thumbnail?: Buffer;
}

/**
 * Make generated video bytes play inline in Telegram.
 *
 * Providers (Agnes included) return mp4s with the moov atom at the END, which Telegram cannot
 * stream: the clip would arrive as a downloadable file with no preview and no autoplay. This
 * remuxes +faststart (stream copy, no re-encode) and collects dimensions/duration/poster.
 * On any ffmpeg failure it returns the original bytes rather than losing the clip.
 */
export async function prepareVideoForTelegram(
  buffer: Buffer,
  ffmpegBin: string,
  timeoutMs = 60_000,
): Promise<PreparedVideo> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'goon-video-'));
    const raw = join(dir, 'raw.mp4');
    const out = join(dir, 'out.mp4');
    await writeFile(raw, buffer);

    const opts = { ffmpegBin, timeoutMs, maxUploadBytes: Number.MAX_SAFE_INTEGER };
    await remuxFaststart(raw, out, opts);

    const probe: VideoProbe = await probeVideo(ffmpegBin, out).catch(() => ({}));
    const thumbPath = join(dir, 'thumb.jpg');
    const hasThumb = await videoThumbnail(ffmpegBin, out, thumbPath).catch(() => false);

    const prepared: PreparedVideo = { buffer: await readFile(out) };
    if (typeof probe.width === 'number') prepared.width = probe.width;
    if (typeof probe.height === 'number') prepared.height = probe.height;
    if (typeof probe.duration === 'number') prepared.duration = probe.duration;
    if (hasThumb) prepared.thumbnail = await readFile(thumbPath);
    return prepared;
  } catch (err) {
    log.warn({ err }, 'video prepare failed - sending original bytes');
    return { buffer };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
