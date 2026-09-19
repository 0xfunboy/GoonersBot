import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, statfs } from 'node:fs/promises';
import { freemem, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ResourceKind } from './governor.js';

export interface HostPressure {
  availableBytes: number;
  totalBytes: number;
  diskAvailableBytes: number;
  memoryStallPercent: number;
}

export function pressureReason(value: HostPressure): 'memory_pressure' | 'disk_pressure' | null {
  if (
    value.availableBytes < Math.max(512 * 1024 * 1024, value.totalBytes * 0.06) ||
    value.memoryStallPercent >= 10
  )
    return 'memory_pressure';
  if (value.diskAvailableBytes < 512 * 1024 * 1024) return 'disk_pressure';
  return null;
}

export async function readHostPressure(): Promise<HostPressure> {
  const disk = await statfs(process.cwd());
  const tempDisk = await statfs(tmpdir());
  let availableBytes = freemem();
  let totalBytes = totalmem();
  let memoryStallPercent = 0;
  if (process.platform === 'linux') {
    const memory = await readFile('/proc/meminfo', 'utf8');
    availableBytes = Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]) * 1024 || availableBytes;
    totalBytes = Number(/^MemTotal:\s+(\d+)/m.exec(memory)?.[1]) * 1024 || totalBytes;
    const pressure = await readFile('/proc/pressure/memory', 'utf8').catch(() => '');
    memoryStallPercent = Number(/^full avg10=([\d.]+)/m.exec(pressure)?.[1] ?? 0);
  }
  return {
    availableBytes,
    totalBytes,
    diskAvailableBytes: Math.min(disk.bavail * disk.bsize, tempDisk.bavail * tempDisk.bsize),
    memoryStallPercent,
  };
}

const HOST_LIMITS: Partial<Record<ResourceKind, number>> = {
  media: 2,
  browser: 1,
  generation: 2,
  mining: 1,
  subprocess: 2,
};

/** Shared by bot/worker processes under the same UID. Interactive/network work never waits here. */
export class HostResourceCoordinator {
  private readonly directory: string;
  private prepared: Promise<void> | undefined;
  constructor(
    private readonly options: {
      directory?: string;
      limits?: Partial<Record<ResourceKind, number>>;
      pressure?: () => Promise<HostPressure>;
      pollMs?: number;
    } = {},
  ) {
    this.directory =
      options.directory ?? join(tmpdir(), `goonerbot-resources-${process.getuid?.() ?? 'user'}`);
  }

  async run<T>(
    resource: ResourceKind,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    maxWaitMs: number,
    onWait?: (reason: string) => void,
  ): Promise<T> {
    const limit = this.options.limits?.[resource] ?? HOST_LIMITS[resource];
    if (!limit) return operation();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
      throw new Error('Invalid host lane limit');
    const deadline = Date.now() + maxWaitMs;
    await (this.prepared ??= this.prepare());
    let notified: string | undefined;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const reason = pressureReason(await (this.options.pressure ?? readHostPressure)());
      if (!reason) {
        for (let index = 0; index < limit; index += 1) {
          const path = join(this.directory, `${resource}-${index}.json`);
          const release = await this.tryClaim(path);
          if (!release) continue;
          try {
            signal?.throwIfAborted();
            return await operation();
          } finally {
            await release();
          }
        }
      }
      const currentReason = reason ?? 'shared_concurrency';
      if (currentReason !== notified) {
        notified = currentReason;
        onWait?.(currentReason);
      }
      await delay(
        Math.min(this.options.pollMs ?? 500, Math.max(1, deadline - Date.now())),
        undefined,
        { signal },
      );
    }
    throw new Error(`Host resource admission timed out: ${notified ?? 'capacity'}`);
  }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    )
      throw new Error('Host lease directory must be private and owned by this user');
  }

  private async tryClaim(path: string): Promise<(() => Promise<void>) | null> {
    // Kernel advisory locks eliminate stale-file/reclaim ABA races. The tiny cat holder retains
    // the lock only while its stdin pipe is open; Node death closes the pipe and releases it.
    if (process.platform !== 'linux') return async () => undefined;
    if (!existsSync('/usr/bin/flock') || !existsSync('/bin/cat'))
      throw new Error('Linux host admission requires flock and cat');
    try {
      const file = await open(path, 'wx', 0o600);
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid host resource lock');
    return new Promise((resolve, reject) => {
      const child = spawn(
        '/usr/bin/flock',
        ['--no-fork', '--nonblock', '--conflict-exit-code', '75', path, '/bin/cat'],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );
      let settled = false;
      const closed = new Promise<void>((done) => {
        child.once('close', () => done());
      });
      const timer = setTimeout(() => {
        child.stdin.destroy();
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          reject(new Error('Host lock helper timed out'));
        }
      }, 2000);
      child.stdin.on('error', () => undefined);
      child.once('error', (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 75) resolve(null);
        else reject(new Error('Host lock helper exited before admission'));
      });
      child.stdout.once('data', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(async () => {
          child.stdin.end();
          await closed;
        });
      });
      child.stdin.write('admitted\n');
    });
  }
}

export const hostResourceCoordinator = new HostResourceCoordinator();
