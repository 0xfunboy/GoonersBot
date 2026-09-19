import { describe, expect, it, vi } from 'vitest';
import {
  reviewPublicRepository,
  safeRepositoryPath,
  verifyRepositoryPatch,
} from '../src/companion/code/repositoryReview.js';

describe('public repository review and isolated patch artifacts', () => {
  it('pins public sources to an actual commit and returns a real apply-checked patch without running repository code', async () => {
    const original = 'export const add = (a, b) => a - b;\n';
    const sha = 'a'.repeat(40);
    const fetcher = vi.fn(
      async (url: string | URL, options: { validateUrl?: (url: URL) => unknown }) => {
        await options.validateUrl?.(new URL(url));
        const path = new URL(url).pathname;
        const value = path.endsWith('/commits/main')
          ? { sha }
          : path.endsWith('/contents/add.js')
            ? {
                type: 'file',
                encoding: 'base64',
                content: Buffer.from(original).toString('base64'),
              }
            : path.endsWith('/contents/')
              ? [{ path: 'add.js', type: 'file', size: Buffer.byteLength(original) }]
              : { private: false, default_branch: 'main' };
        return {
          buffer: Buffer.from(JSON.stringify(value)),
          status: 200,
          contentType: 'application/json',
          finalUrl: String(url),
          headers: new Headers(),
        };
      },
    );
    const result = await reviewPublicRepository(
      { url: 'https://github.com/example/project', request: 'Correggi addizione' },
      {
        fetch: fetcher,
        propose: async (files) => {
          expect(files[0]?.url).toBe(`https://github.com/example/project/blob/${sha}/add.js`);
          return {
            diagnosis: 'add subtracts instead of adding.',
            changes: [{ path: 'add.js', content: 'export const add = (a, b) => a + b;\n' }],
            suggestedTests: ['Assert add(2, 3) === 5'],
          };
        },
      },
    );
    expect(result.verification).toEqual({ applyCheck: true, testsRun: false });
    expect(result.patch?.buffer.toString()).toContain('-export const add = (a, b) => a - b;');
    expect(result.patch?.buffer.toString()).toContain('+export const add = (a, b) => a + b;');
    expect(result.summary).toContain('not executed');
    expect(
      fetcher.mock.calls.every(([url]) =>
        String(url).startsWith('https://api.github.com/repos/example/project'),
      ),
    ).toBe(true);
  });

  it('rejects arbitrary origins and uninspected/path-traversal changes before touching a checkout', async () => {
    const fetcher = vi.fn();
    await expect(
      reviewPublicRepository(
        { url: 'https://127.0.0.1/private', request: 'review' },
        { fetch: fetcher, propose: vi.fn() },
      ),
    ).rejects.toThrow('public');
    expect(fetcher).not.toHaveBeenCalled();
    expect(safeRepositoryPath('../secrets')).toBe(false);
    expect(safeRepositoryPath('.git/config')).toBe(false);
    expect(safeRepositoryPath('src/a.ts')).toBe(true);
    await expect(
      verifyRepositoryPatch([], [{ path: 'uninspected.ts', content: 'anything' }]),
    ).rejects.toThrow('uninspected');
  });
});
