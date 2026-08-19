import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, readFile, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { availableParallelism } from 'node:os';
import type { XFrontendConfig } from './config.js';
import { readXNetscapeCookieJar, type XNetscapeCookie } from './netscapeCookies.js';

const require = createRequire(import.meta.url);

// geckodriver rejects Ubuntu's /usr/bin/firefox shell wrapper; use the real binary in the same Snap.
const FIREFOX_BIN = '/snap/firefox/current/usr/lib/firefox/firefox';
const GECKODRIVER_BIN = '/snap/bin/geckodriver';
const XVFB_BIN = '/usr/bin/Xvfb';
const X11VNC_BIN = '/usr/bin/x11vnc';
const WEBSOCKIFY_BIN = '/usr/bin/websockify';
const NOVNC_WEB_ROOT = '/usr/share/novnc';
const DRIVER_HEALTH_TIMEOUT_MS = 8_000;
const RESOURCE_SAMPLE_TIMEOUT_MS = 4_000;
const RESOURCE_SAMPLE_INTERVAL_MS = 5_000;
const RESOURCE_ROOT_GRACE_MS = 15_000;
const TRANSIENT_HEALTH_FAILURES = 2;
const TRANSIENT_RESOURCE_FAILURES = 2;
const MEMORY_BREACH_SAMPLES = 2;
const CPU_BREACH_SAMPLES = 3;
const EMERGENCY_MEMORY_MULTIPLIER = 2;

/**
 * Runtime-owned Firefox preferences. Geckodriver regenerates user.js, so profile edits are not a
 * durable control point. Value 5 is Firefox's "block all autoplay" policy (audio and muted video).
 */
export const X_FRONTEND_FIREFOX_PREFERENCES = Object.freeze({
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.firstrunSkipsHomepage': true,
  'browser.startup.homepage_override.mstone': 'ignore',
  'browser.sessionhistory.max_total_viewers': 0,
  'browser.cache.memory.capacity': 65_536,
  'dom.webnotifications.enabled': false,
  'media.peerconnection.enabled': false,
  'media.autoplay.default': 5,
  'media.autoplay.blocking_policy': 2,
  'media.autoplay.allow-muted': false,
  'media.block-autoplay-until-in-foreground': true,
  'media.resume-background-video-on-tabhover': false,
  'media.suspend-bkgnd-video.enabled': true,
  'media.cache_readahead_limit': 5,
  'media.cache_resume_threshold': 2,
  'media.memory_cache_max_size': 4_096,
  'media.memory_caches_combined_limit_kb': 65_536,
  'network.http.http3.enable': false,
} satisfies Readonly<Record<string, string | number | boolean>>);

/**
 * Detach media rather than merely pausing it. In particular, `load()` after clearing `src`,
 * `srcObject` and nested sources tears down an already-selected MediaSource/H.264 decoder.
 */
export const X_FRONTEND_MEDIA_GUARD_SCRIPT = String.raw`
  const key = '__goonerbotMediaGuardV2';
  const previous = window[key];
  if (previous) {
    previous.observer?.disconnect();
    document.removeEventListener('play', previous.onPlay, true);
  }
  const stop = (media) => {
    if (!(media instanceof HTMLMediaElement)) return;
    try { media.pause(); } catch {}
    if (media.autoplay) media.autoplay = false;
    if (media.hasAttribute('autoplay')) media.removeAttribute('autoplay');
    if (media.preload !== 'none') media.preload = 'none';
    let reset = media.networkState !== HTMLMediaElement.NETWORK_EMPTY;
    if (media.hasAttribute('src')) {
      media.removeAttribute('src');
      reset = true;
    }
    for (const source of media.querySelectorAll('source')) {
      if (source.hasAttribute('src')) {
        source.removeAttribute('src');
        reset = true;
      }
    }
    try {
      if (media.srcObject !== null) {
        media.srcObject = null;
        reset = true;
      }
    } catch {}
    if (reset) {
      try { media.load(); } catch {}
    }
  };
  const scan = (root) => {
    if (root instanceof HTMLMediaElement) stop(root);
    if (root instanceof HTMLSourceElement) stop(root.parentElement);
    root?.querySelectorAll?.('video, audio').forEach(stop);
    root?.querySelectorAll?.('source').forEach((source) => stop(source.parentElement));
  };
  const onPlay = (event) => stop(event.target);
  document.addEventListener('play', onPlay, true);
  scan(document);
  if (!document.documentElement) throw new Error('media guard document is unavailable');
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') scan(record.target);
      record.addedNodes.forEach(scan);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['autoplay', 'preload', 'src']
  });
  window[key] = { observer, onPlay };
  return document.querySelectorAll('video, audio').length;
`;

