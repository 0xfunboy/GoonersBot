import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildYtdlpDownloadArgs,
  buildYtdlpBatchDownloadArgs,
  buildYtdlpSandboxArgs,
  discoverYtdlpResult,
  discoverYtdlpResults,
  downloadManyWithYtdlp,
  downloadWithYtdlp,
  socialMetadataFromYtdlpInfo,
  YtdlpDurationLimitError,
  YTDLP_RELAXED_VIDEO_FORMAT,
  YTDLP_VIDEO_FORMAT,
  type YtdlpDownloadConfig,
} from '../src/providers/media/linkMedia/ytdlp.js';
import { runProcessChecked } from '../src/utils/process.js';

// These tests exercise pure argv/file discovery. Avoid loading undici on the repository's optional
// pre-Node-22 developer runtime; production requires Node >=22 and HTTP safety has separate tests.
vi.mock('../src/providers/media/linkMedia/http.js', () => ({
  assertSafeUrl: vi.fn(),
  downloadToFile: vi.fn(),
}));
vi.mock('../src/utils/process.js', () => ({ runProcessChecked: vi.fn() }));

const workdirs: string[] = [];

function config(overrides: Partial<YtdlpDownloadConfig> = {}): YtdlpDownloadConfig {
  return {
    ytdlpBin: '/opt/yt-dlp',
    ffmpegBin: '/opt/ffmpeg',
    maxDownloadBytes: 50 * 1024 * 1024,
    maxDurationSeconds: 180,
    timeoutMs: 90_000,
    ...overrides,
  };
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

afterEach(async () => {
  vi.mocked(runProcessChecked).mockReset();
  await Promise.all(workdirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('yt-dlp argument hardening', () => {
  it('prefers split H.264/AAC MP4 up to 720p and has bounded network retries', async () => {
    const args = await buildYtdlpDownloadArgs(
      'https://www.youtube.com/shorts/example',
      '/tmp/ytdlp-test',
      config(),
    );

    expect(optionValue(args, '-f')).toBe(YTDLP_VIDEO_FORMAT);
    expect(YTDLP_VIDEO_FORMAT).toContain(
      'bestvideo[height<=?720][ext=mp4][vcodec^=avc]+bestaudio[ext=m4a][acodec^=mp4a]',
    );
    expect(YTDLP_VIDEO_FORMAT).toContain(
      'bestvideo[width<=?720][ext=mp4][vcodec^=avc]+bestaudio[ext=m4a][acodec^=mp4a]',
    );
    expect(YTDLP_VIDEO_FORMAT).toContain('bestvideo[height<=?720]+bestaudio');
    expect(YTDLP_VIDEO_FORMAT).toContain('bestvideo[width<=?720]+bestaudio');
    expect(YTDLP_VIDEO_FORMAT.endsWith('/best')).toBe(false);
    expect(optionValue(args, '--merge-output-format')).toBe('mp4');
    expect(optionValue(args, '--playlist-items')).toBe('1');
    expect(optionValue(args, '--socket-timeout')).toBe('20');
    expect(optionValue(args, '--retries')).toBe('5');
    expect(optionValue(args, '--fragment-retries')).toBe('5');
    expect(optionValue(args, '--file-access-retries')).toBe('5');
    expect(optionValue(args, '--extractor-retries')).toBe('5');
    expect(args.filter((arg) => arg === '--retry-sleep')).toHaveLength(4);
    expect(args).toContain('http:exp=1:10');
    expect(args).toContain('fragment:exp=1:10');
    expect(optionValue(args, '--user-agent')).toMatch(/^Mozilla\/5\.0/);
    expect(optionValue(args, '--print-to-file')).toBe('after_move:filepath');
    const durationTemplate = args.indexOf('pre_process:%(duration)s');
    expect(durationTemplate).toBeGreaterThan(0);
    expect(args[durationTemplate + 1]).toBe('/tmp/ytdlp-test/.ytdlp-duration-seconds.txt');
    expect(args.filter((arg) => arg === '--print-to-file')).toHaveLength(2);
    expect(args).toContain('/tmp/ytdlp-test/.ytdlp-final-paths.txt');
    expect(args.at(-1)).toBe('https://www.youtube.com/shorts/example');
  });

  it('bounds playlist/carousel downloads and uses deterministic numbered output', async () => {
    const args = await buildYtdlpBatchDownloadArgs(
      'https://www.instagram.com/p/carousel/',
      '/tmp/ytdlp-test',
      config(),
      6,
    );

    expect(args).toContain('--yes-playlist');
    expect(args).not.toContain('--no-playlist');
    expect(optionValue(args, '--playlist-items')).toBe('1:6');
    expect(args.filter((arg) => arg === '--playlist-items')).toHaveLength(1);
    expect(optionValue(args, '--concat-playlist')).toBe('never');
    expect(args).toContain('--no-write-playlist-metafiles');
    expect(optionValue(args, '-o')).toBe(
      '/tmp/ytdlp-test/item-%(playlist_index,autonumber)05d.%(ext)s',
    );
  });

  it('builds a private network namespace around yt-dlp and its children', () => {
    const args = buildYtdlpSandboxArgs(
      '/opt/yt-dlp',
      ['--proxy', 'http://127.0.0.1:39173', 'https://example.com/video'],
      '/tmp/job',
      '/tmp/job/.safe-egress.sock',
    );

    expect(args).toContain('--unshare-net');
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/run');
    expect(args).toContain('/tmp/job/.safe-egress.sock');
    expect(args).toContain('/opt/yt-dlp');
    expect(args.at(-1)).toBe('https://example.com/video');
  });

  it('only enables the configured JS runtime and browser impersonation explicitly', async () => {
    const defaults = await buildYtdlpDownloadArgs(
      'https://www.tiktok.com/@person/video/1',
      '/tmp/ytdlp-test',
      config(),
    );
    expect(defaults).not.toContain('--js-runtimes');
    expect(defaults).not.toContain('--impersonate');

    const configured = await buildYtdlpDownloadArgs(
      'https://www.tiktok.com/@person/video/1',
      '/tmp/ytdlp-test',
      config({
        userAgent: 'Bot Browser/1.0',
        jsRuntime: 'node:/usr/bin/node',
        impersonate: 'chrome:windows-10',
      }),
    );
    expect(optionValue(configured, '--user-agent')).toBe('Bot Browser/1.0');
    expect(optionValue(configured, '--js-runtimes')).toBe('node:/usr/bin/node');
    expect(optionValue(configured, '--impersonate')).toBe('chrome:windows-10');
    expect(configured).not.toContain('--remote-components');
  });

  it('keeps raw cookies in a mode-0600 host-scoped jar instead of command arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const args = await buildYtdlpDownloadArgs(
      'https://www.instagram.com/reel/example/',
      dir,
      config({ cookies: 'sessionid=secret; malformed=bad\r\nheader; theme=dark' }),
    );
    const jar = optionValue(args, '--cookies');

    expect(jar).toBe(join(dir, '.cookies.txt'));
    expect(args.join(' ')).not.toContain('sessionid=secret');
    expect(await readFile(jar!, 'utf8')).toBe(
      '# Netscape HTTP Cookie File\n' +
        '.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tsecret\n' +
        '.instagram.com\tTRUE\t/\tTRUE\t0\ttheme\tdark\n',
    );
    expect((await stat(jar!)).mode & 0o777).toBe(0o600);
  });

  it('copies an existing Netscape jar so yt-dlp cannot mutate the mounted source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const source = join(dir, 'mounted-cookies.txt');
    const original = '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tsid\tsecret\n';
    await writeFile(source, original, { mode: 0o400 });

    const args = await buildYtdlpDownloadArgs(
      'https://example.com/video',
      dir,
      config({ cookies: source }),
    );
    const privateJar = optionValue(args, '--cookies');
    expect(privateJar).toBe(join(dir, '.cookies.txt'));
    expect(privateJar).not.toBe(source);
    expect(await readFile(privateJar!, 'utf8')).toBe(original);
    expect((await stat(privateJar!)).mode & 0o777).toBe(0o600);

    await writeFile(privateJar!, 'yt-dlp updated its private copy');
    expect(await readFile(source, 'utf8')).toBe(original);
  });

  it('scopes raw youtu.be cookies to youtube.com for extractor requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const args = await buildYtdlpDownloadArgs(
      'https://youtu.be/example',
      dir,
      config({ cookies: 'SID=secret' }),
    );

    expect(await readFile(optionValue(args, '--cookies')!, 'utf8')).toContain(
      '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret',
    );
  });

  it.each([
    ['https://instagr.am/reel/example', 'instagram.com'],
    ['https://fb.watch/example', 'facebook.com'],
    ['https://www.youtube-nocookie.com/shorts/example', 'youtube.com'],
    ['https://fixupx.com/user/status/1', 'x.com'],
  ])('scopes raw short-domain cookies for redirects from %s', async (url, domain) => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const args = await buildYtdlpDownloadArgs(url, dir, config({ cookies: 'sid=secret' }));

    expect(await readFile(optionValue(args, '--cookies')!, 'utf8')).toContain(
      `.${domain}\tTRUE\t/\tTRUE\t0\tsid\tsecret`,
    );
  });

  it('propagates extractor/auth failures instead of treating them as snapshot candidates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const failure = new Error('yt-dlp exited 1: login required');
    vi.mocked(runProcessChecked).mockRejectedValueOnce(failure);

    await expect(
      downloadWithYtdlp('https://example.com/private-video', dir, config()),
    ).rejects.toBe(failure);
    expect(runProcessChecked).toHaveBeenCalledTimes(1);
  });

  it('retries FB/IG/TikTok once with Chrome impersonation after a normal HTTP failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const video = join(dir, 'video.mp4');
    await writeFile(video, Buffer.alloc(64, 1));
    vi.mocked(runProcessChecked)
      .mockRejectedValueOnce(new Error('yt-dlp exited 1: HTTP Error 403: Forbidden'))
      .mockResolvedValueOnce({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    await expect(
      downloadWithYtdlp('https://www.instagram.com/reel/example/', dir, config()),
    ).resolves.toEqual({ file: video });
    expect(runProcessChecked).toHaveBeenCalledTimes(2);
    const firstArgs = vi.mocked(runProcessChecked).mock.calls[0]?.[1] ?? [];
    const fallbackArgs = vi.mocked(runProcessChecked).mock.calls[1]?.[1] ?? [];
    expect(firstArgs).not.toContain('--impersonate');
    expect(optionValue(fallbackArgs, '--impersonate')).toBe('chrome');
  });

  it('retries a missing Instagram portrait format once with the relaxed selector', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const video = join(dir, 'video.mp4');
    await writeFile(video, Buffer.alloc(64, 1));
    vi.mocked(runProcessChecked)
      .mockRejectedValueOnce(new Error('yt-dlp exited 1: Requested format is not available'))
      .mockResolvedValueOnce({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    await expect(
      downloadWithYtdlp('https://www.instagram.com/reel/portrait/', dir, config()),
    ).resolves.toEqual({ file: video });

    expect(runProcessChecked).toHaveBeenCalledTimes(2);
    const firstArgs = vi.mocked(runProcessChecked).mock.calls[0]?.[1] ?? [];
    const fallbackArgs = vi.mocked(runProcessChecked).mock.calls[1]?.[1] ?? [];
    expect(optionValue(firstArgs, '-f')).toBe(YTDLP_VIDEO_FORMAT);
    expect(optionValue(fallbackArgs, '-f')).toBe(YTDLP_RELAXED_VIDEO_FORMAT);
    const expectedFallbackArgs = [...firstArgs];
    expectedFallbackArgs[expectedFallbackArgs.indexOf('-f') + 1] = YTDLP_RELAXED_VIDEO_FORMAT;
    expect(fallbackArgs).toEqual(expectedFallbackArgs);
  });

  it('stops after one relaxed retry when the requested format is still unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const firstFailure = new Error('yt-dlp exited 1: requested format is not available');
    const fallbackFailure = new Error(
      'yt-dlp exited 1: requested format is not available after relaxed selection',
    );
    vi.mocked(runProcessChecked)
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(fallbackFailure);

    await expect(
      downloadWithYtdlp('https://www.instagram.com/reel/portrait/', dir, config()),
    ).rejects.toBe(fallbackFailure);

    expect(runProcessChecked).toHaveBeenCalledTimes(2);
    const fallbackArgs = vi.mocked(runProcessChecked).mock.calls[1]?.[1] ?? [];
    expect(optionValue(fallbackArgs, '-f')).toBe(YTDLP_RELAXED_VIDEO_FORMAT);
    expect(fallbackArgs).not.toContain('--impersonate');
  });

  it('does not add another fallback when impersonation was explicitly configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const failure = new Error('yt-dlp exited 1: HTTP Error 403: Forbidden');
    vi.mocked(runProcessChecked).mockRejectedValueOnce(failure);

    await expect(
      downloadWithYtdlp(
        'https://vm.tiktok.com/example/',
        dir,
        config({ impersonate: 'chrome:windows-10' }),
      ),
    ).rejects.toBe(failure);
    expect(runProcessChecked).toHaveBeenCalledTimes(1);
  });

  it('does not retry deterministic auth/tooling errors', async () => {
    for (const message of [
      'yt-dlp exited 1: login required; use cookies',
      'yt-dlp exited 1: ffmpeg not found',
    ]) {
      const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
      workdirs.push(dir);
      const failure = new Error(message);
      vi.mocked(runProcessChecked).mockRejectedValueOnce(failure);

      await expect(
        downloadWithYtdlp('https://www.instagram.com/reel/example/', dir, config()),
      ).rejects.toBe(failure);
    }
    expect(runProcessChecked).toHaveBeenCalledTimes(2);
  });

  it('returns null after a successful filtered/no-file run so live media can use snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    vi.mocked(runProcessChecked).mockResolvedValueOnce({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: '',
    });

    await expect(
      downloadWithYtdlp('https://example.com/live-video', dir, config()),
    ).resolves.toBeNull();
  });

  it('throws a typed duration-limit error when yt-dlp filters an overlong VOD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    await writeFile(join(dir, '.ytdlp-duration-seconds.txt'), '635\n');
    vi.mocked(runProcessChecked).mockResolvedValueOnce({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: '',
    });

    const error = await downloadWithYtdlp(
      'https://www.youtube.com/watch?v=overlong',
      dir,
      config(),
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(YtdlpDurationLimitError);
    expect(error).toMatchObject({
      name: 'YtdlpDurationLimitError',
      code: 'duration_exceeded',
      durationSeconds: 635,
      maxDurationSeconds: 180,
    });
    expect(runProcessChecked).toHaveBeenCalledOnce();
  });

  it('reports the duration limit when every bounded playlist entry is overlong', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    await writeFile(join(dir, '.ytdlp-duration-seconds.txt'), '635\n720\n');
    vi.mocked(runProcessChecked).mockResolvedValueOnce({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: '',
    });

    await expect(
      downloadManyWithYtdlp('https://www.youtube.com/playlist?list=overlong', dir, config(), 4),
    ).rejects.toMatchObject({
      name: 'YtdlpDurationLimitError',
      code: 'duration_exceeded',
      durationSeconds: 720,
      maxDurationSeconds: 180,
    });
  });

  it('ignores a linked duration marker instead of trusting a workdir path substitution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const external = join(dir, 'external-duration.txt');
    await writeFile(external, '635\n');
    await symlink(external, join(dir, '.ytdlp-duration-seconds.txt'));
    vi.mocked(runProcessChecked).mockResolvedValueOnce({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: '',
    });

    await expect(
      downloadWithYtdlp('https://example.com/live-video', dir, config()),
    ).resolves.toBeNull();
  });

  it('returns already completed carousel entries as partial after a later yt-dlp failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const first = join(dir, 'item-00001.mp4');
    await writeFile(first, Buffer.alloc(64, 1));
    vi.mocked(runProcessChecked).mockRejectedValueOnce(
      new Error('yt-dlp exited 1: fragment download failed'),
    );

    await expect(
      downloadManyWithYtdlp('https://example.com/carousel', dir, config(), 3),
    ).resolves.toEqual({
      items: [{ file: first, sequence: 1 }],
      isPlaylist: true,
      partial: true,
    });
    expect(runProcessChecked).toHaveBeenCalledOnce();
  });

  it('retries a partially completed Instagram carousel after a retryable 403', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const first = join(dir, 'item-00001.mp4');
    const second = join(dir, 'item-00002.mp4');
    await writeFile(first, Buffer.alloc(64, 1));
    vi.mocked(runProcessChecked)
      .mockRejectedValueOnce(new Error('yt-dlp exited 1: HTTP Error 403: Forbidden'))
      .mockImplementationOnce(async () => {
        await writeFile(second, Buffer.alloc(64, 2));
        return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
      });

    await expect(
      downloadManyWithYtdlp('https://www.instagram.com/p/carousel/', dir, config(), 3),
    ).resolves.toEqual({
      items: [
        { file: first, sequence: 1 },
        { file: second, sequence: 2 },
      ],
      isPlaylist: true,
      partial: false,
    });
    expect(runProcessChecked).toHaveBeenCalledTimes(2);
    expect(
      optionValue(vi.mocked(runProcessChecked).mock.calls[1]?.[1] ?? [], '--impersonate'),
    ).toBe('chrome');
  });
});

