import { describe, expect, it } from 'vitest';
import {
  NSFW_HOSTS,
  YTDLP_ADULT_HOSTS,
  hostMatches,
  isKnownYtdlpHost,
  isNsfwHost,
  normalizeHost,
} from '../src/providers/media/linkMedia/hosts.js';
import { genericHtmlExtractor } from '../src/providers/media/linkMedia/genericHtmlExtractor.js';
import { isSafeYtdlpFallback, pickExtractor } from '../src/providers/media/linkMedia/registry.js';
import {
  ytdlpExtractor,
  ytdlpModeFor,
} from '../src/providers/media/linkMedia/extractors/ytdlpSites.js';
import type {
  LinkExtractorContext,
  LinkMediaPlatform,
} from '../src/providers/media/linkMedia/types.js';

const extractorContext: LinkExtractorContext = {
  timeoutMs: 1_000,
  userAgent: 'registry-test',
  maxMediaPerUrl: 1,
};

describe('link-media yt-dlp registry', () => {
  it.each([
    ['https://www.youtube.com/shorts/abc', 'youtube'],
    ['https://youtu.be/abc', 'youtube'],
    ['https://vm.tiktok.com/ZMabc/', 'tiktok'],
    ['https://www.instagram.com/reel/abc/', 'instagram'],
    ['https://www.facebook.com/reel/123', 'facebook'],
    ['https://fb.watch/abc/', 'facebook'],
    ['https://www.redgifs.com/watch/example', 'redgifs'],
    ['https://www.snapchat.com/spotlight/example', 'snapchat'],
    ['https://www.pinterest.com/pin/123/', 'pinterest'],
    ['https://www.douyin.com/video/123', 'douyin'],
    ['https://likee.video/@author/video/123', 'likee'],
    ['https://rumble.com/v123-example.html', 'rumble'],
    ['https://www.bilibili.com/video/BV123', 'bilibili'],
    ['https://www.linkedin.com/posts/example', 'linkedin'],
    ['https://www.loom.com/share/abc', 'loom'],
    ['https://medal.tv/games/example/clips/abc', 'medal'],
  ] satisfies Array<[string, LinkMediaPlatform]>)(
    'routes %s through yt-dlp as %s',
    async (raw, platform) => {
      const url = new URL(raw);
      const extractor = pickExtractor(url);

      expect(extractor).toBe(ytdlpExtractor);
      const post = await extractor.extract(url, extractorContext);
      expect(post?.platform).toBe(platform);
      expect(post?.items).toEqual([
        expect.objectContaining({ kind: 'video', url: url.toString(), via: 'ytdlp' }),
      ]);
    },
  );

  it.each([
    ['https://x.com/user/status/123', 'twitter'],
    ['https://www.reddit.com/r/test/comments/abc/post/', 'reddit'],
    ['https://bsky.app/profile/user.example/post/abc', 'bluesky'],
    ['https://www.threads.net/@user/post/abc', 'threads'],
    ['https://imgur.com/abc', 'imgur'],
  ] satisfies Array<[string, LinkMediaPlatform]>)(
    'keeps native context extractor ahead of yt-dlp for %s',
    (raw, platform) => {
      const extractor = pickExtractor(new URL(raw));

      expect(extractor).not.toBe(ytdlpExtractor);
      expect(extractor.platform).toBe(platform);
    },
  );

  it('allows an explicitly configured extra host without enabling arbitrary hosts', async () => {
    const trusted = new URL('https://clips.media.example/watch/123');
    const lookalike = new URL('https://media.example.attacker.test/watch/123');

    expect(pickExtractor(trusted)).toBe(genericHtmlExtractor);
    const configured = pickExtractor(trusted, { extraYtdlpHosts: ['*.media.example'] });
    expect(configured.match(trusted)).toBe(true);
    expect(await configured.extract(trusted, extractorContext)).toMatchObject({
      platform: 'generic',
      items: [{ kind: 'video', via: 'ytdlp' }],
    });
    expect(pickExtractor(lookalike, { extraYtdlpHosts: ['media.example'] })).toBe(
      genericHtmlExtractor,
    );
  });

  it('only advertises yt-dlp fallback for curated native/known or configured hosts', () => {
    expect(isSafeYtdlpFallback(new URL('https://x.com/user/status/123'))).toBe(true);
    expect(isSafeYtdlpFallback(new URL('https://reddit.com/r/test/comments/abc/post'))).toBe(true);
    expect(isSafeYtdlpFallback(new URL('https://bsky.app/profile/a/post/b'))).toBe(true);
    expect(isSafeYtdlpFallback(new URL('https://threads.net/@a/post/b'))).toBe(true);
    expect(isSafeYtdlpFallback(new URL('https://unknown.example/video'))).toBe(false);
    expect(
      isSafeYtdlpFallback(new URL('https://video.partner.example/watch/1'), {
        extraYtdlpHosts: ['partner.example'],
      }),
    ).toBe(true);
    expect(
      isSafeYtdlpFallback(new URL('https://partner.example.attacker.test/watch/1'), {
        extraYtdlpHosts: ['partner.example'],
      }),
    ).toBe(false);
  });

  it.each([
    ['https://www.instagram.com/p/carousel/', 'bounded_playlist'],
    ['https://www.instagram.com/reel/clip/', 'single'],
    ['https://www.tiktok.com/@person/photo/123', 'bounded_playlist'],
    ['https://vm.tiktok.com/ZMshare/', 'bounded_playlist'],
    ['https://www.tiktok.com/@person/video/123', 'single'],
    ['https://www.youtube.com/playlist?list=PL123', 'bounded_playlist'],
    ['https://www.youtube.com/shorts/abc?list=PL123', 'single'],
  ] as const)('classifies bounded carousel routing for %s', (raw, expected) => {
    expect(ytdlpModeFor(new URL(raw))).toBe(expected);
  });
});

describe('link-media shared host policy', () => {
  it('gates RedGifs and all built-in adult yt-dlp hosts as NSFW', () => {
    expect(NSFW_HOSTS).toContain('redgifs.com');
    expect(isNsfwHost('redgifs.com')).toBe(true);
    expect(isNsfwHost('media.redgifs.com')).toBe(true);
    expect(isKnownYtdlpHost('www.redgifs.com')).toBe(true);
    expect(YTDLP_ADULT_HOSTS.every((host) => isNsfwHost(host))).toBe(true);
    expect(isNsfwHost('www.hentaisaturn.tv')).toBe(true);
    expect(isNsfwHost('hentaisaturn.tv.attacker.test')).toBe(false);
  });

  it('uses domain boundaries and rejects URL-shaped host configuration values', () => {
    expect(hostMatches('www.instagram.com', 'instagram.com')).toBe(true);
    expect(hostMatches('cdn.instagram.com', '*.instagram.com')).toBe(true);
    expect(hostMatches('instagram.com.attacker.test', 'instagram.com')).toBe(false);
    expect(isNsfwHost('redgifs.com.attacker.test')).toBe(false);
    expect(normalizeHost(' HTTPS://redgifs.com/watch/example ')).toBe('');
    expect(isKnownYtdlpHost('unknown.example', ['', 'https://unknown.example'])).toBe(false);
  });
});
