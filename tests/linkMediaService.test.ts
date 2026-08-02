import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context as GrammyContext } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkMediaConfig } from '../src/config/index.js';
import type { ExtractedMediaPost } from '../src/providers/media/linkMedia/types.js';
import { LinkMediaService } from '../src/services/linkMedia.js';
import { fakeStorage } from './helpers.js';

const mocks = vi.hoisted(() => ({
  extract: vi.fn(),
  download: vi.fn(async (_url: string, destination: string) => {
    const { writeFile: write } = await import('node:fs/promises');
    await write(destination, Buffer.from('image'));
    return {
      bytes: 5,
      finalUrl: _url,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      contentType: 'image/jpeg',
    };
  }),
  sendPrepared: vi.fn(),
  sendCached: vi.fn(),
  ytdlpMany: vi.fn(),
  ytdlpSnapshot: vi.fn(),
  recognized: false,
}));

vi.mock('../src/providers/media/linkMedia/registry.js', () => {
  const extractor = {
    platform: 'generic' as const,
    match: () => true,
    extract: mocks.extract,
  };
  return {
    pickExtractor: () => extractor,
    isSafeYtdlpFallback: () => mocks.recognized,
  };
});

vi.mock('../src/providers/media/linkMedia/http.js', () => ({
  downloadToFile: mocks.download,
}));

vi.mock('../src/providers/media/linkMedia/normalizer.js', () => ({
  normalizeAudio: vi.fn(),
  normalizeGifAsMp4: vi.fn(),
  normalizeVideo: vi.fn(async (source: string, destination: string) => {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(source, destination);
  }),
  remuxFaststart: vi.fn(async (source: string, destination: string) => {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(source, destination);
  }),
  probeVideo: vi.fn(async () => ({})),
  isTelegramCompatibleVideo: vi.fn(() => true),
  videoThumbnail: vi.fn(async () => false),
}));

vi.mock('../src/providers/media/linkMedia/telegramSender.js', () => ({
  sendPreparedMedia: mocks.sendPrepared,
  sendCachedMedia: mocks.sendCached,
}));

vi.mock('../src/providers/media/linkMedia/ytdlp.js', () => ({
  downloadManyWithYtdlp: mocks.ytdlpMany,
  downloadWithYtdlp: vi.fn(),
  snapshotStream: mocks.ytdlpSnapshot,
}));

vi.mock('../src/providers/voice/ffmpeg.js', () => ({
  extractVideoFrame: vi.fn(),
}));

const roots: string[] = [];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'goonerbot-link-media-'));
  roots.push(root);
  mocks.extract.mockReset();
  mocks.download.mockReset();
  mocks.download.mockImplementation(async (url: string, destination: string) => {
    await writeFile(destination, Buffer.from('image'));
    return {
      bytes: 5,
      finalUrl: url,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      contentType: 'image/jpeg',
    };
  });
  mocks.sendPrepared.mockReset();
  mocks.sendCached.mockReset();
  mocks.ytdlpMany.mockReset();
  mocks.ytdlpSnapshot.mockReset();
  mocks.recognized = false;
  let messageId = 100;
  mocks.sendPrepared.mockImplementation(async () => ({
    fileId: `file-${messageId}`,
    messageId: ++messageId,
    kind: 'image',
  }));
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function post(items: ExtractedMediaPost['items']): ExtractedMediaPost {
  return {
    platform: 'generic',
    originalUrl: 'https://source.example/post',
    canonicalUrl: 'https://source.example/post',
    caption: 'post caption',
    items,
  };
}

function config(overrides: Partial<LinkMediaConfig> = {}): LinkMediaConfig {
  return {
    enabled: true,
    autoRehost: true,
    aiCommentEnabled: false,
    commentOnlyWhenAddressed: false,
    maxUrlsPerMessage: 2,
    maxMediaPerUrl: 6,
    maxDownloadBytes: 1024 * 1024,
    maxUploadBytes: 1024 * 1024,
    maxDurationSeconds: 180,
    aiMaxDurationSeconds: 90,
    timeoutMs: 10_000,
    chatCooldownSeconds: 0,
    userCooldownSeconds: 0,
    tmpDir: root,
    allowedHosts: [],
    blockedHosts: [],
    nsfwAllow: false,
    cookies: {
      default: undefined,
      instagram: undefined,
      tiktok: undefined,
      facebook: undefined,
      x: undefined,
      youtube: undefined,
    },
    extraYtdlpHosts: [],
    ytdlpImpersonate: undefined,
    ytdlpJsRuntime: `node:${process.execPath}`,
    bwrapBin: undefined,
    proxy: undefined,
    cacheTtlDays: 30,
    ffmpegBin: '/usr/bin/ffmpeg',
    ffmpegAvailable: true,
    ytdlpBin: '/bin/false',
    ytdlpAvailable: false,
    userAgent: 'test',
    ...overrides,
  };
}

