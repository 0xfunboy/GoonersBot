import { describe, expect, it } from 'vitest';
import { ConversationExecutor, QueueCapacityError } from '../src/companion/ingress/executor.js';

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
});
