import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cookieHeaderForUrl } from '../src/providers/media/linkMedia/cookies.js';

describe('link-media cookies', () => {
  it('sanitizes a raw Cookie header', async () => {
    await expect(
      cookieHeaderForUrl(
        ' session = abc ; bad\nname=x; theme=dark ',
        'https://instagram.com/reel/x',
      ),
    ).resolves.toBe('session=abc; theme=dark');
  });

  it('filters a shared Netscape jar by host, path, TLS and expiry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goonerbot-cookie-test-'));
    const jar = join(dir, 'cookies.txt');
    await writeFile(
      jar,
      [
        '# Netscape HTTP Cookie File',
        '.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tig-secret',
        '.facebook.com\tTRUE\t/\tTRUE\t0\tc_user\tfb-secret',
        'instagram.com\tFALSE\t/private\tTRUE\t0\tpath_cookie\tok',
        '.instagram.com\tTRUE\t/\tTRUE\t1\texpired\tno',
      ].join('\n'),
    );

    await expect(cookieHeaderForUrl(jar, 'https://www.instagram.com/reel/x')).resolves.toBe(
      'sessionid=ig-secret',
    );
    await expect(cookieHeaderForUrl(jar, 'https://facebook.com/reel/x')).resolves.toBe(
      'c_user=fb-secret',
    );
    await expect(
      cookieHeaderForUrl(jar, 'http://instagram.com/private/x'),
    ).resolves.toBeUndefined();
  });

  it('fails closed for a missing jar instead of sending its path as a cookie', async () => {
    await expect(
      cookieHeaderForUrl('/missing/link-media.cookies.txt', 'https://example.com/video'),
    ).resolves.toBeUndefined();
  });
});