function harness(
  options: {
    cached?: Record<string, unknown> | null;
    quotaAllowed?: boolean;
    cfg?: Partial<LinkMediaConfig>;
  } = {},
) {
  const upsert = vi.fn(async () => undefined);
  const cacheDelete = vi.fn(async () => undefined);
  const reserveMedia = vi.fn(async () => ({ allowed: options.quotaAllowed !== false }));
  const canReserveMedia = vi.fn(async () => ({ allowed: options.quotaAllowed !== false }));
  const releaseMedia = vi.fn(async () => undefined);
  const storage = fakeStorage({
    linkMediaCache: {
      get: vi.fn(async () => options.cached ?? null),
      touch: vi.fn(async () => undefined),
      delete: cacheDelete,
      upsert,
    },
  });
  const service = new LinkMediaService(
    config(options.cfg),
    storage,
    {} as never,
    { reserveMedia, canReserveMedia, releaseMedia } as never,
  );
  return { service, upsert, cacheDelete, reserveMedia, canReserveMedia, releaseMedia };
}

const person = { telegramId: 42, userHandle: '@tester' };
const context = {
  chatId: -100,
  messageId: 77,
  isGroup: true,
  isBotMentioned: false,
  isGroupAdmin: false,
  isReplyToBot: false,
};

