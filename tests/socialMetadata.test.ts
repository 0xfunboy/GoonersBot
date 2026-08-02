import { describe, expect, it } from 'vitest';
import {
  buildSocialCaption,
  cleanSocialText,
  formatPostStats,
  mergePostStats,
} from '../src/providers/media/linkMedia/socialMetadata.js';

describe('deterministic social metadata captions', () => {
  it('keeps author and engagement visible when a description must be truncated', () => {
    const caption = buildSocialCaption({
      description: 'x'.repeat(2_000),
      author: 'Creator',
      authorHandle: '@creator',
      stats: { likes: 1200, reposts: 30, comments: 4, views: 5_600_000 },
    });

    expect(caption).toHaveLength(1000);
    expect(caption).toContain('…\n👤 Creator (social: creator)\n');
    expect(caption?.endsWith('❤ 1.2K  🔁 30  💬 4  👁 5.6M')).toBe(true);
  });

  it('labels external social handles without creating Telegram @mentions', () => {
    expect(buildSocialCaption({ authorHandle: '@external_user' })).toBe('👤 social: external_user');
    expect(
      buildSocialCaption({
        author: '@external_user',
        authorHandle: '@external_user',
      }),
    ).toBe('👤 social: external_user');
    expect(
      buildSocialCaption({
        author: 'Brand @official',
        authorHandle: 'person@social.example',
      }),
    ).toBe('👤 Brand ＠official (social: person＠social.example)');
  });

  it('renders zeroes, platform aliases and Reddit score without double-counting aliases', () => {
    expect(
      formatPostStats({
        likes: 0,
        reposts: 2,
        shares: 999,
        replies: 3,
        comments: 4,
        views: 5,
        score: 6,
      }),
    ).toBe('❤ 0  🔁 2  💬 4  👁 5  ⬆ 6');
  });

  it('lets native counts win while filling metrics absent from the native response', () => {
    expect(
      mergePostStats(
        { likes: 10, comments: 2 },
        { likes: 999, reposts: 3, comments: 999, views: 100 },
      ),
    ).toEqual({ likes: 10, reposts: 3, comments: 2, views: 100 });
  });

  it('removes control characters from untrusted post text', () => {
    expect(cleanSocialText('  hello\u0000\r\nworld\n\n\nnext  ')).toBe('hello\nworld\n\nnext');
  });
});
