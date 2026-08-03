import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { LocalDevelopmentSources } from '../src/capabilities/localDevelopmentSources.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gooner-sources-'));
  roots.push(root);
  await mkdir(join(root, 'src/capabilities'), { recursive: true });
  await mkdir(join(root, 'src/services'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'src/services/example.ts'), 'export const mediaLimit = 300;\n');
  await writeFile(join(root, 'tests/example.test.ts'), 'const mediaLimit = 300;\n');
  await writeFile(join(root, 'src/capabilities/forge.ts'), 'protected\n');
  await writeFile(join(root, 'src/capabilities/localDevelopmentEvil.ts'), 'protected\n');
  return root;
}

describe('LocalDevelopmentSources', () => {
  it('catalogues only regular allowlisted TypeScript files and excludes its control plane', async () => {
    const root = await repository();
    await symlink('/etc/passwd', join(root, 'src/services/leak.ts'));
    const sources = new LocalDevelopmentSources(root);

    await expect(sources.catalog()).resolves.toEqual([
      'src/services/example.ts',
      'tests/example.test.ts',
    ]);
  });

  it('combines exact paths, fixed-string search matches and bounded new files', async () => {
    const root = await repository();
    const sources = new LocalDevelopmentSources(root);

    const candidates = await sources.candidates({
      paths: ['src/services/example.ts'],
      searchTerms: ['mediaLimit'],
      newPaths: ['tests/mediaLimit.test.ts'],
    });

    expect(candidates.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: 'src/services/example.ts', kind: 'regular' },
      { path: 'tests/example.test.ts', kind: 'regular' },
      { path: 'tests/mediaLimit.test.ts', kind: 'new' },
    ]);
  });

  it('rejects traversal, protected and colliding new paths', async () => {
    const root = await repository();
    const sources = new LocalDevelopmentSources(root);

    await expect(sources.candidates({ paths: ['../.env'], searchTerms: [] })).rejects.toThrow(
      /stale or unsafe/,
    );
    await expect(
      sources.candidates({
        paths: ['src/services/example.ts'],
        searchTerms: [],
        newPaths: ['src/capabilities/forge.ts'],
      }),
    ).rejects.toThrow(/unsafe or already exists/);
  });
});
