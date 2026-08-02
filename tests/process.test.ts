import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '../src/utils/process.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('runProcess', () => {
  it('captures a normal child result', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('ok')"], {
      timeoutMs: 2_000,
      collectStdout: true,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe('ok');
  });

  it('kills the process group on timeout so grandchildren cannot outlive the job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goonerbot-process-'));
    roots.push(root);
    const marker = join(root, 'orphan-marker');
    const childScript = [
      "const {spawn}=require('node:child_process')",
      `spawn(process.execPath,['-e',${JSON.stringify(
        `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),600)`,
      )}],{stdio:'ignore'})`,
      'setInterval(()=>{},1000)',
    ].join(';');

    await expect(
      runProcess(process.execPath, ['-e', childScript], { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 750));
    await expect(access(marker)).rejects.toThrow();
  });

  it('kills a child when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow(/caller cancelled/);
  });
});