interface DriverCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expiry?: number;
}

interface WebDriverLike {
  get(url: string): Promise<void>;
  getCurrentUrl(): Promise<string>;
  executeScript<T>(script: string): Promise<T>;
  manage(): {
    addCookie(cookie: DriverCookie): Promise<void>;
    getCookie(name: string): Promise<unknown>;
    setTimeouts(timeouts: { implicit?: number; pageLoad?: number; script?: number }): Promise<void>;
  };
  quit(): Promise<void>;
}

interface SeleniumBuilderLike {
  forBrowser(name: string): SeleniumBuilderLike;
  setFirefoxOptions(options: unknown): SeleniumBuilderLike;
  setFirefoxService(service: unknown): SeleniumBuilderLike;
  build(): Promise<WebDriverLike>;
}

interface SeleniumModule {
  Builder: new () => SeleniumBuilderLike;
}

interface FirefoxOptionsLike {
  setBinary(path: string): FirefoxOptionsLike;
  addArguments(...args: string[]): FirefoxOptionsLike;
  setPreference(name: string, value: string | number | boolean): FirefoxOptionsLike;
}

interface FirefoxServiceBuilderLike {
  setEnvironment(environment: NodeJS.ProcessEnv): FirefoxServiceBuilderLike;
}

interface FirefoxModule {
  Options: new () => FirefoxOptionsLike;
  ServiceBuilder: new (executable: string) => FirefoxServiceBuilderLike;
}

export interface XFrontendRuntime {
  readonly authenticated: boolean;
  readonly stopped: Promise<void>;
  stop(): Promise<void>;
}

/** The browser receives an exact detached cookie object; values are never logged or returned. */
export function toDriverCookie(cookie: XNetscapeCookie): DriverCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.includeSubdomains ? `.${cookie.domain}` : cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expiresAt === undefined ? {} : { expiry: cookie.expiresAt }),
  };
}

/** Login/challenge routes are intentionally classified without exposing the full current URL. */
export function isAuthenticatedXLocation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || (url.hostname !== 'x.com' && url.hostname !== 'twitter.com')) {
      return false;
    }
    const path = url.pathname.toLowerCase();
    return !(
      path === '/login' ||
      path.startsWith('/i/flow/login') ||
      path.startsWith('/i/flow/signup') ||
      path.startsWith('/account/access')
    );
  } catch {
    return false;
  }
}

