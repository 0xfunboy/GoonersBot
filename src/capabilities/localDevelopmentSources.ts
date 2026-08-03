import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  LOCAL_DEVELOPMENT_LIMITS,
  isSafeLocalDevelopmentPath,
  type LocalDevelopmentCandidateFile,
} from './localDevelopmentModel.js';

const MAX_SOURCE_BYTES = LOCAL_DEVELOPMENT_LIMITS.candidateFileChars;
const MAX_SEARCH_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_NEW_FILES = 2;

const PROTECTED_PATHS = new Set([
  'src/capabilities/forge.ts',
  'src/config/env.ts',
  'src/providers/socialClients/policy.ts',
  'src/services/access.ts',
  'src/services/permissions.ts',
  'src/telegram/handlers/commands/access.ts',
  'src/telegram/handlers/commands/capabilities.ts',
  'src/utils/secrets.ts',
]);

export interface LocalDevelopmentSourceSelection {
  paths: readonly string[];
  searchTerms: readonly string[];
  newPaths?: readonly string[];
}

/**
 * Read-only, no-shell source selector for local development jobs. Only regular tracked-style
 * TypeScript paths under src/tests are exposed to the model; the development control plane cannot
 * select or rewrite itself.
 */
export class LocalDevelopmentSources {
  private readonly root: string;

  constructor(repositoryPath: string) {
    this.root = resolve(repositoryPath);
  }

  /** Create an equally restricted reader rooted at a pinned detached worktree. */
  scoped(repositoryPath: string): LocalDevelopmentSources {
    return new LocalDevelopmentSources(repositoryPath);
  }

  async catalog(): Promise<string[]> {
    const paths: string[] = [];
    for (const base of ['src', 'tests'] as const) {
      await this.walk(join(this.root, base), paths);
    }
    return paths.sort((a, b) => a.localeCompare(b)).slice(0, LOCAL_DEVELOPMENT_LIMITS.catalogPaths);
  }

  async candidates(
    selection: LocalDevelopmentSourceSelection,
  ): Promise<LocalDevelopmentCandidateFile[]> {
    const catalog = await this.catalog();
    const available = new Set(catalog);
    const selected: string[] = [];
    for (const path of selection.paths) {
      if (!available.has(path)) throw new Error('development source selection is stale or unsafe');
      if (!selected.includes(path)) selected.push(path);
    }

    const terms = selection.searchTerms
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, LOCAL_DEVELOPMENT_LIMITS.searchTerms);
    if (terms.length > 0 && selected.length < LOCAL_DEVELOPMENT_LIMITS.candidateFiles) {
      let scannedBytes = 0;
      for (const path of catalog) {
        if (selected.includes(path) || scannedBytes >= MAX_SEARCH_SCAN_BYTES) continue;
        const source = await this.readRegular(path);
        scannedBytes += Buffer.byteLength(source);
        const normalized = source.toLowerCase();
        if (terms.some((term) => normalized.includes(term))) selected.push(path);
        if (selected.length >= LOCAL_DEVELOPMENT_LIMITS.candidateFiles - MAX_NEW_FILES) break;
      }
    }

    const newPaths = [...new Set(selection.newPaths ?? [])].slice(0, MAX_NEW_FILES);
    for (const path of newPaths) {
      if (!this.isSelectable(path) || available.has(path)) {
        throw new Error('new development source path is unsafe or already exists');
      }
    }

    const existing = await Promise.all(
      selected.slice(0, LOCAL_DEVELOPMENT_LIMITS.candidateFiles - newPaths.length).map(
        async (path): Promise<LocalDevelopmentCandidateFile> => ({
          path,
          kind: 'regular',
          content: await this.readRegular(path),
        }),
      ),
    );
    const created: LocalDevelopmentCandidateFile[] = newPaths.map((path) => ({
      path,
      kind: 'new',
      content: '',
    }));
    const candidates = [...existing, ...created];
    if (candidates.length === 0) throw new Error('development source selection is empty');
    return candidates;
  }

  private async walk(directory: string, paths: string[]): Promise<void> {
    if (paths.length >= LOCAL_DEVELOPMENT_LIMITS.catalogPaths) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (paths.length >= LOCAL_DEVELOPMENT_LIMITS.catalogPaths) break;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.walk(absolute, paths);
      } else if (entry.isFile()) {
        const path = relative(this.root, absolute).split(sep).join('/');
        if (this.isSelectable(path)) paths.push(path);
      }
    }
  }

  private isSelectable(path: string): boolean {
    if (!isSafeLocalDevelopmentPath(path) || PROTECTED_PATHS.has(path)) return false;
    return !/(?:^|\/)localDevelopment[^/]*\.ts$/i.test(path);
  }

  private async readRegular(path: string): Promise<string> {
    if (!this.isSelectable(path)) throw new Error('development source path is protected');
    const target = resolve(this.root, path);
    const rel = relative(this.root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
      throw new Error('development source path escapes the repository');
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
        throw new Error('development source is not a bounded regular file');
      }
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }
}
