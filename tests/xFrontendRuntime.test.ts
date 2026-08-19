import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  XFrontendOperationTimeoutError,
  X_FRONTEND_MEDIA_GUARD_SCRIPT,
  calculateBrowserTreeCpuPercent,
  createBrowserResourceGuardState,
  evaluateBrowserResourceSample,
  parseLinuxProcStat,
  parseLinuxSmapsRollupPss,
  parseLinuxSystemCpuTicks,
  profileBrowserTreePids,
  statMatchesLinuxProcessIdentity,
  withHardTimeout,
  type BrowserTreeResourceSample,
} from '../src/frontend/x/runtime.js';

afterEach(() => {
  vi.useRealTimers();
});

function sample(
  options: {
    rootCount?: number;
    memoryBytes?: number;
    systemCpuTicks?: number;
    processCpuTicks?: ReadonlyMap<string, number>;
  } = {},
): BrowserTreeResourceSample {
  return {
    rootCount: options.rootCount ?? 1,
    processCount: options.rootCount === 0 ? 0 : 3,
    memoryBytes: options.memoryBytes ?? 50,
    memoryMeasurement: 'pss',
    systemCpuTicks: options.systemCpuTicks ?? 1_000,
    processCpuTicks: options.processCpuTicks ?? new Map([['10:500', 100]]),
  };
}

const evaluationOptions = {
  nowMs: 1_000,
  maxMemoryBytes: 100,
  maxCpuPercent: 100,
  logicalCpuCount: 4,
};

describe('X Firefox resource lifecycle', () => {
  it('fails closed when the exact profile root stays absent beyond startup grace', () => {
    const state = createBrowserResourceGuardState(1_000);
    const duringGrace = evaluateBrowserResourceSample(state, sample({ rootCount: 0 }), {
      ...evaluationOptions,
      nowMs: state.rootGraceDeadlineMs - 1,
    });
    expect(duringGrace.failure).toBeUndefined();

    const afterGrace = evaluateBrowserResourceSample(duringGrace.state, sample({ rootCount: 0 }), {
      ...evaluationOptions,
      nowMs: state.rootGraceDeadlineMs,
    });
    expect(afterGrace.failure).toMatch(/process tree disappeared/);
  });

  it('requires consecutive proportional-memory breaches but recycles an emergency spike', () => {
    const initial = createBrowserResourceGuardState(0);
    const first = evaluateBrowserResourceSample(initial, sample({ memoryBytes: 150 }), {
      ...evaluationOptions,
      nowMs: 20_000,
    });
    expect(first.failure).toBeUndefined();
    expect(first.state.memoryBreachSamples).toBe(1);

    const recovered = evaluateBrowserResourceSample(first.state, sample({ memoryBytes: 90 }), {
      ...evaluationOptions,
      nowMs: 25_000,
    });
    expect(recovered.state.memoryBreachSamples).toBe(0);

    const secondFirst = evaluateBrowserResourceSample(
      recovered.state,
      sample({ memoryBytes: 150 }),
      {
        ...evaluationOptions,
        nowMs: 30_000,
      },
    );
    const second = evaluateBrowserResourceSample(secondFirst.state, sample({ memoryBytes: 150 }), {
      ...evaluationOptions,
      nowMs: 35_000,
    });
    expect(second.failure).toMatch(/consecutive samples/);

    const emergency = evaluateBrowserResourceSample(initial, sample({ memoryBytes: 201 }), {
      ...evaluationOptions,
      nowMs: 20_000,
    });
    expect(emergency.failure).toMatch(/twice/);
  });

  it('recycles only after sustained aggregate CPU pressure', () => {
    let state = createBrowserResourceGuardState(0);
    const snapshots = [
      sample({ systemCpuTicks: 1_000, processCpuTicks: new Map([['10:500', 100]]) }),
      sample({ systemCpuTicks: 1_400, processCpuTicks: new Map([['10:500', 300]]) }),
      sample({ systemCpuTicks: 1_800, processCpuTicks: new Map([['10:500', 500]]) }),
      sample({ systemCpuTicks: 2_200, processCpuTicks: new Map([['10:500', 700]]) }),
    ];
    let failure: string | undefined;
    for (const snapshot of snapshots) {
      const evaluated = evaluateBrowserResourceSample(state, snapshot, {
        ...evaluationOptions,
        nowMs: 20_000,
      });
      state = evaluated.state;
      failure = evaluated.failure;
    }
    expect(failure).toMatch(/sustained CPU/);
    expect(calculateBrowserTreeCpuPercent(snapshots[0]!, snapshots[1]!, 4)).toBe(200);
  });

  it('does not charge a newly reused PID against the previous process identity', () => {
    const previous = sample({
      systemCpuTicks: 1_000,
      processCpuTicks: new Map([['10:500', 100]]),
    });
    const current = sample({
      systemCpuTicks: 1_400,
      processCpuTicks: new Map([['10:999', 10_000]]),
    });
    expect(calculateBrowserTreeCpuPercent(previous, current, 4)).toBe(0);
  });
});

