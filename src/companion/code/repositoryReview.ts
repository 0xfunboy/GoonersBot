import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createAbortScope } from '../../utils/abort.js';
import { runProcess } from '../../utils/process.js';
import { fetchSafeRemoteBuffer } from '../../utils/safeRemoteFetch.js';
import { containsSensitive } from '../../utils/secrets.js';

export const repositoryProposalSchema = z
  .object({
    diagnosis: z.string().min(1).max(12_000),
    changes: z
      .array(z.object({ path: z.string().max(240), content: z.string().max(80_000) }).strict())
      .max(5),
    suggestedTests: z.array(z.string().max(500)).max(10),
  })
  .strict();
export type RepositoryProposal = z.infer<typeof repositoryProposalSchema>;
export interface PublicRepositoryFile {
  path: string;
  content: string;
  sha256: string;
  url: string;
}
export interface RepositoryReviewDependencies {
  /** Repository text is untrusted data, never authority to call tools or run instructions. */
  propose(
    files: PublicRepositoryFile[],
    request: string,
    signal: AbortSignal,
  ): Promise<RepositoryProposal | null>;
  fetch?: typeof fetchSafeRemoteBuffer;
}
export interface RepositoryReviewResult {
  summary: string;
  files: Array<Omit<PublicRepositoryFile, 'content'>>;
  sources: string[];
  patch?: { buffer: Buffer; mime: 'text/x-diff'; name: 'proposta.patch' };
  verification: { applyCheck: boolean; testsRun: false };
  limits: string[];
}

const entrySchema = z.object({ type: z.string(), path: z.string(), size: z.number().optional() });
const MAX_FILES = 20;
// Deliberately below the 1 MiB hard requirement: the same bounded source set enters the model.
const MAX_SOURCE_BYTES = 96 * 1024;
const MAX_FILE_BYTES = 48 * 1024;
const MAX_REQUESTS = 32;

export function safeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    value.split('/').every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(part)) &&
    !value
      .split('/')
      .some((part) => ['node_modules', 'vendor', 'dist', 'build', '__pycache__'].includes(part))
  );
}

/** Public source only. No cloning, credentials, package installation or repository code execution. */
export async function reviewPublicRepository(
  input: { url: string; request: string },
  dependencies: RepositoryReviewDependencies,
  signal?: AbortSignal,
): Promise<RepositoryReviewResult> {
  const url = new URL(input.url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error('A public https://github.com/owner/repository URL is required');
  const segments = url.pathname.replace(/\/$/u, '').split('/').filter(Boolean);
  if (
    segments.length !== 2 ||
    !segments.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part)) ||
    segments.some((part) => part === '.' || part === '..')
  )
    throw new Error('Use the repository root URL, not a branch or arbitrary path');
  if (!input.request.trim() || input.request.length > 4_000)
    throw new Error('Invalid repository review request');
  const owner = segments[0]!;
  const repository = segments[1]!.replace(/\.git$/u, '');
  const base = `https://api.github.com/repos/${owner}/${repository}`;
  const canonical = `https://github.com/${owner}/${repository}`;
  const scope = createAbortScope(120_000, signal, 'public repository review');
  let requests = 0;
  let wireBytes = 0;
  const fetcher = dependencies.fetch ?? fetchSafeRemoteBuffer;
  const json = async (endpoint: string): Promise<unknown> => {
    scope.signal.throwIfAborted();
    if (++requests > MAX_REQUESTS) throw new Error('Repository request budget exceeded');
    const response = await fetcher(`${base}${endpoint}`, {
      timeoutMs: 12_000,
      maxBytes: Math.min(256 * 1024, 2 * 1024 * 1024 - wireBytes),
      signal: scope.signal,
      maxRedirects: 0,
      allowedContentTypes: ['application/json'],
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'GoonersBot-public-source-review',
      },
      validateUrl: (candidate) => {
        if (
          candidate.origin !== 'https://api.github.com' ||
          (!candidate.pathname.startsWith(`/repos/${owner}/${repository}/`) &&
            candidate.pathname !== `/repos/${owner}/${repository}`)
        )
          throw new Error('Repository API request escaped its scope');
      },
    });
    wireBytes += response.buffer.length;
    if (wireBytes >= 2 * 1024 * 1024) throw new Error('Repository response budget exceeded');
    return JSON.parse(response.buffer.toString('utf8'));
  };
  try {
    const info = z
      .object({ private: z.boolean(), default_branch: z.string().min(1).max(250) })
      .parse(await json(''));
    if (info.private) throw new Error('Only public repositories are supported');
    const commit = z
      .object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) })
      .parse(await json(`/commits/${encodeURIComponent(info.default_branch)}`));
    const queue = [''];
    const files: PublicRepositoryFile[] = [];
    const limits = [
      'Bounded static review, not a full-repository audit. No repository code, dependency installer or test script was executed.',
    ];
    let sourceBytes = 0;
    const visited = new Set<string>();
    while (queue.length && files.length < MAX_FILES && requests < MAX_REQUESTS - 1) {
      const directory = queue.shift()!;
      if (visited.has(directory)) continue;
      visited.add(directory);
      const entries = z
        .array(entrySchema)
        .max(1_000)
        .parse(await json(`/contents/${directory}?ref=${commit.sha}`));
      const ordered = entries.sort(
        (a, b) => scorePath(b.path, input.request) - scorePath(a.path, input.request),
      );
      for (const entry of ordered) {
        if (
          !safeRepositoryPath(entry.path) ||
          path.posix.dirname(entry.path) !== (directory || '.')
        )
          continue;
        if (entry.type === 'dir' && entry.path.split('/').length < 4 && queue.length < 20) {
          queue.push(entry.path);
          continue;
        }
        if (
          entry.type !== 'file' ||
          !/\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|php|html|css|json|md|ya?ml)$/iu.test(entry.path) ||
          /(?:lock|\.min\.)/iu.test(entry.path) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size! > MAX_FILE_BYTES
        )
          continue;
        if (
          files.length >= MAX_FILES ||
          requests >= MAX_REQUESTS - 1 ||
          sourceBytes + entry.size! > MAX_SOURCE_BYTES
        )
          continue;
        const file = z
          .object({
            type: z.literal('file'),
            encoding: z.literal('base64'),
            content: z.string().max(MAX_FILE_BYTES * 2),
          })
          .parse(await json(`/contents/${entry.path}?ref=${commit.sha}`));
        const bytes = Buffer.from(file.content.replace(/\s/gu, ''), 'base64');
        if (bytes.length !== entry.size || bytes.length > MAX_FILE_BYTES || bytes.includes(0))
          continue;
        const content = bytes.toString('utf8');
        if (containsSensitive(content)) {
          limits.push(`Skipped sensitive-looking source: ${entry.path}`);
          continue;
        }
        files.push({
          path: entry.path,
          content,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          url: `${canonical}/blob/${commit.sha}/${entry.path}`,
        });
        sourceBytes += bytes.length;
      }
    }
    if (!files.length)
      throw new Error('No supported source files within the public repository review budget');
    if (queue.length || files.length === MAX_FILES || requests >= MAX_REQUESTS - 1)
      limits.push(
        'The repository exceeds the selected file/depth/request budget; uninspected files are outside this review.',
      );
    const proposed = await dependencies.propose(files, input.request, scope.signal);
    scope.signal.throwIfAborted();
    if (!proposed) throw new Error('The source reviewer did not produce a valid proposal');
    const proposal = repositoryProposalSchema.parse(proposed);
    const patch = proposal.changes.length
      ? await verifyRepositoryPatch(files, proposal.changes, scope.signal)
      : undefined;
    const summary = [
      proposal.diagnosis,
      `Inspected ${files.length} files at commit ${commit.sha}.`,
      proposal.suggestedTests.length
        ? `Suggested checks (not executed):\n${proposal.suggestedTests.join('\n')}`
        : '',
      patch
        ? 'The supplied patch passes git apply --check against the inspected snapshot. This does not establish functional correctness.'
        : 'No patch was produced.',
      ...limits,
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      summary,
      files: files.map(({ content: _content, ...metadata }) => metadata),
      sources: files.map((file) => file.url),
      ...(patch
        ? {
            patch: { buffer: patch, mime: 'text/x-diff' as const, name: 'proposta.patch' as const },
          }
        : {}),
      verification: { applyCheck: Boolean(patch), testsRun: false },
      limits,
    };
  } finally {
    scope.dispose();
  }
}

