import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimateMiningRequestTokens,
  MiningRequestPacer,
  MiningTokenBudgetExceededError,
} from '../src/providers/llm/miningPacer.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('MiningRequestPacer token budget', () => {
  it('conservatively includes message framing and an output reservation', () => {
    const withoutExplicitOutput = estimateMiningRequestTokens({
      system: 'system',
      messages: [{ role: 'user', content: 'a'.repeat(300) }],
    });
    const withExplicitOutput = estimateMiningRequestTokens({
      system: 'system',
      messages: [{ role: 'user', content: 'a'.repeat(300) }],
      maxTokens: 3_000,
    });

    expect(withoutExplicitOutput).toBeGreaterThan(2_048);
    expect(withExplicitOutput - withoutExplicitOutput).toBe(3_000 - 2_048);
  });

  it('delays starts until the sliding token window has enough capacity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const epoch = Date.now();
    const starts: number[] = [];
    const pacer = new MiningRequestPacer({
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 100,
    });
    const run = (estimatedTokens: number) =>
      pacer.run(
        async () => {
          starts.push(Date.now() - epoch);
        },
        { estimatedTokens },
      );
    const pending = [run(60), run(40), run(40)];

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(starts).toEqual([0, 20_000]);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(starts).toEqual([0, 20_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 20_000, 60_000]);
    await expect(Promise.all(pending)).resolves.toHaveLength(3);
  });

  it('rejects an impossible request before dispatch instead of waiting forever', async () => {
    const dispatch = vi.fn(async () => undefined);
    const pacer = new MiningRequestPacer({
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 100,
    });

    await expect(pacer.run(dispatch, { estimatedTokens: 101 })).rejects.toBeInstanceOf(
      MiningTokenBudgetExceededError,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('honours abort signals while waiting for token capacity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const pacer = new MiningRequestPacer({
      maxRequestsPerMinute: 3,
      maxTokensPerMinute: 100,
    });
    await pacer.run(async () => undefined, { estimatedTokens: 100 });

    const controller = new AbortController();
    const waiting = pacer.run(async () => undefined, {
      estimatedTokens: 1,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error('stop mining'));

    await expect(waiting).rejects.toThrow('stop mining');
  });
});