describe('X Firefox Linux process identity', () => {
  const procStat =
    '123 (Firefox RDD (media)) S 42 1 1 0 -1 4194560 100 0 0 0 120 30 0 0 20 0 12 0 987654';

  it('parses CPU and immutable starttime even when the process name contains parentheses', () => {
    expect(parseLinuxProcStat(procStat)).toEqual({
      parentPid: 42,
      cpuTimeTicks: 150,
      startTimeTicks: 987_654,
    });
    expect(statMatchesLinuxProcessIdentity({ pid: 123, startTimeTicks: 987_654 }, procStat)).toBe(
      true,
    );
    expect(statMatchesLinuxProcessIdentity({ pid: 123, startTimeTicks: 7 }, procStat)).toBe(false);
  });

  it('parses PSS and aggregate Linux CPU counters without double-counting guest time', () => {
    expect(parseLinuxSmapsRollupPss('Rss: 900 kB\nPss: 321 kB\nPss_Anon: 300 kB\n')).toBe(
      321 * 1024,
    );
    expect(parseLinuxSystemCpuTicks('cpu  100 20 30 400 10 5 5 0 50 20\ncpu0 1 2 3 4')).toBe(570);
  });

  it('recognizes current Snap argv variants while retaining exact-profile isolation', () => {
    const rows = [
      {
        pid: 10,
        parentPid: 1,
        rssBytes: 100,
        argv: ['/snap/firefox/current/usr/lib/firefox/firefox-bin', '--profile=/safe/x'],
      },
      {
        pid: 11,
        parentPid: 10,
        rssBytes: 200,
        argv: ['/snap/firefox/current/usr/lib/firefox/firefox', '-contentproc'],
      },
      {
        pid: 20,
        parentPid: 1,
        rssBytes: 300,
        argv: ['/snap/firefox/current/usr/lib/firefox/firefox', '--profile', '/safe/x-copy'],
      },
    ];
    expect(
      [...profileBrowserTreePids(rows, '/safe/x')].sort((left, right) => left - right),
    ).toEqual([10, 11]);
  });
});

describe('X Firefox hard guards', () => {
  it('hard-times out an operation whose underlying promise never settles', async () => {
    vi.useFakeTimers();
    const guarded = withHardTimeout(new Promise<never>(() => undefined), 50, 'test operation');
    const assertion = expect(guarded).rejects.toBeInstanceOf(XFrontendOperationTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('detaches direct, nested and MediaSource inputs and observes future source changes', () => {
    expect(X_FRONTEND_MEDIA_GUARD_SCRIPT).toContain("media.removeAttribute('src')");
    expect(X_FRONTEND_MEDIA_GUARD_SCRIPT).toContain("source.removeAttribute('src')");
    expect(X_FRONTEND_MEDIA_GUARD_SCRIPT).toContain('media.srcObject = null');
    expect(X_FRONTEND_MEDIA_GUARD_SCRIPT).toContain('media.load()');
    expect(X_FRONTEND_MEDIA_GUARD_SCRIPT).toContain(
      "attributeFilter: ['autoplay', 'preload', 'src']",
    );
  });
});
