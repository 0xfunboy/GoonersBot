import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HostResourceCoordinator,
  pressureReason,
  type HostPressure,
} from '../src/companion/resources/host.js';
import { boundedChildCommand } from '../src/companion/resources/processLimits.js';
import { runProcess } from '../src/utils/process.js';

const roots: string[] = [];
const healthy: HostPressure = {
  availableBytes: 4 * 1024 ** 3,
  totalBytes: 8 * 1024 ** 3,
  diskAvailableBytes: 10 * 1024 ** 3,
  memoryStallPercent: 0,
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Host resource budget', () => {
  it('uses available memory and stall pressure, not misleading free-memory percentages', () => {
    expect(pressureReason(healthy)).toBeNull();
    expect(pressureReason({ ...healthy, availableBytes: 250 * 1024 ** 2 })).toBe('memory_pressure');
    expect(pressureReason({ ...healthy, memoryStallPercent: 15 })).toBe('memory_pressure');
    expect(pressureReason({ ...healthy, diskAvailableBytes: 100 * 1024 ** 2 })).toBe(
      'disk_pressure',
    );
  });

  it('shares bounded lane leases between independent coordinator instances and releases on failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gooner-host-budget-'));
    roots.push(directory);
    const options = {
      directory,
      limits: { subprocess: 1 },
      pressure: async () => healthy,
      pollMs: 5,
    };
    const first = new HostResourceCoordinator(options);
    const second = new HostResourceCoordinator(options);
    let unblock!: () => void;
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const pending = first.run(
      'subprocess',
      undefined,
      async () => {
        started();
        await blocker;
      },
      500,
    );
    await admitted;
    await expect(
      second.run('subprocess', undefined, async () => 'must not run', 25),
    ).rejects.toThrow('shared_concurrency');
    unblock();
    await pending;
    await expect(
      second.run(
        'subprocess',
        undefined,
        async () => {
          throw new Error('job failed');
        },
        500,
      ),
    ).rejects.toThrow('job failed');
    await expect(first.run('subprocess', undefined, async () => 'recovered', 500)).resolves.toBe(
      'recovered',
    );
  });

  it('blocks heavy work under memory pressure while preserving interactive responses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gooner-host-pressure-'));
    roots.push(directory);
    const host = new HostResourceCoordinator({
      directory,
      pressure: async () => ({ ...healthy, memoryStallPercent: 20 }),
      pollMs: 5,
    });
    await expect(host.run('media', undefined, async () => 'never', 20)).rejects.toThrow(
      'memory_pressure',
    );
    await expect(
      host.run('interactive', undefined, async () => 'still responsive', 20),
    ).resolves.toBe('still responsive');
  });

  it('enforces a tiny kernel file-size ceiling without stress or large allocations', async () => {
    const command = boundedChildCommand('test-bin', ['literal;argument'], {
      maxCpuSeconds: 2,
      maxFileBytes: 1024,
      maxRssBytes: 1024 ** 3,
    });
    expect(command.args).toContain('literal;argument');
    if (process.platform !== 'linux' || command.bin === 'test-bin') return;
    const directory = await mkdtemp(join(tmpdir(), 'gooner-file-limit-'));
    roots.push(directory);
    const path = join(directory, 'bounded-output');
    const result = await runProcess(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path)},Buffer.alloc(8192))`],
      { timeoutMs: 2000, maxFileBytes: 1024 },
    );
    expect(result.code).not.toBe(0);
    expect((await readFile(path)).length).toBeLessThanOrEqual(1024);
  });
});
