import { describe, expect, it, vi } from 'vitest';
import {
  reconcileExtractedClaims,
  runBoundedResearch,
  type ResearchEvidence,
} from '../src/search/research.js';

const evidence = (id: string, url: string, excerpt: string): ResearchEvidence => ({
  id,
  url,
  excerpt,
  title: 'Observed source',
  observedAt: '2026-09-19T12:00:00Z',
  extractedTextSha256: 'a'.repeat(64),
});

describe('bounded research evidence', () => {
  it('caps searches and opened pages, dates/hashes actual content, and follows safe redirect identity', async () => {
    const search = vi.fn(async (query: string) => ({
      query,
      results: Array.from({ length: 8 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.org/${index}`,
        content: 'An unverified search snippet.',
      })),
    }));
    const read = vi.fn(async (urls: string[]) =>
      urls.map((url) => ({
        url: `${url}/`,
        requestedUrl: url,
        title: 'Actual page',
        text: 'The source publishes a verified observation at the requested URL.',
        facts: [],
        outboundLinks: [],
      })),
    );
    const result = await runBoundedResearch('compare alternatives', { search, read });
    expect(search).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toHaveLength(4);
    expect(result?.evidence).toHaveLength(4);
    expect(result?.evidence[0]).toMatchObject({
      url: 'https://example.org/0/',
      extractedTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result?.claims.every((claim) => claim.status !== 'unverified')).toBe(true);
    expect(result?.claims.length).toBeLessThanOrEqual(12);
  });

  it('distinguishes source statements, independent corroboration, numeric disagreements and snippets', () => {
    const claims = reconcileExtractedClaims(
      [
        evidence('a', 'https://one.example/a', 'The monthly subscription costs 25 euros per user.'),
        evidence('b', 'https://two.example/b', 'The monthly subscription costs 35 euros per user.'),
        evidence(
          'c',
          'https://three.example/c',
          'The service publishes its complete documentation online.',
        ),
        evidence(
          'd',
          'https://four.example/d',
          'The service publishes its complete documentation online.',
        ),
      ],
      [{ text: 'Unopened claims remain only a search result.', url: 'https://unopened.example/' }],
    );
    expect(claims.slice(0, 2).map((claim) => claim.status)).toEqual(['disputed', 'disputed']);
    expect(claims[2]).toMatchObject({ status: 'corroborated', evidenceIds: ['c', 'd'] });
    expect(claims[3]).toMatchObject({ status: 'unverified', evidenceIds: [] });
  });

  it('does not present snippets as pages when the reader is unavailable', async () => {
    const result = await runBoundedResearch('current price', {
      search: async (query) => ({
        query,
        results: [
          {
            title: 'Price',
            url: 'https://store.example/',
            content: 'The listed current price is 100 euros.',
          },
        ],
      }),
      read: async () => [],
    });
    expect(result?.evidence).toEqual([]);
    expect(result?.sources).toEqual([]);
    expect(result?.claims.every((claim) => claim.status === 'unverified')).toBe(true);
    expect(result?.block).toContain('unverified');
  });
});