function scorePath(filePath: string, request: string): number {
  const value = filePath.toLowerCase();
  const tokens = request.toLowerCase().match(/[a-z0-9_]{3,}/gu) ?? [];
  return (
    tokens.filter((token) => value.includes(token)).length * 10 +
    (/^(?:src|lib|app|test)/u.test(value) ? 3 : 0) +
    (/^(?:package\.json|readme\.md)$/u.test(value) ? 2 : 0)
  );
}

/** Git parses a locally produced diff; it never runs code supplied by the repository or model. */
export async function verifyRepositoryPatch(
  files: PublicRepositoryFile[],
  changes: RepositoryProposal['changes'],
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  if (!changes.length) return undefined;
  const originals = new Map(files.map((file) => [file.path, file.content]));
  if (changes.length > 5 || new Set(changes.map((change) => change.path)).size !== changes.length)
    throw new Error('Duplicate or excessive patch paths');
  for (const change of changes) {
    if (
      !safeRepositoryPath(change.path) ||
      !originals.has(change.path) ||
      Buffer.byteLength(change.content) > MAX_FILE_BYTES ||
      containsSensitive(change.content)
    )
      throw new Error('Patch modifies an uninspected/unsafe path or exceeds its content budget');
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'goonerbot-review-'));
  const git = async (args: string[], input?: Buffer): Promise<Buffer> => {
    const result = await runProcess(
      'git',
      [
        '-C',
        temporary,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      {
        timeoutMs: 10_000,
        collectStdout: true,
        input,
        signal,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: 8 * 1024,
        maxOutputBytes: 1024 * 1024,
      },
    );
    if (result.code !== 0)
      throw new Error('Patch verification failed in the isolated source snapshot');
    return result.stdout;
  };
  try {
    await git(['init', '--quiet', '--template=']);
    for (const change of changes) {
      const destination = path.join(temporary, change.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, originals.get(change.path)!, { mode: 0o600, flag: 'wx' });
    }
    await git(['add', '--', ...changes.map((change) => change.path)]);
    for (const change of changes)
      await writeFile(path.join(temporary, change.path), change.content);
    const diff = await git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--',
      ...changes.map((change) => change.path),
    ]);
    if (!diff.length) return undefined;
    for (const change of changes)
      await writeFile(path.join(temporary, change.path), originals.get(change.path)!);
    await git(['apply', '--check', '--whitespace=nowarn', '-'], diff);
    return diff;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
