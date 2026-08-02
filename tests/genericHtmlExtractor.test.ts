import { afterEach, describe, expect, it, vi } from 'vitest';
import { genericHtmlExtractor } from '../src/providers/media/linkMedia/genericHtmlExtractor.js';
import type { LinkExtractorContext } from '../src/providers/media/linkMedia/types.js';

const context: LinkExtractorContext = {
  timeoutMs: 1_000,
  userAgent: 'generic-extractor-test',
  maxMediaPerUrl: 20,
};

function respondWithHtml(html: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('genericHtmlExtractor', () => {
  it('uses semantic selectors and MIME types for extensionless media URLs', async () => {
    respondWithHtml(`
      <!doctype html>
      <html>
        <head>
          <title>Fallback title</title>
          <meta property="og:title" content="A short clip">
          <link rel="alternate CANONICAL" href="/posts/canonical">
          <meta property="og:video" content="https://cdn.example.test/playback?id=video">
          <meta property="og:video:type" content="video/mp4; codecs=avc1">
          <meta name="twitter:player:stream" content="//stream.example.test/master?id=hls">
          <meta name="twitter:player:stream:content_type" content="application/vnd.apple.mpegurl">
          <meta property="og:image" content="https://cdn.example.test/asset?id=poster">
          <meta property="og:image:type" content="image/webp">
        </head>
        <body>
          <audio src="/media/audio?id=track" type="audio/mpeg"></audio>
          <picture><source src="/media/picture?id=hero" type="image/avif"></picture>
        </body>
      </html>
    `);

    const post = await genericHtmlExtractor.extract(
      new URL('https://1.1.1.1/posts/original?tracking=1'),
      context,
    );
    if (!post) throw new Error('expected extracted media');

    expect(post).toMatchObject({
      title: 'A short clip',
      originalUrl: 'https://1.1.1.1/posts/original?tracking=1',
      canonicalUrl: 'https://1.1.1.1/posts/canonical',
    });
    expect(post.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'video',
          url: 'https://cdn.example.test/playback?id=video',
          mime: 'video/mp4',
        }),
        expect.objectContaining({
          kind: 'video',
          url: 'https://stream.example.test/master?id=hls',
          mime: 'application/vnd.apple.mpegurl',
        }),
        expect.objectContaining({
          kind: 'image',
          url: 'https://cdn.example.test/asset?id=poster',
          mime: 'image/webp',
        }),
        expect.objectContaining({
          kind: 'audio',
          url: 'https://1.1.1.1/media/audio?id=track',
          mime: 'audio/mpeg',
        }),
        expect.objectContaining({
          kind: 'image',
          url: 'https://1.1.1.1/media/picture?id=hero',
          mime: 'image/avif',
        }),
      ]),
    );
    expect(post.items.every((item) => item.via === undefined)).toBe(true);
  });

  it('extracts only contentUrl from JSON-LD VideoObject and ImageObject nodes', async () => {
    respondWithHtml(`
      <html>
        <head>
          <script type="application/ld+json">not valid json</script>
          <script type="application/ld+json; charset=utf-8">
            {
              "@graph": [
                {
                  "@type": "Article",
                  "contentUrl": "https://pages.example.test/not-media"
                },
                {
                  "@type": ["Thing", "https://schema.org/VideoObject"],
                  "url": "https://pages.example.test/watch/123",
                  "contentUrl": [
                    "https://media.example.test/delivery?id=123",
                    "javascript:alert(1)",
                    "https://user:secret@media.example.test/private"
                  ],
                  "encodingFormat": "video/webm"
                },
                {
                  "nested": {
                    "@type": "ImageObject",
                    "contentUrl": "/images/poster.gif"
                  }
                }
              ]
            }
          </script>
        </head>
      </html>
    `);

    const post = await genericHtmlExtractor.extract(new URL('https://1.1.1.1/watch/123'), context);
    if (!post) throw new Error('expected extracted media');

    expect(post.items).toHaveLength(2);
    expect(post.items).toEqual([
      {
        kind: 'video',
        url: 'https://media.example.test/delivery?id=123',
        mime: 'video/webm',
        index: 0,
      },
      {
        kind: 'gif',
        url: 'https://1.1.1.1/images/poster.gif',
        index: 1,
      },
    ]);
    expect(post.items.map((item) => item.url)).not.toContain(
      'https://pages.example.test/watch/123',
    );
  });

  it('falls back to a safe og:url when a canonical link is unusable', async () => {
    respondWithHtml(`
      <link rel="canonical" href="data:text/html,not-a-page">
      <meta property="og:url" content="/clean-page">
      <meta property="og:image" content="/poster.jpg">
    `);

    const post = await genericHtmlExtractor.extract(new URL('https://1.1.1.1/source'), context);

    expect(post?.canonicalUrl).toBe('https://1.1.1.1/clean-page');
  });

  it('retains the SSRF-safe fetch guard for the source page', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      genericHtmlExtractor.extract(new URL('http://127.0.0.1/private'), context),
    ).rejects.toThrow(/publicly routable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