describe('LinkMediaService', () => {
  it('delivers every gallery item, captions the first success and avoids mono-item cache', async () => {
    mocks.extract.mockResolvedValue(
      post([
        { kind: 'image', url: 'https://media.example/one.jpg' },
        { kind: 'image', url: 'https://media.example/two.jpg' },
      ]),
    );
    const { service, reserveMedia, upsert } = harness();

    const result = await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://source.example/post',
      addressed: false,
    });

    expect(result).toMatchObject({ handled: true, messageIds: [101, 102] });
    expect(mocks.sendPrepared).toHaveBeenCalledTimes(2);
    expect(mocks.sendPrepared.mock.calls[0]?.[0]).toMatchObject({ caption: 'post caption' });
    expect(mocks.sendPrepared.mock.calls[1]?.[0].caption).toBeUndefined();
    expect(reserveMedia).toHaveBeenCalledTimes(2);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('downloads a yt-dlp carousel once and delivers every bounded entry without caching it', async () => {
    mocks.extract.mockResolvedValue(
      post([
        {
          kind: 'video',
          url: 'https://instagram.com/p/carousel/',
          via: 'ytdlp',
          ytdlpMode: 'bounded_playlist',
        },
      ]),
    );
    mocks.ytdlpMany.mockImplementation(async (_url: string, workdir: string) => {
      const first = join(workdir, 'item-00001.mp4');
      const second = join(workdir, 'item-00002.mp4');
      await writeFile(first, Buffer.from('video-one'));
      await writeFile(second, Buffer.from('video-two'));
      return {
        items: [
          { file: first, sequence: 1, durationSec: 4 },
          { file: second, sequence: 2, durationSec: 5 },
        ],
        isPlaylist: true,
        partial: false,
      };
    });
    const { service, upsert, reserveMedia } = harness({
      cfg: { ytdlpAvailable: true },
    });

    const result = await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://instagram.com/p/carousel/',
      addressed: false,
    });

    expect(result).toMatchObject({ handled: true, messageIds: [101, 102] });
    expect(mocks.ytdlpMany).toHaveBeenCalledOnce();
    expect(mocks.sendPrepared).toHaveBeenCalledTimes(2);
    expect(mocks.sendPrepared.mock.calls[0]?.[0]).toMatchObject({ caption: 'post caption' });
    expect(mocks.sendPrepared.mock.calls[1]?.[0].caption).toBeUndefined();
    expect(reserveMedia).toHaveBeenCalledTimes(2);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not cache a snapshot fallback for a temporarily unavailable carousel', async () => {
    mocks.extract.mockResolvedValue(
      post([
        {
          kind: 'video',
          url: 'https://instagram.com/p/carousel/',
          via: 'ytdlp',
          ytdlpMode: 'bounded_playlist',
        },
      ]),
    );
    mocks.ytdlpMany.mockResolvedValue(null);
    mocks.ytdlpSnapshot.mockImplementation(async (_url: string, workdir: string) => {
      const snapshot = join(workdir, 'snap.jpg');
      await writeFile(snapshot, Buffer.from('image'));
      return snapshot;
    });
    const { service, upsert } = harness({ cfg: { ytdlpAvailable: true } });

    await expect(
      service.handleMessage({
        ctx: {} as GrammyContext,
        person,
        context,
        text: 'https://instagram.com/p/carousel/',
        addressed: false,
      }),
    ).resolves.toMatchObject({ handled: true, messageIds: [101] });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('uses the first successfully delivered carousel entry title for its caption', async () => {
    mocks.extract.mockResolvedValue({
      ...post([
        {
          kind: 'video',
          url: 'https://instagram.com/p/carousel/',
          via: 'ytdlp',
          ytdlpMode: 'bounded_playlist',
        },
      ]),
      caption: undefined,
    });
    mocks.ytdlpMany.mockImplementation(async (_url: string, workdir: string) => {
      const first = join(workdir, 'item-00001.mp4');
      const second = join(workdir, 'item-00002.mp4');
      await writeFile(first, Buffer.from('video-one'));
      await writeFile(second, Buffer.from('video-two'));
      return {
        items: [
          { file: first, sequence: 1, title: 'First failed title' },
          { file: second, sequence: 2, title: 'Second delivered title' },
        ],
        isPlaylist: true,
        partial: false,
      };
    });
    mocks.sendPrepared.mockRejectedValueOnce(new Error('first upload failed'));
    const { service } = harness({ cfg: { ytdlpAvailable: true } });

    await expect(
      service.handleMessage({
        ctx: {} as GrammyContext,
        person,
        context,
        text: 'https://instagram.com/p/carousel/',
        addressed: false,
      }),
    ).resolves.toMatchObject({ handled: true, messageIds: [101] });
    expect(mocks.sendPrepared.mock.calls[1]?.[0]).toMatchObject({
      caption: 'Second delivered title',
    });
  });

  it('continues after one gallery item fails and keeps the caption on the first delivery', async () => {
    mocks.extract.mockResolvedValue(
      post([
        { kind: 'image', url: 'https://media.example/broken.jpg' },
        { kind: 'image', url: 'https://media.example/good.jpg' },
      ]),
    );
    mocks.download.mockImplementation(async (url: string, destination: string) => {
      if (url.includes('broken')) throw new Error('network failure');
      await writeFile(destination, Buffer.from('image'));
      return {
        bytes: 5,
        finalUrl: url,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        contentType: 'image/jpeg',
      };
    });
    const { service } = harness();

    const result = await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://source.example/post',
      addressed: false,
    });

    expect(result).toMatchObject({
      handled: true,
      messageIds: [101],
      failedUrls: ['https://source.example/post'],
    });
    expect(mocks.sendPrepared.mock.calls[0]?.[0]).toMatchObject({ caption: 'post caption' });
  });

  it('stops before extraction when the media quota is already exhausted', async () => {
    mocks.recognized = true;
    const { service } = harness({ quotaAllowed: false });

    const result = await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://youtube.com/shorts/demo',
      addressed: false,
    });

    expect(result).toMatchObject({ handled: false, reason: 'download_failed' });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('rolls back an invalid cache hit and reserves the fresh file at its real size', async () => {
    mocks.sendCached.mockRejectedValue(new Error('wrong file identifier'));
    mocks.extract.mockResolvedValue(
      post([{ kind: 'image', url: 'https://media.example/fresh.jpg' }]),
    );
    const cached = {
      kind: 'image',
      telegramFileId: 'stale',
      caption: 'cached',
      byteSize: 1,
    };
    const { service, releaseMedia, reserveMedia, cacheDelete } = harness({ cached });

    const result = await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://source.example/post',
      addressed: false,
    });

    expect(result.handled).toBe(true);
    expect(releaseMedia).toHaveBeenCalledWith(-100, 1);
    expect(cacheDelete).toHaveBeenCalledOnce();
    expect(reserveMedia).toHaveBeenLastCalledWith(-100, 5);
  });

  it('keeps a successful Telegram delivery successful when the cache write fails', async () => {
    mocks.extract.mockResolvedValue(
      post([{ kind: 'image', url: 'https://media.example/image.jpg' }]),
    );
    const { service, upsert } = harness();
    upsert.mockRejectedValue(new Error('mongo unavailable'));

    await expect(
      service.handleMessage({
        ctx: {} as GrammyContext,
        person,
        context,
        text: 'https://source.example/post',
        addressed: false,
      }),
    ).resolves.toMatchObject({ handled: true, messageIds: [101] });
  });

  it('rolls quota back when Telegram rejects a fresh upload', async () => {
    mocks.extract.mockResolvedValue(
      post([{ kind: 'image', url: 'https://media.example/image.jpg' }]),
    );
    mocks.sendPrepared.mockRejectedValue(new Error('network timeout'));
    const { service, releaseMedia } = harness();

    const result = await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://source.example/post',
      addressed: false,
    });

    expect(result).toMatchObject({
      handled: false,
      failedUrls: ['https://source.example/post'],
    });
    expect(releaseMedia).toHaveBeenCalledWith(-100, 5);
  });

  it('keeps a valid cache on transient Telegram failure and does not redownload', async () => {
    mocks.sendCached.mockRejectedValue(
      Object.assign(new Error('Too Many Requests'), { error_code: 429 }),
    );
    const cached = {
      kind: 'image',
      telegramFileId: 'valid-file-id',
      caption: 'cached',
      byteSize: 5,
    };
    const { service, releaseMedia, cacheDelete } = harness({ cached });

    const result = await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://source.example/post',
      addressed: false,
    });

    expect(result.handled).toBe(false);
    expect(releaseMedia).toHaveBeenCalledWith(-100, 5);
    expect(cacheDelete).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('blocks an adult media target embedded by an otherwise allowed page', async () => {
    mocks.extract.mockResolvedValue(
      post([{ kind: 'video', url: 'https://thumbs.redgifs.com/hidden.mp4' }]),
    );
    const { service } = harness();

    const result = await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://source.example/post',
      addressed: false,
    });

    expect(result).toMatchObject({
      handled: false,
      failedUrls: ['https://source.example/post'],
    });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('records the final redirect host and NSFW policy in the cache', async () => {
    mocks.extract.mockResolvedValue(
      post([{ kind: 'image', url: 'https://media.example/redirecting.jpg' }]),
    );
    mocks.download.mockImplementation(async (_url: string, destination: string) => {
      await writeFile(destination, Buffer.from('image'));
      return {
        bytes: 5,
        finalUrl: 'https://thumbs.redgifs.com/final.jpg',
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        contentType: 'image/jpeg',
      };
    });
    const { service, upsert } = harness({ cfg: { nsfwAllow: true } });

    await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://source.example/post',
      addressed: false,
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ mediaHost: 'thumbs.redgifs.com', nsfw: true }),
    );
  });

  it('uses the shared cookie jar as a site fallback and honors a raw site override', async () => {
    const jar = join(root, 'cookies.txt');
    await writeFile(
      jar,
      '# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tshared\n',
    );
    mocks.extract.mockResolvedValue(
      post([{ kind: 'image', url: 'https://media.example/image.jpg' }]),
    );
    const shared = harness({
      cfg: {
        cookies: {
          default: jar,
          instagram: undefined,
          tiktok: undefined,
          facebook: undefined,
          x: undefined,
          youtube: undefined,
        },
      },
    });

    await shared.service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://instagram.com/reel/demo',
      addressed: false,
    });
    expect(mocks.extract.mock.calls[0]?.[1]).toMatchObject({ cookies: 'sessionid=shared' });

    mocks.extract.mockClear();
    const overridden = harness({
      cfg: {
        cookies: {
          default: jar,
          instagram: 'sessionid=override',
          tiktok: undefined,
          facebook: undefined,
          x: undefined,
          youtube: undefined,
        },
      },
    });
    await overridden.service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://instagram.com/reel/demo-two',
      addressed: false,
    });
    expect(mocks.extract.mock.calls[0]?.[1]).toMatchObject({ cookies: 'sessionid=override' });
  });

  it('removes only stale scratch directories left by dead downloader processes', async () => {
    const stale = join(root, 'run-999999-deadbeefcafe');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, '.cookies.txt'), 'temporary secret');
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(stale, old, old);
    mocks.extract.mockResolvedValue(
      post([{ kind: 'image', url: 'https://media.example/image.jpg' }]),
    );
    const { service } = harness();

    await service.handleMessage({
      ctx: {} as GrammyContext,
      person,
      context,
      text: 'https://source.example/post',
      addressed: false,
    });

    await expect(access(stale)).rejects.toThrow();
  });
});
