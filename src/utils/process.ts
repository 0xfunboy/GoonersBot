import { spawn } from 'node:child_process';
import { redactSecrets } from './secrets.js';
import { resourceGovernor, type ResourcePriority } from '../companion/resources/governor.js';
import {
  boundedChildCommand,
  defaultChildLimits,
  watchChildResources,
} from '../companion/resources/processLimits.js';

export interface RunProcessOptions {
  timeoutMs: number;
  /** bytes written to the child's stdin (enables the stdin pipe) */
  input?: Buffer;
  /** capture stdout into a Buffer (otherwise stdout is ignored) */
  collectStdout?: boolean;
  /** Cooperative cancellation; the child is killed before the promise rejects. */
  signal?: AbortSignal;
  /** Captured binary output is never silently truncated. Crossing this ceiling terminates the job. */
  maxStdoutBytes?: number;
  /** Diagnostic tail only; older stderr is discarded once this ceiling is reached. */
  maxStderrBytes?: number;
  /** Also stop a noisy process that keeps flooding discarded diagnostic output. */
  maxOutputBytes?: number;
  ownerKey?: string;
  priority?: ResourcePriority;
  /** Actual process-group RSS watchdog, including decoder/downloader descendants. */
  maxRssBytes?: number;
  /** Linux hard inherited RLIMIT_CPU and RLIMIT_FSIZE, enforced independently of Node. */
  maxCpuSeconds?: number;
  maxFileBytes?: number;
}

export interface RunProcessResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  stderrTruncated?: boolean;
}

export class ProcessOutputLimitError extends Error {
  constructor(
    readonly stream: 'stdout' | 'combined',
    readonly limitBytes: number,
  ) {
    super(`process ${stream} exceeded ${limitBytes} bytes`);
    this.name = 'ProcessOutputLimitError';
  }
}

/**
 * Single source of truth for spawning external binaries (ffmpeg, ffprobe, yt-dlp, whisper) with a
 * hard SIGKILL timeout. `args` are always passed as an array (no shell), so they are injection-safe.
 * Resolves with {code, stdout, stderr}; rejects only on spawn error or timeout.
 */
export async function runProcess(
  bin: string,
  args: string[],
  opts: RunProcessOptions,
): Promise<RunProcessResult> {
  const maxStdoutBytes = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
  const maxStderrBytes = opts.maxStderrBytes ?? 256 * 1024;
  const maxOutputBytes = opts.maxOutputBytes ?? 256 * 1024 * 1024;
  if (
    !Number.isFinite(opts.timeoutMs) ||
    opts.timeoutMs <= 0 ||
    [
      maxStdoutBytes,
      maxStderrBytes,
      maxOutputBytes,
      ...(opts.maxRssBytes !== undefined ? [opts.maxRssBytes] : []),
      ...(opts.maxCpuSeconds !== undefined ? [opts.maxCpuSeconds] : []),
      ...(opts.maxFileBytes !== undefined ? [opts.maxFileBytes] : []),
    ].some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError('process limits must be positive finite values');
  }
  const startedAt = Date.now();
  return resourceGovernor.run(
    'subprocess',
    opts.signal,
    () =>
      runAdmittedProcess(
        bin,
        args,
        {
          ...opts,
          timeoutMs: Math.max(1, opts.timeoutMs - (Date.now() - startedAt)),
        },
        { maxStdoutBytes, maxStderrBytes, maxOutputBytes },
      ),
    {
      ownerKey: opts.ownerKey,
      priority: opts.priority,
      maxWaitMs: opts.timeoutMs,
    },
  );
}

function runAdmittedProcess(
  bin: string,
  args: string[],
  opts: RunProcessOptions,
  limits: { maxStdoutBytes: number; maxStderrBytes: number; maxOutputBytes: number },
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(
        opts.signal.reason instanceof Error ? opts.signal.reason : new Error('process aborted'),
      );
      return;
    }
    const detached = process.platform !== 'win32';
    const defaults = defaultChildLimits(opts.timeoutMs);
    const resourceLimits = {
      maxRssBytes: opts.maxRssBytes ?? defaults.maxRssBytes,
      maxCpuSeconds: opts.maxCpuSeconds ?? defaults.maxCpuSeconds,
      maxFileBytes: opts.maxFileBytes ?? defaults.maxFileBytes,
    };
    const command = boundedChildCommand(bin, args, resourceLimits);
    const child = spawn(command.bin, command.args, {
      stdio: [opts.input ? 'pipe' : 'ignore', opts.collectStdout ? 'pipe' : 'ignore', 'pipe'],
      detached,
    });
    const killTree = (): void => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // The process may have exited between the timeout/abort and this signal.
        }
      }
      child.kill('SIGKILL');
    };
    const out: Buffer[] = [];
    let err = Buffer.alloc(0);
    let stdoutBytes = 0;
    let outputBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let stopWatchdog = (): void => undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      stopWatchdog();
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      killTree();
      rejectOnce(
        opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('process aborted'),
      );
    };
    const timer = setTimeout(() => {
      killTree();
      rejectOnce(new Error('process timed out'));
    }, opts.timeoutMs);
    if (child.pid !== undefined)
      stopWatchdog = watchChildResources(child.pid, resourceLimits, (error) => {
        killTree();
        rejectOnce(error);
      });
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const countOutput = (bytes: number): boolean => {
      outputBytes += bytes;
      if (outputBytes <= limits.maxOutputBytes) return true;
      killTree();
      rejectOnce(new ProcessOutputLimitError('combined', limits.maxOutputBytes));
      return false;
    };
    child.stdout?.on('data', (d: Buffer) => {
      if (settled || !countOutput(d.length)) return;
      stdoutBytes += d.length;
      if (stdoutBytes > limits.maxStdoutBytes) {
        killTree();
        rejectOnce(new ProcessOutputLimitError('stdout', limits.maxStdoutBytes));
        return;
      }
      out.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (settled || !countOutput(d.length)) return;
      stderrTruncated ||= err.length + d.length > limits.maxStderrBytes;
      // Copy a bounded tail; a Buffer.subarray alone would retain an oversized backing allocation.
      const tail = d.subarray(Math.max(0, d.length - limits.maxStderrBytes));
      const oldTail = err.subarray(Math.max(0, err.length + tail.length - limits.maxStderrBytes));
      err = Buffer.concat([oldTail, tail]);
    });
    child.on('error', (e) => {
      rejectOnce(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout: Buffer.concat(out), stderr: err.toString(), stderrTruncated });
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