/** Start a locally-bound interactive Firefox/noVNC session. It performs no automated writes. */
export async function startXFrontend(config: XFrontendConfig): Promise<XFrontendRuntime> {
  const cookies = await readXNetscapeCookieJar(config.cookieJarPath, {
    requireAuthenticatedSession: false,
  });
  await Promise.all(
    [FIREFOX_BIN, GECKODRIVER_BIN, XVFB_BIN, X11VNC_BIN, WEBSOCKIFY_BIN, NOVNC_WEB_ROOT].map(
      async (path) => access(path),
    ),
  ).catch(() => {
    throw new Error('an X frontend runtime dependency is unavailable');
  });

  let stopping = false;
  let runtimeReady = false;
  let terminalError: Error | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let healthTimer: NodeJS.Timeout | undefined;
  let resourceTimer: NodeJS.Timeout | undefined;
  let recycleTimer: NodeJS.Timeout | undefined;
  let healthCheckInFlight = false;
  let resourceCheckInFlight = false;
  let transientHealthFailures = 0;
  let transientResourceFailures = 0;
  let resourceGuardState: BrowserResourceGuardState | undefined;
  let driver: WebDriverLike | undefined;
  const children: ChildProcess[] = [];
  let resolveStopped!: () => void;
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  // A child can fail during startup, before the caller has received the runtime and can await it.
  // Keep that early rejection handled while preserving it for the eventual runtime consumer.
  void stopped.catch(() => undefined);

  const cleanup = async (): Promise<void> => {
    if (cleanupPromise !== undefined) return await cleanupPromise;
    stopping = true;
    cleanupPromise = (async () => {
      if (healthTimer !== undefined) clearInterval(healthTimer);
      if (resourceTimer !== undefined) clearInterval(resourceTimer);
      if (recycleTimer !== undefined) clearTimeout(recycleTimer);
      if (driver !== undefined) {
        await withHardTimeout(driver.quit(), 5_000, 'Firefox WebDriver shutdown').catch(
          () => undefined,
        );
      }
      // Firefox lives in a Snap transient scope outside this service's cgroup. If WebDriver quit
      // stalls, systemd cannot reap it for us, so explicitly terminate only the tree whose command
      // line contains this runtime's exact dedicated profile path.
      await terminateProfileBrowserTree(config.profileDir).catch(() => {
        terminalError ??= new Error('Firefox dedicated-profile process cleanup failed');
      });
      for (const child of [...children].reverse()) child.kill('SIGTERM');
      await Promise.all(children.map((child) => waitForChildExit(child, 5_000)));
      if (terminalError === undefined) resolveStopped();
      else rejectStopped(terminalError);
    })();
    return await cleanupPromise;
  };

  const fail = (error: Error): void => {
    if (stopping) return;
    terminalError ??= error;
    if (runtimeReady) void cleanup();
  };

  const assertHealthy = (): void => {
    if (terminalError !== undefined) throw terminalError;
  };

  const startChild = (label: string, command: string, args: string[]): ChildProcess => {
    const child = spawn(command, args, {
      env: { ...process.env, DISPLAY: config.display },
      stdio: 'ignore',
    });
    children.push(child);
    child.once('error', () => {
      fail(new Error(`${label} failed to start`));
    });
    child.once('exit', (code, signal) => {
      fail(new Error(`${label} exited unexpectedly (${signal ?? String(code ?? 'unknown')})`));
    });
    return child;
  };

  const runHealthCheck = async (): Promise<void> => {
    if (stopping || healthCheckInFlight || driver === undefined) return;
    healthCheckInFlight = true;
    try {
      await withHardTimeout(
        Promise.all([driver.getCurrentUrl(), enforceMediaQuiescence(driver)]),
        DRIVER_HEALTH_TIMEOUT_MS,
        'Firefox WebDriver health check',
      );
      transientHealthFailures = 0;
    } catch (error) {
      if (stopping) return;
      transientHealthFailures += 1;
      if (
        error instanceof XFrontendOperationTimeoutError ||
        transientHealthFailures >= TRANSIENT_HEALTH_FAILURES
      ) {
        fail(new Error('Firefox WebDriver or media guard was lost'));
      }
    } finally {
      healthCheckInFlight = false;
    }
  };

  const runResourceCheck = async (): Promise<void> => {
    if (stopping || resourceCheckInFlight || resourceGuardState === undefined) return;
    resourceCheckInFlight = true;
    try {
      const sample = await withHardTimeout(
        profileBrowserTreeResourceSample(config.profileDir),
        RESOURCE_SAMPLE_TIMEOUT_MS,
        'Firefox resource sample',
      );
      transientResourceFailures = 0;
      const evaluation = evaluateBrowserResourceSample(resourceGuardState, sample, {
        nowMs: Date.now(),
        maxMemoryBytes: config.browserMaxRssBytes,
        maxCpuPercent: config.browserMaxCpuPercent,
        logicalCpuCount: availableParallelism(),
      });
      resourceGuardState = evaluation.state;
      if (evaluation.failure !== undefined) fail(new Error(evaluation.failure));
    } catch (error) {
      if (stopping) return;
      transientResourceFailures += 1;
      if (
        error instanceof XFrontendOperationTimeoutError ||
        transientResourceFailures >= TRANSIENT_RESOURCE_FAILURES
      ) {
        fail(new Error('Firefox resource guard was lost'));
      }
    } finally {
      resourceCheckInFlight = false;
    }
  };

  try {
    await assertTcpPortsAvailable(config.bindHost, [config.vncPort, config.noVncPort]);
    // A previous supervisor may have been SIGKILLed while its Snap-scoped Firefox survived.
    // Ports are checked first so a concurrently healthy frontend is never mistaken for an orphan.
    await terminateProfileBrowserTree(config.profileDir);
    startChild('Xvfb', XVFB_BIN, [
      config.display,
      '-screen',
      '0',
      '1440x900x24',
      '-nolisten',
      'tcp',
      '-noreset',
    ]);
    await waitForDisplay(config.display, 8_000);
    assertHealthy();

    startChild('x11vnc', X11VNC_BIN, [
      '-display',
      config.display,
      '-localhost',
      '-rfbport',
      String(config.vncPort),
      '-forever',
      '-shared',
      '-nopw',
      '-noxdamage',
      '-quiet',
    ]);
    await waitForTcp(config.bindHost, config.vncPort, 8_000);
    assertHealthy();

    startChild('websockify', WEBSOCKIFY_BIN, [
      `--web=${NOVNC_WEB_ROOT}`,
      `${config.bindHost}:${config.noVncPort}`,
      `${config.bindHost}:${config.vncPort}`,
    ]);
    await waitForTcp(config.bindHost, config.noVncPort, 8_000);
    assertHealthy();

    driver = await startFirefox(config).catch(() => {
      throw new Error('Firefox WebDriver session could not start');
    });
    assertHealthy();
    await driver
      .manage()
      .setTimeouts({ implicit: 0, pageLoad: 45_000, script: 10_000 })
      .catch(() => {
        throw new Error('Firefox WebDriver timeouts could not be configured');
      });
    await driver.get('https://x.com/robots.txt').catch(() => {
      throw new Error('X browser bootstrap navigation failed');
    });

    const [profileAuthCookie, profileCsrfCookie] = await Promise.all([
      driver.manage().getCookie('auth_token'),
      driver.manage().getCookie('ct0'),
    ]).catch(() => {
      throw new Error('X browser profile check failed');
    });
    if (profileAuthCookie == null || profileCsrfCookie == null) {
      for (const cookie of cookies.filter(({ domain }) => domain === 'x.com')) {
        await driver
          .manage()
          .addCookie(toDriverCookie(cookie))
          .catch(() => {
            throw new Error('X browser session cookie import failed');
          });
      }
    }

    await driver.get('https://x.com/home').catch(() => {
      throw new Error('X home navigation failed');
    });
    await withHardTimeout(
      enforceMediaQuiescence(driver),
      DRIVER_HEALTH_TIMEOUT_MS,
      'initial Firefox media guard',
    ).catch(() => {
      throw new Error('X browser media guard could not be installed');
    });
    const authenticatedSurface = await withHardTimeout(
      waitForAuthenticatedSurface(driver, 15_000),
      20_000,
      'initial Firefox DOM authentication check',
    ).catch(() => {
      throw new Error('X browser authentication check failed');
    });
    const [authCookie, csrfCookie] = await Promise.all([
      driver.manage().getCookie('auth_token'),
      driver.manage().getCookie('ct0'),
    ]).catch(() => {
      throw new Error('X browser authentication check failed');
    });
    assertHealthy();
    const authenticated = authCookie != null && csrfCookie != null && authenticatedSurface;
    runtimeReady = true;
    resourceGuardState = createBrowserResourceGuardState(Date.now());

    recycleTimer = setTimeout(() => {
      fail(new Error('Firefox reached its maximum session age and will be recycled'));
    }, config.browserMaxSessionMs);
    recycleTimer.unref();

    healthTimer = setInterval(() => void runHealthCheck(), config.mediaGuardIntervalMs);
    healthTimer.unref();
    resourceTimer = setInterval(
      () => void runResourceCheck(),
      Math.min(RESOURCE_SAMPLE_INTERVAL_MS, config.mediaGuardIntervalMs),
    );
    resourceTimer.unref();
    // Establish CPU deltas and verify the real Snap process shape without waiting for the first tick.
    void runResourceCheck();

    return {
      authenticated,
      stopped,
      async stop(): Promise<void> {
        await cleanup();
      },
    };
  } catch (error) {
    terminalError ??= error instanceof Error ? error : new Error('X frontend startup failed');
    await cleanup();
    throw terminalError;
  }
}

