import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/index.js';
import { Scheduler } from '../src/jobs/scheduler.js';
import type { LoreEngine } from '../src/memory/loreEngine.js';
import type { Storage } from '../src/storage/index.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Scheduler shutdown', () => {
  it('cancels the pending initial timeout before it can create an interval', async () => {
    vi.useFakeTimers();
    const archiveTick = vi.fn().mockResolvedValue(undefined);
    const config = {
      env: {
        MESSAGE_HISTORY_RETENTION_DAYS: 30,
        MEMORY_MINING_ENABLED: false,
        FEEDBACK_LEARNING_ENABLED: false,
      },
      auto: { autopostEnabled: false, generatedImageAutopostEnabled: false },
      anime: { follows: { enabled: false } },
      animeArchive: { enabled: true },
    } as AppConfig;
    const scheduler = new Scheduler(
      config,
      {} as Storage,
      {} as LoreEngine,
      undefined,
      undefined,
      undefined,
      () => [],
      undefined,
      undefined,
      archiveTick,
    );

    scheduler.start();
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(archiveTick).not.toHaveBeenCalled();
  });

  it('cancels the first timeout and interval and waits for an in-flight tick', async () => {
    vi.useFakeTimers();
    let finishTick: (() => void) | undefined;
    const archiveTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTick = resolve;
        }),
    );
    const config = {
      env: {
        MESSAGE_HISTORY_RETENTION_DAYS: 30,
        MEMORY_MINING_ENABLED: false,
        FEEDBACK_LEARNING_ENABLED: false,
      },
      auto: { autopostEnabled: false, generatedImageAutopostEnabled: false },
      anime: { follows: { enabled: false } },
      animeArchive: { enabled: true },
    } as AppConfig;
    const scheduler = new Scheduler(
      config,
      {} as Storage,
      {} as LoreEngine,
      undefined,
      undefined,
      undefined,
      () => [],
      undefined,
      undefined,
      archiveTick,
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(archiveTick).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishTick?.();
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(archiveTick).toHaveBeenCalledOnce();
  });
});
