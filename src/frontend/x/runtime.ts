import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { createConnection } from 'node:net';
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
  let healthCheckInFlight = false;
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
      if (driver !== undefined) {
        await Promise.race([driver.quit().catch(() => undefined), wait(5_000)]);
      }
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

  try {
    await assertTcpPortsAvailable(config.bindHost, [config.vncPort, config.noVncPort]);
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
    const authenticatedSurface = await waitForAuthenticatedSurface(driver, 15_000).catch(() => {
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

    healthTimer = setInterval(() => {
      if (stopping || healthCheckInFlight || driver === undefined) return;
      healthCheckInFlight = true;
      void driver
        .getCurrentUrl()
        .catch(() => fail(new Error('Firefox WebDriver connection was lost')))
        .finally(() => {
          healthCheckInFlight = false;
        });
    }, 15_000);

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
    .addArguments('-profile', config.profileDir, '--width=1440', '--height=900')
    .setPreference('browser.shell.checkDefaultBrowser', false)
    .setPreference('browser.startup.firstrunSkipsHomepage', true)
    .setPreference('browser.startup.homepage_override.mstone', 'ignore')
    .setPreference('dom.webnotifications.enabled', false)
    .setPreference('media.peerconnection.enabled', false)
    .setPreference('network.http.http3.enable', false);
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