async function startFirefox(config: XFrontendConfig): Promise<WebDriverLike> {
  const selenium = require('selenium-webdriver') as SeleniumModule;
  const firefox = require('selenium-webdriver/firefox') as FirefoxModule;
  const options = new firefox.Options()
    .setBinary(FIREFOX_BIN)
    .addArguments('-profile', config.profileDir, '--width=1440', '--height=900');
  for (const [name, value] of Object.entries(X_FRONTEND_FIREFOX_PREFERENCES)) {
    options.setPreference(name, value);
  }
  const service = new firefox.ServiceBuilder(GECKODRIVER_BIN).setEnvironment({
    ...process.env,
    DISPLAY: config.display,
    MOZ_ENABLE_WAYLAND: '0',
  });
  return await new selenium.Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();
}

/**
 * Page-level backstop for sites that attempt scripted playback despite browser autoplay policy.
 * This noVNC surface is an account console, not a media player: keeping media paused prevents an
 * invisible timeline from decoding forever and also removes autoplay/preload from newly added
 * elements in X's single-page application.
 */
async function enforceMediaQuiescence(driver: WebDriverLike): Promise<void> {
  await driver.executeScript<number>(X_FRONTEND_MEDIA_GUARD_SCRIPT);
}

export interface LinuxProcessEntry {
  pid: number;
  parentPid: number;
  rssBytes: number;
  argv: string[];
  /** `/proc/<pid>/stat` field 22; unlike PID alone this survives PID reuse checks. */
  startTimeTicks?: number | undefined;
  /** User + system scheduler ticks from `/proc/<pid>/stat`. */
  cpuTimeTicks?: number | undefined;
}

