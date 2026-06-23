import { describe, expect, it, vi } from 'vitest';
import { GroundingService } from '../src/search/groundingService.js';
import type { WebSearchProvider } from '../src/search/types.js';
import type { MediaProcessor } from '../src/providers/media/index.js';

function webStub(enabled: boolean, results = 2): WebSearchProvider {
  return {
    enabled,
    search: vi.fn().mockResolvedValue({
      query: 'q',
      results: Array.from({ length: results }, (_, i) => ({
        title: `t${i}`,
        url: `https://site${i}.com/p`,
        content: `snippet ${i}`,
      })),
      answer: 'instant answer',
    }),
  };
}

const mediaStub = (label: string | null): MediaProcessor =>
  ({ identifyImage: vi.fn().mockResolvedValue(label) }) as unknown as MediaProcessor;

const cfg = { webEnabled: true, imageEnabled: true, maxResults: 5 };

describe('GroundingService gating', () => {
  const g = new GroundingService(webStub(true), mediaStub('Naruto Uzumaki anime'), cfg);

  it('detects image/identity questions', () => {
    expect(g.wantsImageLookup('chi è questo personaggio?')).toBe(true);
    expect(g.wantsImageLookup('che prodotto è? dove lo compro')).toBe(true);
    expect(g.wantsImageLookup('who is this anime character')).toBe(true);
    expect(g.wantsImageLookup('bella giornata oggi')).toBe(false);
  });

  it('detects recency/factual questions', () => {
    expect(g.wantsWebSearch('chi ha vinto la partita ieri?')).toBe(true);
    expect(g.wantsWebSearch('quanto costa la rtx 5090?')).toBe(true);
    expect(g.wantsWebSearch('what is the latest news on x')).toBe(true);
    expect(g.wantsWebSearch('come stai stronzo')).toBe(false);
  });

  it('gating is off when the backend is disabled', () => {
    const off = new GroundingService(webStub(false), mediaStub('x'), cfg);
    expect(off.enabled).toBe(false);
    expect(off.wantsWebSearch('chi ha vinto ieri')).toBe(false);
  });
});

describe('GroundingService fetching', () => {
  it('grounds an image via vision identify + web search', async () => {
    const g = new GroundingService(webStub(true), mediaStub('Naruto Uzumaki anime'), cfg);
    const res = await g.groundImage({
      imageBuffer: Buffer.from('img'),
      imageMime: 'image/jpeg',
      question: 'chi è questo personaggio?',
      language: 'italian',
    });
    expect(res?.kind).toBe('image');
    expect(res?.block).toContain('best guess: Naruto Uzumaki anime');
    expect(res?.sources.length).toBeGreaterThan(0);
  });

  it('returns null image grounding when vision cannot identify', async () => {
    const g = new GroundingService(webStub(true), mediaStub(null), cfg);
    const res = await g.groundImage({
      imageBuffer: Buffer.from('img'),
      imageMime: 'image/jpeg',
      question: 'chi è?',
    });
    expect(res).toBeNull();
  });

  it('grounds a web query with a context block', async () => {
    const g = new GroundingService(webStub(true), mediaStub('x'), cfg);
    const res = await g.groundWeb('chi ha vinto euro 2024', 'italian');
    expect(res?.kind).toBe('web');
    expect(res?.block).toContain('WEB CONTEXT');
    expect(res?.block).toContain('instant answer');
    expect(res?.block).toContain('https://site0.com/p');
    expect(res?.block).toContain('include direct links');
  });

  it('finds a media URL through video search', async () => {
    const web = webStub(true);
    const g = new GroundingService(web, mediaStub('x'), cfg);
    const url = await g.findMediaUrl('funny gtav video', 'italian');
    expect(url).toBe('https://site0.com/p');
    expect(web.search).toHaveBeenCalledWith('funny gtav video', {
      language: 'italian',
      max: 5,
      categories: 'videos',
    });
  });
});
