import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessOutputLimitError, runProcess } from '../src/utils/process.js';

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

  it('terminates a binary output flood instead of retaining unlimited buffers or truncating a file', async () => {
    await expect(
      runProcess(
        process.execPath,
        ['-e', 'setInterval(()=>process.stdout.write(Buffer.alloc(65536)),1)'],
        {
          timeoutMs: 2_000,
          collectStdout: true,
          maxStdoutBytes: 100_000,
        },
      ),
    ).rejects.toBeInstanceOf(ProcessOutputLimitError);
  });

  it('keeps a bounded diagnostic tail and reports truncation', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', "process.stderr.write('x'.repeat(100000)+'final diagnostic')"],
      {
        timeoutMs: 2_000,
        maxStderrBytes: 1_024,
      },
    );
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024);
    expect(result.stderr).toMatch(/final diagnostic$/);
    expect(result.stderrTruncated).toBe(true);
  });

  it('also stops endless diagnostics after the total output budget is consumed', async () => {
    await expect(
      runProcess(
        process.execPath,
        ['-e', 'setInterval(()=>process.stderr.write(Buffer.alloc(65536)),1)'],
        {
          timeoutMs: 2_000,
          maxOutputBytes: 100_000,
          maxStderrBytes: 1_024,
        },
      ),
    ).rejects.toThrow(/combined exceeded/);
  });
});
