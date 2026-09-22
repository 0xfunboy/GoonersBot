import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CivitaiEngine } from '../src/search/engines/civitai.js';
import { ArXivEngine } from '../src/search/engines/arxiv.js';
import { CryptoEngine } from '../src/search/engines/crypto.js';
import { NativeMetaSearch } from '../src/search/nativeMetaSearch.js';
import {
  cacheGeneratedImagePrompt,
  getCachedImagePrompt,
  nextArtisticMedium,
  buildImagePlaygroundRows,
} from '../src/services/imagePromptCache.js';
import { cacheCodeSnippet, getCachedCodeSnippet } from '../src/services/codeSnippetCache.js';
import { buildSocialContext, renderSocialContext } from '../src/social/context.js';
import type { MemberSocialProfile, ChatSocialState } from '../src/social/types.js';

describe('Next-Level GoonerBot Features', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Feature 4: Expanded Native MetaSearch Engines', () => {
    it('CivitaiEngine parses items, trigger words, and formats result', async () => {
      const mockResponse = {
        items: [
          {
            id: 12345,
            name: 'Cyberpunk LoRA',
            type: 'LORA',
            creator: { username: 'artist_neo' },
            description: '<p>A cool <b>cyberpunk</b> model</p>',
            stats: { downloadCount: 4500 },
            modelVersions: [{ name: 'v1.0', trainedWords: ['cyber_neon', 'glow_suit'] }],
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const engine = new CivitaiEngine({ enabled: true });
      const results = await engine.search('cyberpunk');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Civitai: Cyberpunk LoRA (LORA)');
      expect(results[0].url).toBe('https://civitai.com/models/12345');
      expect(results[0].content).toContain('[CIVITAI LORA]');
      expect(results[0].content).toContain('Triggers: cyber_neon, glow_suit');
    });

    it('ArXivEngine parses XML Atom feed and formats paper citations', async () => {
      const mockXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://arxiv.org/abs/2403.12345</id>
    <title>Attention Is Still What You Need</title>
    <summary>A comprehensive study on modern transformers.</summary>
    <published>2024-03-15T00:00:00Z</published>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
  </entry>
</feed>`;

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        text: async () => mockXml,
      } as any);

      const engine = new ArXivEngine({ enabled: true });
      const results = await engine.search('transformer');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('ArXiv: Attention Is Still What You Need');
      expect(results[0].url).toBe('https://arxiv.org/abs/2403.12345');
      expect(results[0].content).toContain('[ARXIV PAPER]');
      expect(results[0].content).toContain('Alice Smith, Bob Jones (2024)');
    });

    it('CryptoEngine parses spot tickers and formats 24h stats', async () => {
      const mockTicker = {
        symbol: 'BTCUSDT',
        lastPrice: '85200.50',
        priceChange: '3500.00',
        priceChangePercent: '4.28',
        highPrice: '86000.00',
        lowPrice: '81500.00',
        quoteVolume: '1000000',
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockTicker,
      } as any);

      const engine = new CryptoEngine({ enabled: true });
      const results = await engine.search('bitcoin');

      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('BTC/USDT');
      expect(results[0].content).toContain('[CRYPTO TICKER]');
      expect(results[0].content).toContain('spot price: $85,200.50');
      expect(results[0].content).toContain('+4.28%');
    });

    it('NativeMetaSearch routes queries to matching specialized engines', async () => {
      const civitaiMock = {
        id: 'civitai',
        name: 'Civitai',
        enabled: true,
        weight: 2,
        categories: ['it' as const, 'images' as const],
        search: vi.fn().mockResolvedValue([
          {
            title: 'Flux Dev LoRA',
            url: 'https://civitai.com/models/111',
            content: 'Flux model',
          },
        ]),
      };

      const meta = new NativeMetaSearch({
        enabled: true,
        engines: [civitaiMock as any],
      });

      const res = await meta.search('flux lora checkpoint');
      expect(res).not.toBeNull();
      expect(civitaiMock.search).toHaveBeenCalled();
      expect(res?.results[0].url).toBe('https://civitai.com/models/111');
    });
  });

  describe('Feature 2: Interactive AI Playground Keyboards & Cache', () => {
    it('caches generated image prompt and retrieves it', () => {
      const id = cacheGeneratedImagePrompt({
        prompt: 'a futuristic cyberpunk street',
        profile: 'art',
        aspectRatio: '16:9',
        medium: 'anime',
      });

      expect(id).toBeDefined();
      const cached = getCachedImagePrompt(id);
      expect(cached?.prompt).toBe('a futuristic cyberpunk street');
      expect(cached?.aspectRatio).toBe('16:9');
    });

    it('cycles artistic medium in correct order', () => {
      expect(nextArtisticMedium('anime')).toBe('photo');
      expect(nextArtisticMedium('photo')).toBe('digital_illustration');
      expect(nextArtisticMedium('oil_painting')).toBe('anime');
    });

    it('builds multi-row playground keyboard', () => {
      const rows = buildImagePlaygroundRows('test1234');
      expect(rows).toHaveLength(2);
      expect(rows[0][0].text).toContain('Altro Stile');
      expect(rows[0][0].callback_data).toBe('sample_style|test1234');
      expect(rows[0][1].text).toContain('Remix');
      expect(rows[1][0].text).toContain('16:9');
      expect(rows[1][0].callback_data).toBe('sample_ratio|16:9|test1234');
    });
  });

  describe('Feature 5: Code Snippet Cache & Peer Review', () => {
    it('caches snippet and retrieves it for quick diff patch generation', () => {
      const code = 'function add(a, b) { return a - b; }';
      const id = cacheCodeSnippet(code, 'wrong operator');
      const retrieved = getCachedCodeSnippet(id);
      expect(retrieved?.code).toBe(code);
      expect(retrieved?.context).toBe('wrong operator');
    });
  });

  describe('Feature 1: Social Proactivity & Alive Memory', () => {
    it('detects members returning after 3+ days and pending topics', () => {
      const now = new Date('2026-09-22T10:00:00Z');
      const fourDaysAgo = new Date('2026-09-18T08:00:00Z');

      const profiles: MemberSocialProfile[] = [
        {
          chatId: 1001,
          handle: 'marco',
          displayName: 'Marco',
          aliases: ['Mark'],
          firstSeenAt: new Date('2026-01-01T00:00:00Z'),
          lastSeenAt: fourDaysAgo,
          messageCount: 50,
          version: 1,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: fourDaysAgo,
          facets: [
            {
              kind: 'goal',
              key: 'esame_universita',
              value: 'dare analisi 1 giovedì',
              normalizedValue: 'dare analisi 1 giovedi',
              state: 'active',
              confidence: 0.9,
              salience: 0.8,
              source: 'self_declared',
              evidenceCount: 3,
              contradictionCount: 0,
              sourceMessageIds: [1],
              firstObservedAt: fourDaysAgo,
              lastObservedAt: fourDaysAgo,
              lastConfirmedAt: fourDaysAgo,
            },
          ],
        },
      ];

      const chatState: ChatSocialState = {
        chatId: 1001,
        relationships: [],
        runningJokes: [],
        norms: [],
        version: 1,
        updatedAt: now,
      };

      const ctx = buildSocialContext(profiles, chatState, { now });
      expect(ctx.members[0].daysInactive).toBeGreaterThanOrEqual(4);
      expect(ctx.members[0].pendingThread).toContain('esame_universita: dare analisi 1 giovedì');

      const rendered = renderSocialContext(ctx);
      expect(rendered).toContain('RETURNED after 4d absence');
      expect(rendered).toContain('PENDING TOPIC: esame_universita: dare analisi 1 giovedì');
      expect(rendered).toContain('SOCIAL RETURNS:');
    });
  });
});
