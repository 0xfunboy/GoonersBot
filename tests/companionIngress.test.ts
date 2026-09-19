import { describe, expect, it } from 'vitest';
import type { Update } from 'grammy/types';
import { ConversationExecutor, QueueCapacityError } from '../src/companion/ingress/executor.js';
import { DurableTelegramPoller } from '../src/companion/ingress/poller.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('companion Telegram ingress executor', () => {
  it('serializes one conversation while allowing another one to proceed', async () => {
    const executor = new ConversationExecutor(2, 8);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = executor.enqueue('chat:1', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = executor.enqueue('chat:1', async () => {
      events.push('second');
    });
    const other = executor.enqueue('chat:2', async () => {
      events.push('other');
    });

    await tick();
    expect(events).toEqual(['first:start', 'other']);
    releaseFirst();
    await Promise.all([first, second, other]);
    expect(events).toEqual(['first:start', 'other', 'first:end', 'second']);
  });

  it('rejects new work when the bounded queue is full', () => {
    const executor = new ConversationExecutor(1, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = executor.enqueue('chat:1', () => gate);
    expect(() => executor.enqueue('chat:2', async () => undefined)).toThrow(QueueCapacityError);
    release();
    return running;
  });

  it('never exceeds the configured concurrency during a burst', async () => {
    const executor = new ConversationExecutor(3, 32);
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const work = Array.from({ length: 20 }, (_, index) =>
      executor.enqueue(`chat:${index}`, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate;
        running -= 1;
      }),
    );

    await tick();
    expect(peak).toBe(3);
    expect(executor.activeCount).toBe(3);
    release();
    await Promise.all(work);
    expect(peak).toBe(3);
    expect(executor.activeCount).toBe(0);
  });

  it('does not advance the Telegram offset past an update that failed durable admission', async () => {
    const requests: Array<number | undefined> = [];
    const attempts: number[] = [];
    let fetchCount = 0;
    let failedOnce = false;
    let intakeAborted = false;
    let accepted = 0;
    let allAccepted!: () => void;
    const acceptedGate = new Promise<void>((resolve) => {
      allAccepted = resolve;
    });
    const updates = (ids: number[]): Update[] => ids.map((update_id) => ({ update_id }) as Update);

    const poller = new DurableTelegramPoller({
      retryMs: 1,
      fetchUpdates: async (request, signal) => {
        requests.push(request.offset);
        fetchCount += 1;
        if (fetchCount === 1) return updates([10, 11]);
        if (fetchCount === 2) return updates([11]);
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              intakeAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return [];
      },
      admit: async (update) => {
        attempts.push(update.update_id);
        if (update.update_id === 11 && !failedOnce) {
          failedOnce = true;
          throw new Error('mongo unavailable');
        }
      },
      onAdmitted: () => {
        accepted += 1;
        if (accepted === 2) allAccepted();
      },
    });

    poller.start();
    await acceptedGate;
    await poller.stop();

    expect(attempts).toEqual([10, 11, 11]);
    expect(requests.slice(0, 2)).toEqual([undefined, 11]);
    expect(intakeAborted).toBe(true);
  });
});
