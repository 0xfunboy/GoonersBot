import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeStreamingCommunityUrl,
  streamingCommunityExtractor,
} from '../src/providers/media/linkMedia/extractors/streamingCommunity.js';
import { pickExtractor } from '../src/providers/media/linkMedia/registry.js';
import * as http from '../src/providers/media/linkMedia/http.js';
import type { LinkExtractorContext } from '../src/providers/media/linkMedia/types.js';

const mockCtx: LinkExtractorContext = {
  timeoutMs: 5000,
  userAgent: 'test-agent',
  maxMediaPerUrl: 1,
};

describe('StreamingCommunity extractor', () => {
  describe('URL normalization', () => {
    it('normalizes /titles/ URL to /watch/ URL with default locale', () => {
      const url = new URL(
        'https://streamingcommunityz.shiksha/it/titles/65704-heart-of-the-beast-nel-profondo-selvaggio',
      );
      const normalized = normalizeStreamingCommunityUrl(url);
      expect(normalized?.toString()).toBe('https://streamingcommunityz.shiksha/it/watch/65704');
    });

    it('normalizes titles URL without locale to /it/watch/ URL', () => {
      const url = new URL('https://streamingcommunity.buzz/titles/65704-test-title');
      const normalized = normalizeStreamingCommunityUrl(url);
      expect(normalized?.toString()).toBe('https://streamingcommunity.buzz/it/watch/65704');
    });

    it('preserves query parameters on watch URLs', () => {
      const url = new URL('https://streamingcommunityz.shiksha/it/watch/66348?e=372122');
      const normalized = normalizeStreamingCommunityUrl(url);
      expect(normalized?.toString()).toBe(
        'https://streamingcommunityz.shiksha/it/watch/66348?e=372122',
      );
    });

    it('normalizes iframe URLs to watch URLs', () => {
      const url = new URL('https://streamingcommunityz.shiksha/it/iframe/65704');
      const normalized = normalizeStreamingCommunityUrl(url);
      expect(normalized?.toString()).toBe('https://streamingcommunityz.shiksha/it/watch/65704');
    });

    it('rejects unrelated domains and invalid paths', () => {
      expect(normalizeStreamingCommunityUrl(new URL('https://example.com/watch/65704'))).toBeNull();
      expect(
        normalizeStreamingCommunityUrl(new URL('https://streamingcommunityz.shiksha/about')),
      ).toBeNull();
    });
  });

  describe('Registry integration', () => {
    it('picks streamingCommunityExtractor for StreamingCommunity URLs', () => {
      const url = new URL(
        'https://streamingcommunityz.shiksha/it/titles/65704-heart-of-the-beast-nel-profondo-selvaggio',
      );
      const extractor = pickExtractor(url);
      expect(extractor).toBe(streamingCommunityExtractor);
      expect(extractor.platform).toBe('streamingcommunity');
    });
  });

  describe('extract()', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('extracts movie metadata and resolves VixCloud master playlist', async () => {
      const watchHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <div id="app" data-page='{"props":{"title":{"id":65704,"name":"Heart of the Beast","plot":"A great movie","runtime":101},"embedUrl":"https://streamingcommunityz.shiksha/it/iframe/65704"}}'></div>
        </body>
        </html>
      `;

      const iframeHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <iframe src="https://vixcloud.co/embed/791471?token=testtoken&amp;expires=1792257000&amp;lang=it"></iframe>
        </body>
        </html>
      `;

      const vixHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <script>
            window.video = { id: '791471' };
            window.masterPlaylist = {
              params: {
                'token': 'secrettoken123',
                'expires': '1797441000'
              },
              url: 'https://vixcloud.co/playlist/791471?b=1'
            };
          </script>
        </body>
        </html>
      `;

      const fetchSpy = vi.spyOn(http, 'fetchText').mockImplementation(async (targetUrl) => {
        if (targetUrl.includes('/watch/')) return watchHtml;
        if (targetUrl.includes('/iframe/')) return iframeHtml;
        if (targetUrl.includes('vixcloud.co/embed/')) return vixHtml;
        throw new Error(`Unexpected fetch URL: ${targetUrl}`);
      });

      const url = new URL('https://streamingcommunityz.shiksha/it/watch/65704');
      const post = await streamingCommunityExtractor.extract(url, mockCtx);

      expect(post).not.toBeNull();
      expect(post?.platform).toBe('streamingcommunity');
      expect(post?.title).toBe('Heart of the Beast');
      expect(post?.description).toBe('A great movie');
      expect(post?.items).toHaveLength(1);

      const item = post!.items[0];
      expect(item.kind).toBe('video');
      expect(item.via).toBe('ytdlp');
      expect(item.mime).toBe('application/x-mpegurl');
      expect(item.durationSeconds).toBe(101 * 60);
      expect(item.url).toBe(
        'https://vixcloud.co/playlist/791471?b=1&token=secrettoken123&expires=1797441000&lang=it',
      );
      expect(item.headers?.Referer).toBe('https://vixcloud.co/embed/791471');

      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('extracts TV series episode metadata and formats title with season and episode numbers', async () => {
      const watchHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <div id="app" data-page='{"props":{"title":{"id":66348,"name":"Friends Sex and Games","type":"tv"},"episode":{"number":1,"name":"Episodio 1","duration":32,"season":{"number":1}},"embedUrl":"https://streamingcommunityz.shiksha/it/iframe/66348?episode_id=372122&amp;next_episode=1"}}'></div>
        </body>
        </html>
      `;

      const iframeHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <iframe src="https://vixcloud.co/embed/794489?token=eptoken&amp;expires=1792257000&amp;lang=it&amp;canPlayFHD=1&amp;scz=1"></iframe>
        </body>
        </html>
      `;

      const vixHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <script>
            window.masterPlaylist = {
              params: {
                'token': 'eptokenabc',
                'expires': '1797442000'
              },
              url: 'https://vixcloud.co/playlist/794489?b=1'
            };
          </script>
        </body>
        </html>
      `;

      vi.spyOn(http, 'fetchText').mockImplementation(async (targetUrl) => {
        if (targetUrl.includes('/watch/')) return watchHtml;
        if (targetUrl.includes('/iframe/')) return iframeHtml;
        if (targetUrl.includes('vixcloud.co/embed/')) return vixHtml;
        throw new Error(`Unexpected fetch URL: ${targetUrl}`);
      });

      const url = new URL('https://streamingcommunityz.shiksha/it/watch/66348?e=372122');
      const post = await streamingCommunityExtractor.extract(url, mockCtx);

      expect(post).not.toBeNull();
      expect(post?.platform).toBe('streamingcommunity');
      expect(post?.title).toBe('Friends Sex and Games - S1E1 (Episodio 1)');
      expect(post?.items[0].durationSeconds).toBe(32 * 60);
      expect(post?.items[0].url).toBe(
        'https://vixcloud.co/playlist/794489?b=1&token=eptokenabc&expires=1797442000&h=1&scz=1&lang=it',
      );
      expect(post?.items[0].headers?.Referer).toBe('https://vixcloud.co/embed/794489');
    });

    it('returns null when VixCloud embed fails to provide tokens', async () => {
      const watchHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <div id="app" data-page='{"props":{"title":{"name":"Broken"},"embedUrl":"https://streamingcommunityz.shiksha/it/iframe/123"}}'></div>
        </body>
        </html>
      `;
      const iframeHtml = `<iframe src="https://vixcloud.co/embed/123"></iframe>`;
      const vixHtml = `<html><body>No playlist here</body></html>`;

      vi.spyOn(http, 'fetchText').mockImplementation(async (targetUrl) => {
        if (targetUrl.includes('/watch/')) return watchHtml;
        if (targetUrl.includes('/iframe/')) return iframeHtml;
        if (targetUrl.includes('vixcloud.co/embed/')) return vixHtml;
        throw new Error(`Unexpected fetch URL: ${targetUrl}`);
      });

      const url = new URL('https://streamingcommunityz.shiksha/it/watch/123');
      const post = await streamingCommunityExtractor.extract(url, mockCtx);
      expect(post).toBeNull();
    });
  });
});