describe('yt-dlp final file discovery', () => {
  it('uses the reported after-move path, rejects escaped paths and reads optional metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const video = join(dir, 'video.m4v');
    await writeFile(video, Buffer.alloc(64, 1));
    await writeFile(join(dir, 'video.f137.mp4'), Buffer.alloc(32, 2));
    await writeFile(join(dir, 'video.mp4.part'), Buffer.alloc(32, 3));
    await writeFile(
      join(dir, 'video.info.json'),
      JSON.stringify({
        title: 'A reel',
        description: 'The original post text',
        duration: 12.5,
        uploader: 'Creator Name',
        uploader_id: '@creator',
        like_count: 1234,
        repost_count: 45,
        share_count: 8,
        reply_count: 9,
        comment_count: 6,
        view_count: 7890,
      }),
    );
    await writeFile(
      join(dir, '.ytdlp-final-paths.txt'),
      `${video}\n${join(dir, '..', 'video.mp4')}\n`,
    );

    await expect(discoverYtdlpResult(dir, 1_024)).resolves.toEqual({
      file: video,
      title: 'A reel',
      description: 'The original post text',
      author: 'Creator Name',
      authorHandle: 'creator',
      stats: {
        likes: 1234,
        reposts: 45,
        shares: 8,
        replies: 9,
        comments: 6,
        views: 7890,
      },
      durationSec: 12.5,
    });
  });

  it('sanitizes yt-dlp social fields and ignores invalid metrics and opaque channel ids', () => {
    expect(
      socialMetadataFromYtdlpInfo({
        title: '  Clip\u0000title  ',
        description: 'line one\r\nline two',
        uploader: 'Channel',
        channel_id: 'UC1234567890123456789012',
        like_count: -1,
        comment_count: Number.NaN,
        repost_count: 0,
        view_count: 12.9,
      }),
    ).toEqual({
      title: 'Clip title',
      description: 'line one\nline two',
      author: 'Channel',
      stats: { reposts: 0, views: 12 },
    });
  });

  it('falls back to the deterministic final filename and ignores partial/intermediate files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    await writeFile(join(dir, 'video.f616.webm'), Buffer.alloc(128, 1));
    await writeFile(join(dir, 'video.webm.part'), Buffer.alloc(128, 1));
    expect(await discoverYtdlpResult(dir, 1_024)).toBeNull();

    const final = join(dir, 'video.webm');
    await writeFile(final, Buffer.alloc(128, 1));
    await expect(discoverYtdlpResult(dir, 1_024)).resolves.toEqual({ file: final });
  });

  it('rejects empty and over-limit final files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const final = join(dir, 'video.mp4');
    await writeFile(final, Buffer.alloc(0));
    expect(await discoverYtdlpResult(dir, 10)).toBeNull();

    await writeFile(final, Buffer.alloc(11, 1));
    expect(await discoverYtdlpResult(dir, 10)).toBeNull();
  });

  it('discovers carousel files in order and rejects links, intermediates and escapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-ytdlp-'));
    workdirs.push(dir);
    const first = join(dir, 'item-00001.mp4');
    const second = join(dir, 'item-00002.webm');
    await writeFile(second, Buffer.alloc(20, 2));
    await writeFile(first, Buffer.alloc(10, 1));
    await writeFile(join(dir, 'item-00003.f137.mp4'), Buffer.alloc(10, 3));
    await symlink(first, join(dir, 'item-00003.mp4'));
    await writeFile(
      join(dir, 'item-00001.info.json'),
      JSON.stringify({
        title: 'One',
        description: 'Carousel caption',
        uploader: 'Poster',
        like_count: 10,
        comment_count: 2,
        duration: 3,
        playlist_index: 1,
        n_entries: 3,
      }),
    );
    await writeFile(
      join(dir, '.ytdlp-final-paths.txt'),
      `${second}\n${join(dir, '..', 'item-00004.mp4')}\n${first}\n`,
    );

    await expect(discoverYtdlpResults(dir, 1_024, 3)).resolves.toEqual({
      items: [
        {
          file: first,
          sequence: 1,
          title: 'One',
          description: 'Carousel caption',
          author: 'Poster',
          stats: { likes: 10, comments: 2 },
          durationSec: 3,
          playlistIndex: 1,
        },
        { file: second, sequence: 2 },
      ],
      isPlaylist: true,
      partial: true,
      expectedItems: 3,
    });
  });
});
