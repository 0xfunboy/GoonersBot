import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkExtractorContext } from '../src/providers/media/linkMedia/types.js';

const mocks = vi.hoisted(() => ({ fetchText: vi.fn() }));

vi.mock('../src/providers/media/linkMedia/http.js', () => ({
  fetchText: mocks.fetchText,
}));

import { twitterExtractor } from '../src/providers/media/linkMedia/extractors/twitter.js';
import { redditExtractor } from '../src/providers/media/linkMedia/extractors/reddit.js';
import { blueskyExtractor } from '../src/providers/media/linkMedia/extractors/bluesky.js';

const context: LinkExtractorContext = {
  timeoutMs: 1_000,
  userAgent: 'social-extractor-test',
  maxMediaPerUrl: 6,
};

beforeEach(() => {
  mocks.fetchText.mockReset();
});

describe('native social link metadata', () => {
  it('extracts X video context and keeps the clip on the guarded yt-dlp route', async () => {
    mocks.fetchText.mockResolvedValue(
      JSON.stringify({
        tweet: {
          text: 'The tweet text',
          likes: 1500,
          retweets: 23,
          replies: 4,
          views: 9999,
          author: { name: 'X Creator', screen_name: 'xcreator' },
          media: { all: [{ type: 'video', url: 'https://video.twimg.com/clip.mp4' }] },
        },
      }),
    );

    const post = await twitterExtractor.extract(
      new URL('https://x.com/xcreator/status/123456'),
      context,
    );

    expect(mocks.fetchText).toHaveBeenCalledWith(
      'https://api.fxtwitter.com/status/123456',
      expect.any(Object),
    );
    expect(post).toMatchObject({
      platform: 'twitter',
      description: 'The tweet text',
      author: 'X Creator',
      authorHandle: 'xcreator',
      stats: { likes: 1500, reposts: 23, replies: 4, views: 9999 },
      caption: 'The tweet text\n👤 X Creator (social: xcreator)\n❤ 1.5K  🔁 23  💬 4  👁 10K',
      items: [{ kind: 'video', via: 'ytdlp' }],
    });
  });

  it('labels Reddit score, comments and crossposts without calling score a like', async () => {
    mocks.fetchText.mockResolvedValue(
      JSON.stringify([
        {
          data: {
            children: [
              {
                data: {
                  id: 'abc',
                  permalink: '/r/test/comments/abc/a_post/',
                  title: 'A post',
                  selftext: 'Post body',
                  author: 'redditor',
                  score: 2300,
                  num_comments: 18,
                  num_crossposts: 2,
                  url_overridden_by_dest: 'https://cdn.example.test/photo.jpg',
                },
              },
            ],
          },
        },
      ]),
    );

    const post = await redditExtractor.extract(
      new URL('https://www.reddit.com/r/test/comments/abc/a_post/'),
      context,
    );

    expect(post).toMatchObject({
      title: 'A post',
      description: 'Post body',
      author: 'u/redditor',
      stats: { score: 2300, comments: 18, reposts: 2 },
      caption: 'A post\nPost body\n👤 u/redditor\n🔁 2  💬 18  ⬆ 2.3K',
    });
  });

  it('retains Bluesky author/text/counts and routes native video through yt-dlp', async () => {
    mocks.fetchText.mockResolvedValue(
      JSON.stringify({
        thread: {
          post: {
            cid: 'bafy-post',
            record: { text: 'Sky post' },
            author: { displayName: 'Sky Creator', handle: 'sky.example' },
            likeCount: 10,
            repostCount: 2,
            replyCount: 1,
            embed: { playlist: 'https://video.bsky.app/watch/playlist.m3u8' },
          },
        },
      }),
    );

    const post = await blueskyExtractor.extract(
      new URL('https://bsky.app/profile/sky.example/post/abc'),
      context,
    );

    expect(post).toMatchObject({
      description: 'Sky post',
      author: 'Sky Creator',
      authorHandle: 'sky.example',
      stats: { likes: 10, reposts: 2, replies: 1 },
      caption: 'Sky post\n👤 Sky Creator (social: sky.example)\n❤ 10  🔁 2  💬 1',
      items: [
        {
          kind: 'video',
          url: 'https://bsky.app/profile/sky.example/post/abc',
          via: 'ytdlp',
        },
      ],
    });
  });
});
