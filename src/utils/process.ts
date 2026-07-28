import { spawn } from 'node:child_process';
import { redactSecrets } from './secrets.js';

export interface RunProcessOptions {
  timeoutMs: number;
  /** bytes written to the child's stdin (enables the stdin pipe) */
  input?: Buffer;
  /** capture stdout into a Buffer (otherwise stdout is ignored) */
  collectStdout?: boolean;
  /** Cooperative cancellation; the child is killed before the promise rejects. */
  signal?: AbortSignal;
}

export interface RunProcessResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * Single source of truth for spawning external binaries (ffmpeg, ffprobe, yt-dlp, whisper) with a
 * hard SIGKILL timeout. `args` are always passed as an array (no shell), so they are injection-safe.
 * Resolves with {code, stdout, stderr}; rejects only on spawn error or timeout.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts: RunProcessOptions,
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(
        opts.signal.reason instanceof Error ? opts.signal.reason : new Error('process aborted'),
      );
      return;
    }
    const child = spawn(bin, args, {
      stdio: [opts.input ? 'pipe' : 'ignore', opts.collectStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      child.kill('SIGKILL');
      rejectOnce(
        opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('process aborted'),
      );
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectOnce(new Error('process timed out'));
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      rejectOnce(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
    if (opts.input) {
      child.stdin?.on('error', () => undefined); // ignore EPIPE if the child exits early
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

/** Run a process and throw a redacted error on non-zero exit; returns the result on success. */
export async function runProcessChecked(
  bin: string,
  args: string[],
  opts: RunProcessOptions,
  label = 'process',
): Promise<RunProcessResult> {
  const r = await runProcess(bin, args, opts);
  if (r.code !== 0)
    throw new Error(`${label} exited ${r.code}: ${redactSecrets(r.stderr).slice(-400)}`);
  return r;
}
