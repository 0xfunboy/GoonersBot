import { spawn } from 'node:child_process';

export interface RunProcessOptions {
  timeoutMs: number;
  /** bytes written to the child's stdin (enables the stdin pipe) */
  input?: Buffer;
  /** capture stdout into a Buffer (otherwise stdout is ignored) */
  collectStdout?: boolean;
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
export function runProcess(bin: string, args: string[], opts: RunProcessOptions): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: [opts.input ? 'pipe' : 'ignore', opts.collectStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('process timed out'));
    }, opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
    if (opts.input) {
      child.stdin?.on('error', () => undefined); // ignore EPIPE if the child exits early
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

/** Redact cookie/token-like material before a child's stderr is logged or thrown. */
export function redactSecrets(s: string): string {
  return s
    .replace(/Cookie:\s*\S+/gi, 'Cookie:[redacted]')
    .replace(/(api[_-]?key|token|authorization|bearer)(["':=\s]+)[A-Za-z0-9._-]{8,}/gi, '$1$2[redacted]');
}

/** Run a process and throw a redacted error on non-zero exit; returns the result on success. */
export async function runProcessChecked(
  bin: string,
  args: string[],
  opts: RunProcessOptions,
  label = 'process',
): Promise<RunProcessResult> {
  const r = await runProcess(bin, args, opts);
  if (r.code !== 0) throw new Error(`${label} exited ${r.code}: ${redactSecrets(r.stderr).slice(-400)}`);
  return r;
}
