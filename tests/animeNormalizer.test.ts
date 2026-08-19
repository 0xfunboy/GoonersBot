import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnimeVideoOutputTooLargeError,
  decideAnimeVideoPreparation,
  normalizeAnimeVideo,
  shouldStartWithBitrateLimitedAnimeEncode,
  type NormalizeAnimeVideoOptions,
  type VideoProbe,
} from '../src/providers/media/linkMedia/normalizer.js';
import { runProcess, runProcessChecked } from '../src/utils/process.js';

vi.mock('../src/utils/process.js', () => ({ runProcess: vi.fn(), runProcessChecked: vi.fn() }));

const roots: string[] = [];
let input = '';
let output = '';

const probe: VideoProbe = {
  width: 1280,
  height: 720,
  duration: 300,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
};

function opts(overrides: Partial<NormalizeAnimeVideoOptions> = {}): NormalizeAnimeVideoOptions {
  return {
    ffmpegBin: '/opt/ffmpeg',
    timeoutMs: 90_000,
    maxUploadBytes: 100_000,
    profile: 'mobile',
    maxHeight: 720,
    crf: 27,
    audioBitrateKbps: 96,
    threads: 2,
    ...overrides,
  };
}

const processResult = () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

function writeOutputs(...sizes: number[]): void {
  let call = 0;
  vi.mocked(runProcessChecked).mockImplementation(async (_bin, args) => {
    const size = sizes[Math.min(call++, sizes.length - 1)] ?? 1;
    await writeFile(args.at(-1)!, Buffer.alloc(size));
    return processResult();
  });
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'goonerbot-anime-normalizer-'));
  roots.push(root);
  input = join(root, 'raw.mp4');
  output = join(root, 'prepared.mp4');
  await writeFile(input, Buffer.alloc(10_000));
  vi.mocked(runProcess).mockResolvedValue(processResult());
});

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('anime video normalizer', () => {
  it('only remuxes a compatible, bounded source-profile input', () => {
    const source = { profile: 'source' as const, maxHeight: 720, maxUploadBytes: 100_000 };
    expect(decideAnimeVideoPreparation(probe, 99_999, source)).toBe('remux');
    expect(decideAnimeVideoPreparation(probe, 99_999, { ...source, profile: 'mobile' })).toBe(
      'transcode',
    );
    expect(decideAnimeVideoPreparation({ ...probe, height: 1080 }, 99_999, source)).toBe(
      'transcode',
    );
    expect(decideAnimeVideoPreparation(probe, 100_001, source)).toBe('transcode');
    expect(decideAnimeVideoPreparation({ ...probe, videoCodec: 'vp9' }, 99_999, source)).toBe(
      'transcode',
    );
    expect(decideAnimeVideoPreparation({ ...probe, height: undefined }, 99_999, source)).toBe(
      'transcode',
    );
  });

  it('creates a configurable mobile H.264/AAC MP4 without upscaling', async () => {
    writeOutputs(50_000);
    await expect(normalizeAnimeVideo(input, output, opts(), probe)).resolves.toEqual({
      action: 'transcode',
      sizeBytes: 50_000,
      bitrateLimited: false,
    });

    const args = vi.mocked(runProcessChecked).mock.calls[0]?.[1] ?? [];
    expect(args).toEqual(expect.arrayContaining(['libx264', 'yuv420p', 'aac', '+faststart']));
    expect(args[args.indexOf('-crf') + 1]).toBe('27');
    expect(args[args.indexOf('-b:a') + 1]).toBe('96000');
    expect(args[args.indexOf('-threads:v') + 1]).toBe('2');
    expect(args[args.indexOf('-filter_threads') + 1]).toBe('2');
    expect(args[args.indexOf('-vf') + 1]).toBe("scale=-2:'trunc(min(720,ih)/2)*2'");
    expect(args).not.toContain('copy');
  });

  it('remuxes source mode when streams, height and bytes are already safe', async () => {
    writeOutputs(10_100);
    await expect(
      normalizeAnimeVideo(input, output, opts({ profile: 'source' }), probe),
    ).resolves.toEqual({ action: 'remux', sizeBytes: 10_100, bitrateLimited: false });
    const args = vi.mocked(runProcessChecked).mock.calls[0]?.[1] ?? [];
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args).not.toContain('libx264');
  });

  it('retries an oversized CRF encode with a duration-aware bitrate', async () => {
    writeOutputs(120_000, 80_000);
    await expect(
      normalizeAnimeVideo(input, output, opts(), { ...probe, duration: 5 }),
    ).resolves.toEqual({ action: 'transcode', sizeBytes: 80_000, bitrateLimited: true });

    expect(runProcessChecked).toHaveBeenCalledTimes(2);
    const retry = vi.mocked(runProcessChecked).mock.calls[1]?.[1] ?? [];
    const videoBitrate = Number(retry[retry.indexOf('-b:v') + 1]);
    expect(videoBitrate).toBeGreaterThanOrEqual(64_000);
    expect(retry[retry.indexOf('-maxrate') + 1]).toBe(String(videoBitrate));
    expect(retry[retry.indexOf('-bufsize') + 1]).toBe(String(videoBitrate * 2));
  });

  it('starts directly with a bounded 480p bitrate encode for a predictably oversized episode', async () => {
    await truncate(input, 20_000_000);
    writeOutputs(9_000_000);
    const options = opts({ maxUploadBytes: 10_000_000 });

    expect(shouldStartWithBitrateLimitedAnimeEncode(20_000_000, probe, 10_000_000)).toBe(true);
    await expect(normalizeAnimeVideo(input, output, options, probe)).resolves.toEqual({
      action: 'transcode',
      sizeBytes: 9_000_000,
      bitrateLimited: true,
    });

    expect(runProcessChecked).toHaveBeenCalledTimes(1);
    const args = vi.mocked(runProcessChecked).mock.calls[0]?.[1] ?? [];
    expect(args).toContain('-b:v');
    expect(args).not.toContain('-crf');
    expect(args[args.indexOf('-vf') + 1]).toBe("scale=-2:'trunc(min(480,ih)/2)*2'");
  });

  it('rejects a second encode that still exceeds the hard upload cap', async () => {
    writeOutputs(120_000, 110_000);
    await expect(
      normalizeAnimeVideo(input, output, opts(), { ...probe, duration: 5 }),
    ).rejects.toBeInstanceOf(AnimeVideoOutputTooLargeError);
    expect(runProcessChecked).toHaveBeenCalledTimes(2);
  });

  it('uses the bounded anime transcode if a source remux fails', async () => {
    vi.mocked(runProcessChecked)
      .mockRejectedValueOnce(new Error('bad container'))
      .mockImplementationOnce(async (_bin, args) => {
        await writeFile(args.at(-1)!, Buffer.alloc(50_000));
        return processResult();
      });
    await expect(
      normalizeAnimeVideo(input, output, opts({ profile: 'source' }), probe),
    ).resolves.toMatchObject({ action: 'transcode' });
    expect(vi.mocked(runProcessChecked).mock.calls[1]?.[1]).toContain('libx264');
  });
});
