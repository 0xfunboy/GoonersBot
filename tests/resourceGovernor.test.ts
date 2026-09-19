import { describe, expect, it } from 'vitest';
import { ResourceGovernor } from '../src/companion/resources/governor.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('ResourceGovernor', () => {
  it('reserves capacity for interactive work under background saturation', async () => {
    const governor = new ResourceGovernor({ concurrency: 2, interactiveReserve: 1, maxPending: 1 });
    const background = gate();
    const first = governor.run('media', undefined, () => background.promise);
    const blocked = governor.run('media', undefined, async () => 'second');
    expect(governor.snapshot).toMatchObject({ active: 1, queued: 1 });
    await expect(governor.run('interactive', undefined, async () => 'reply')).resolves.toBe(
      'reply',
    );
    expect(governor.snapshot).toMatchObject({ active: 1, queued: 1 });
    background.release();
    await first;
    await expect(blocked).resolves.toBe('second');
    expect(governor.snapshot.active).toBe(0);
  });

  it('rotates owners and removes cancelled waiters without running them', async () => {
    const governor = new ResourceGovernor({ concurrency: 2, interactiveReserve: 1 });
    const first = gate();
    const order: string[] = [];
    const running = governor.run('media', undefined, () => first.promise, { ownerKey: 'a' });
    const a = governor.run(
      'media',
      undefined,
      async () => {
        order.push('a');
      },
      { ownerKey: 'a' },
    );
    const b = governor.run(
      'media',
      undefined,
      async () => {
        order.push('b');
      },
      { ownerKey: 'b' },
    );
    const controller = new AbortController();
    const cancelled = governor.run('media', controller.signal, async () => {
      order.push('cancelled');
    });
    controller.abort(new Error('user cancelled'));
    await expect(cancelled).rejects.toThrow('user cancelled');
    first.release();
    await Promise.all([running, a, b]);
    expect(order).toEqual(['b', 'a']);
    expect(governor.snapshot.queued).toBe(0);
  });

  it('releases failed work, bounds the queue and closes queued admissions', async () => {
    const governor = new ResourceGovernor({ concurrency: 2, interactiveReserve: 1, maxPending: 1 });
    const held = gate();
    const running = governor.run('media', undefined, () => held.promise);
    const queued = governor.run('media', undefined, async () => 'never');
    await expect(governor.run('media', undefined, async () => 'overflow')).rejects.toThrow(
      'capacity',
    );
    governor.close();
    await expect(queued).rejects.toThrow('stopped');
    held.release();
    await running;
    expect(governor.snapshot).toMatchObject({ active: 0, queued: 0 });
    const open = new ResourceGovernor();
    await expect(
      open.run('network', undefined, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(open.snapshot.active).toBe(0);
  });
});