export interface BrowserTreeResourceSample {
  rootCount: number;
  processCount: number;
  /** PSS where readable, with per-process RSS only as a conservative fallback. */
  memoryBytes: number;
  memoryMeasurement: 'pss' | 'pss_with_rss_fallback';
  systemCpuTicks: number;
  processCpuTicks: ReadonlyMap<string, number>;
}

export interface BrowserResourceGuardState {
  rootGraceDeadlineMs: number;
  memoryBreachSamples: number;
  cpuBreachSamples: number;
  previousSample?: BrowserTreeResourceSample | undefined;
}

export interface BrowserResourceEvaluation {
  state: BrowserResourceGuardState;
  cpuPercent?: number | undefined;
  failure?: string | undefined;
}

export class XFrontendOperationTimeoutError extends Error {
  constructor(
    label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} exceeded its hard timeout`);
    this.name = 'XFrontendOperationTimeoutError';
  }
}

export async function withHardTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label = 'operation',
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('hard timeout must be positive');
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new XFrontendOperationTimeoutError(label, timeoutMs)),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Parse the two /proc status fields used by the out-of-cgroup Firefox watchdog. */
export function parseLinuxProcStatus(status: string): {
  parentPid: number;
  rssBytes: number;
} | null {
  const parent = /^PPid:\s+(\d+)$/mu.exec(status)?.[1];
  const rssKb = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1];
  if (parent === undefined || rssKb === undefined) return null;
  const parentPid = Number(parent);
  const rssBytes = Number(rssKb) * 1024;
  return Number.isSafeInteger(parentPid) && Number.isSafeInteger(rssBytes)
    ? { parentPid, rssBytes }
    : null;
}

/** Parse stable identity and CPU counters; the command name may itself contain `)`. */
export function parseLinuxProcStat(statLine: string): {
  parentPid: number;
  cpuTimeTicks: number;
  startTimeTicks: number;
} | null {
  const close = statLine.lastIndexOf(')');
  if (close < 2) return null;
  const fields = statLine
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const parentPid = Number(fields[1]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const startTimeTicks = Number(fields[19]);
  const cpuTimeTicks = userTicks + systemTicks;
  return [parentPid, userTicks, systemTicks, startTimeTicks, cpuTimeTicks].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )
    ? { parentPid, cpuTimeTicks, startTimeTicks }
    : null;
}

export function parseLinuxSmapsRollupPss(value: string): number | null {
  const pssKb = /^Pss:\s+(\d+)\s+kB$/mu.exec(value)?.[1];
  if (pssKb === undefined) return null;
  const bytes = Number(pssKb) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function parseLinuxSystemCpuTicks(value: string): number | null {
  const raw = /^cpu\s+(.+)$/mu.exec(value)?.[1];
  if (raw === undefined) return null;
  // guest and guest_nice are already included in user/nice, so only the first eight fields count.
  const fields = raw.trim().split(/\s+/u).slice(0, 8).map(Number);
  if (fields.length < 4 || fields.some((field) => !Number.isSafeInteger(field) || field < 0)) {
    return null;
  }
  const total = fields.reduce((sum, field) => sum + field, 0);
  return Number.isSafeInteger(total) ? total : null;
}

/** Legacy diagnostic helper retained for callers; enforcement uses proportional-set memory. */
export async function profileBrowserTreeRssBytes(profileDir: string): Promise<number | undefined> {
  const entries = await readLinuxProcessTable();
  const pids = profileBrowserTreePids(entries, profileDir);
  if (pids.size === 0) return undefined;
  return entries.reduce((sum, entry) => sum + (pids.has(entry.pid) ? entry.rssBytes : 0), 0);
}

/** Sample the exact Snap Firefox tree without waiting on WebDriver. */
export async function profileBrowserTreeResourceSample(
  profileDir: string,
): Promise<BrowserTreeResourceSample> {
  const [entries, cpuStat] = await Promise.all([
    readLinuxProcessTable(),
    readFile('/proc/stat', 'utf8'),
  ]);
  const roots = profileBrowserRootEntries(entries, profileDir);
  const pids = profileBrowserTreePids(entries, profileDir);
  const selected = entries.filter((entry) => pids.has(entry.pid));
  const pss = await Promise.all(
    selected.map(async (entry) => ({
      entry,
      pssBytes: await readProcessPssBytes(entry.pid),
    })),
  );
  const usedRssFallback = pss.some((row) => row.pssBytes === null);
  const memoryBytes = pss.reduce((sum, row) => sum + (row.pssBytes ?? row.entry.rssBytes), 0);
  const systemCpuTicks = parseLinuxSystemCpuTicks(cpuStat);
  if (systemCpuTicks === null) throw new Error('Linux aggregate CPU counters are unavailable');
  const processCpuTicks = new Map<string, number>();
  for (const entry of selected) {
    if (entry.startTimeTicks === undefined || entry.cpuTimeTicks === undefined) continue;
    processCpuTicks.set(processIdentityKey(entry.pid, entry.startTimeTicks), entry.cpuTimeTicks);
  }
  return {
    rootCount: roots.length,
    processCount: selected.length,
    memoryBytes,
    memoryMeasurement: usedRssFallback ? 'pss_with_rss_fallback' : 'pss',
    systemCpuTicks,
    processCpuTicks,
  };
}

export function calculateBrowserTreeCpuPercent(
  previous: BrowserTreeResourceSample,
  current: BrowserTreeResourceSample,
  logicalCpuCount: number,
): number | undefined {
  const systemDelta = current.systemCpuTicks - previous.systemCpuTicks;
  if (systemDelta <= 0 || !Number.isFinite(logicalCpuCount) || logicalCpuCount < 1)
    return undefined;
  let processDelta = 0;
  for (const [identity, currentTicks] of current.processCpuTicks) {
    const previousTicks = previous.processCpuTicks.get(identity);
    if (previousTicks !== undefined && currentTicks >= previousTicks) {
      processDelta += currentTicks - previousTicks;
    }
  }
  return Math.max(0, (processDelta / systemDelta) * Math.floor(logicalCpuCount) * 100);
}

export function createBrowserResourceGuardState(startedAtMs: number): BrowserResourceGuardState {
  return {
    rootGraceDeadlineMs: startedAtMs + RESOURCE_ROOT_GRACE_MS,
    memoryBreachSamples: 0,
    cpuBreachSamples: 0,
  };
}

export function evaluateBrowserResourceSample(
  previousState: BrowserResourceGuardState,
  sample: BrowserTreeResourceSample,
  options: {
    nowMs: number;
    maxMemoryBytes: number;
    maxCpuPercent: number;
    logicalCpuCount: number;
  },
): BrowserResourceEvaluation {
  if (sample.rootCount === 0) {
    const state: BrowserResourceGuardState = {
      ...previousState,
      memoryBreachSamples: 0,
      cpuBreachSamples: 0,
      previousSample: undefined,
    };
    return options.nowMs >= previousState.rootGraceDeadlineMs
      ? { state, failure: 'Firefox dedicated-profile process tree disappeared' }
      : { state };
  }

  const memoryBreachSamples =
    sample.memoryBytes > options.maxMemoryBytes ? previousState.memoryBreachSamples + 1 : 0;
  const cpuPercent = previousState.previousSample
    ? calculateBrowserTreeCpuPercent(previousState.previousSample, sample, options.logicalCpuCount)
    : undefined;
  const cpuBreachSamples =
    cpuPercent !== undefined && cpuPercent > options.maxCpuPercent
      ? previousState.cpuBreachSamples + 1
      : 0;
  const state: BrowserResourceGuardState = {
    ...previousState,
    memoryBreachSamples,
    cpuBreachSamples,
    previousSample: sample,
  };
  const memoryLimitMb = Math.round(options.maxMemoryBytes / 1024 / 1024);
  if (sample.memoryBytes > options.maxMemoryBytes * EMERGENCY_MEMORY_MULTIPLIER) {
    return {
      state,
      failure: `Firefox exceeded twice its ${memoryLimitMb} MB memory ceiling and will be recycled`,
      ...(cpuPercent === undefined ? {} : { cpuPercent }),
    };
  }
  if (memoryBreachSamples >= MEMORY_BREACH_SAMPLES) {
    return {
      state,
      failure: `Firefox exceeded its ${memoryLimitMb} MB memory ceiling in consecutive samples and will be recycled`,
      ...(cpuPercent === undefined ? {} : { cpuPercent }),
    };
  }
  if (cpuBreachSamples >= CPU_BREACH_SAMPLES) {
    return {
      state,
      failure: `Firefox exceeded its ${options.maxCpuPercent}% sustained CPU ceiling and will be recycled`,
      cpuPercent,
    };
  }
  return { state, ...(cpuPercent === undefined ? {} : { cpuPercent }) };
}

export interface LinuxProcessIdentity {
  pid: number;
  startTimeTicks: number;
}

async function terminateProfileBrowserTree(profileDir: string): Promise<void> {
  const entries = await readLinuxProcessTable();
  const pids = profileBrowserTreePids(entries, profileDir);
  const targets: LinuxProcessIdentity[] = entries
    .filter(
      (entry) =>
        pids.has(entry.pid) &&
        entry.pid > 1 &&
        entry.pid !== process.pid &&
        entry.startTimeTicks !== undefined,
    )
    .map((entry) => ({ pid: entry.pid, startTimeTicks: entry.startTimeTicks! }));
  await Promise.all(targets.map((target) => signalProcessIdentity(target, 'SIGTERM')));
  const deadline = Date.now() + 3_000;
  while ((await anyProcessIdentityExists(targets)) && Date.now() < deadline) await wait(100);
  const survivors = await existingProcessIdentities(targets);
  await Promise.all(survivors.map((target) => signalProcessIdentity(target, 'SIGKILL')));
  const killDeadline = Date.now() + 1_000;
  while ((await anyProcessIdentityExists(survivors)) && Date.now() < killDeadline) await wait(50);
  if (await anyProcessIdentityExists(survivors)) {
    throw new Error('Firefox dedicated-profile processes survived SIGKILL');
  }
}

export function profileBrowserTreePids(
  entries: readonly LinuxProcessEntry[],
  profileDir: string,
): Set<number> {
  const selected = new Set(
    profileBrowserRootEntries(entries, profileDir).map((entry) => entry.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!selected.has(entry.pid) && selected.has(entry.parentPid)) {
        selected.add(entry.pid);
        changed = true;
      }
    }
  }
  return selected;
}

function profileBrowserRootEntries(
  entries: readonly LinuxProcessEntry[],
  profileDir: string,
): LinuxProcessEntry[] {
  return entries.filter((entry) => {
    const executable = entry.argv[0] ?? '';
    return (
      /(?:^|\/)firefox(?:-bin)?$/u.test(executable) && argvUsesExactProfile(entry.argv, profileDir)
    );
  });
}

function argvUsesExactProfile(argv: readonly string[], profileDir: string): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if ((argument === '-profile' || argument === '--profile') && argv[index + 1] === profileDir) {
      return true;
    }
    if (argument === `-profile=${profileDir}` || argument === `--profile=${profileDir}`)
      return true;
  }
  return false;
}

async function readLinuxProcessTable(): Promise<LinuxProcessEntry[]> {
  const processDirectories = (await readdir('/proc', { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && /^\d+$/u.test(entry.name),
  );
  const rows = await Promise.all(
    processDirectories.map(async (directory): Promise<LinuxProcessEntry | null> => {
      const pid = Number(directory.name);
      try {
        const [status, command, statLine] = await Promise.all([
          readFile(`/proc/${directory.name}/status`, 'utf8'),
          readFile(`/proc/${directory.name}/cmdline`),
          readFile(`/proc/${directory.name}/stat`, 'utf8'),
        ]);
        const parsedStatus = parseLinuxProcStatus(status);
        const parsedStat = parseLinuxProcStat(statLine);
        if (!parsedStatus || !parsedStat) return null;
        return {
          pid,
          parentPid: parsedStat.parentPid,
          rssBytes: parsedStatus.rssBytes,
          argv: command.toString('utf8').split('\0').filter(Boolean),
          startTimeTicks: parsedStat.startTimeTicks,
          cpuTimeTicks: parsedStat.cpuTimeTicks,
        };
      } catch {
        // Processes legitimately disappear while /proc is being sampled.
        return null;
      }
    }),
  );
  return rows.filter((row): row is LinuxProcessEntry => row !== null);
}

async function readProcessPssBytes(pid: number): Promise<number | null> {
  try {
    return parseLinuxSmapsRollupPss(await readFile(`/proc/${pid}/smaps_rollup`, 'utf8'));
  } catch {
    return null;
  }
}

function processIdentityKey(pid: number, startTimeTicks: number): string {
  return `${pid}:${startTimeTicks}`;
}

export function statMatchesLinuxProcessIdentity(
  identity: Readonly<LinuxProcessIdentity>,
  statLine: string,
): boolean {
  const parsed = parseLinuxProcStat(statLine);
  return parsed !== null && parsed.startTimeTicks === identity.startTimeTicks;
}

async function processIdentityExists(identity: LinuxProcessIdentity): Promise<boolean> {
  try {
    return statMatchesLinuxProcessIdentity(
      identity,
      await readFile(`/proc/${identity.pid}/stat`, 'utf8'),
    );
  } catch {
    return false;
  }
}

async function existingProcessIdentities(
  identities: readonly LinuxProcessIdentity[],
): Promise<LinuxProcessIdentity[]> {
  const existing = await Promise.all(
    identities.map(async (identity) => ({
      identity,
      exists: await processIdentityExists(identity),
    })),
  );
  return existing.filter((entry) => entry.exists).map((entry) => entry.identity);
}

async function anyProcessIdentityExists(
  identities: readonly LinuxProcessIdentity[],
): Promise<boolean> {
  return (await existingProcessIdentities(identities)).length > 0;
}

async function signalProcessIdentity(
  identity: LinuxProcessIdentity,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!(await processIdentityExists(identity))) return;
  try {
    process.kill(identity.pid, signal);
  } catch {
    // Already gone is the successful cleanup outcome.
  }
}

async function waitForDisplay(display: string, timeoutMs: number): Promise<void> {
  const displayNumber = display.slice(1);
  const socket = `/tmp/.X11-unix/X${displayNumber}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await access(socket)
        .then(() => true)
        .catch(() => false)
    )
      return;
    await wait(100);
  }
  throw new Error('Xvfb display did not become ready');
}

async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await wait(100);
  }
  throw new Error('local frontend listener did not become ready');
}

async function assertTcpPortsAvailable(host: string, ports: readonly number[]): Promise<void> {
  const occupied = await Promise.all(ports.map(async (port) => canConnect(host, port)));
  if (occupied.some(Boolean)) throw new Error('an X frontend TCP port is already in use');
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const failed = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once('error', failed);
    socket.once('timeout', failed);
  });
}

async function waitForAuthenticatedSurface(
  driver: WebDriverLike,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = await driver.getCurrentUrl();
    if (!isAuthenticatedXLocation(currentUrl)) return false;
    const found = await driver.executeScript<boolean>(
      `return Boolean(document.querySelector(
        '[data-testid="AppTabBar_Notifications_Link"], [data-testid="SideNav_NewTweet_Button"], a[href="/notifications"], a[href="/compose/post"]'
      ));`,
    );
    if (found === true) return true;
    await wait(500);
  }
  return false;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    wait(timeoutMs).then(() => {
      child.kill('SIGKILL');
    }),
  ]);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
