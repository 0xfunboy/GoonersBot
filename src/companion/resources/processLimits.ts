import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { readHostPressure } from './host.js';

export interface ChildResourceLimits {
  maxRssBytes: number;
  maxCpuSeconds: number;
  maxFileBytes: number;
}

/** Limits are inherited by descendants; unlike RSS, Linux RLIMIT_AS is not a useful media budget. */
export function boundedChildCommand(
  bin: string,
  args: string[],
  limits: ChildResourceLimits,
): { bin: string; args: string[] } {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/prlimit')) return { bin, args };
  const bounded = {
    bin: '/usr/bin/prlimit',
    args: [
      `--cpu=${limits.maxCpuSeconds}`,
      `--fsize=${limits.maxFileBytes}`,
      '--core=0',
      '--nofile=1024',
      '--',
      bin,
      ...args,
    ],
  };
  if (existsSync('/usr/bin/setpriv'))
    return {
      bin: '/usr/bin/setpriv',
      args: ['--pdeathsig', 'KILL', '--', bounded.bin, ...bounded.args],
    };
  return bounded;
}

export function defaultChildLimits(timeoutMs: number): ChildResourceLimits {
  return {
    maxRssBytes: Math.max(
      256 * 1024 * 1024,
      Math.min(2 * 1024 ** 3, Math.floor(totalmem() * 0.15)),
    ),
    maxCpuSeconds: Math.min(600, Math.max(2, Math.ceil(timeoutMs / 1000) * 2)),
    maxFileBytes: 2 * 1024 ** 3,
  };
}

/** Snapshot the actual detached process group, so a decoder's child counts toward the same budget. */
export async function processGroupRssBytes(groupPid: number): Promise<number> {
  if (process.platform !== 'linux') return 0;
  const entries = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry)).slice(0, 32768);
  let bytes = 0;
  // Batches avoid opening every /proc file simultaneously on a busy workstation.
  for (let offset = 0; offset < entries.length; offset += 32) {
    const values = await Promise.all(
      entries.slice(offset, offset + 32).map(async (pid) => {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) !== groupPid) return 0;
        const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
        return Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
      }),
    );
    bytes += values.reduce((sum, value) => sum + value, 0);
  }
  return bytes;
}

export function watchChildResources(
  pid: number,
  limits: ChildResourceLimits,
  onViolation: (error: Error) => void,
): () => void {
  if (process.platform !== 'linux') return () => undefined;
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void Promise.all([processGroupRssBytes(pid), readHostPressure()])
      .then(([rss, pressure]) => {
        if (stopped) return;
        if (rss > limits.maxRssBytes)
          onViolation(new Error(`process group exceeded RSS budget (${limits.maxRssBytes} bytes)`));
        else if (pressure.diskAvailableBytes < 256 * 1024 * 1024)
          onViolation(new Error('process stopped to preserve disk reserve'));
        else if (pressure.availableBytes < 256 * 1024 * 1024)
          onViolation(new Error('process stopped under critical host memory pressure'));
      })
      .catch(() => {
        // A disappearing /proc process is expected; wall/CPU/file limits remain authoritative.
      })
      .finally(() => {
        running = false;
      });
  }, 1000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
