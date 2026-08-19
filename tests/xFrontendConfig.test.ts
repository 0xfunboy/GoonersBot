import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadXFrontendConfig, XFrontendConfigError } from '../src/frontend/x/config.js';
import {
  parseXNetscapeCookies,
  readXNetscapeCookieJar,
  XNetscapeCookieJarError,
} from '../src/frontend/x/netscapeCookies.js';
import {
  parseLinuxProcStatus,
  profileBrowserTreePids,
  X_FRONTEND_FIREFOX_PREFERENCES,
} from '../src/frontend/x/runtime.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  cookieJarPath: string;
  profileDir: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), 'goonerbot-x-frontend-'));
  temporaryDirectories.push(root);
  const cookieJarPath = join(root, 'x.cookies.txt');
  const profileDir = join(root, 'profile');
  await writeFile(cookieJarPath, authenticatedJar(), { encoding: 'utf8', mode: 0o600 });
  await mkdir(profileDir, { mode: 0o700 });
  return {
    root,
    cookieJarPath,
    profileDir,
    env: {
      SOCIAL_X_COOKIE_JAR_FILE: cookieJarPath,
      SOCIAL_X_BROWSER_PROFILE_DIR: profileDir,
    },
  };
}

function authenticatedJar(): string {
  return [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.x.com\tTRUE\t/\tTRUE\t4102444800\tauth_token\tfixture-auth-value',
    '.x.com\tTRUE\t/\tTRUE\t4102444800\tct0\tfixture-csrf-value',
    '',
  ].join('\n');
}

describe('X frontend configuration', () => {
  it('loads immutable loopback defaults and private absolute paths', async () => {
    const setup = await fixture();
    const config = await loadXFrontendConfig(setup.env);

    expect(config).toEqual({
      bindHost: '127.0.0.1',
      noVncPort: 6088,
      vncPort: 5908,
      display: ':98',
      cookieJarPath: setup.cookieJarPath,
      profileDir: setup.profileDir,
      browserMaxRssBytes: 1_536 * 1024 * 1024,
      browserMaxCpuPercent: 300,
      browserMaxSessionMs: 360 * 60_000,
      mediaGuardIntervalMs: 15_000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('bounds Firefox RSS, recycle age and media-guard cadence', async () => {
    const setup = await fixture();
    const config = await loadXFrontendConfig({
      ...setup.env,
      SOCIAL_X_BROWSER_MAX_RSS_MB: '768',
      SOCIAL_X_BROWSER_MAX_CPU_PERCENT: '450',
      SOCIAL_X_BROWSER_MAX_SESSION_MINUTES: '90',
      SOCIAL_X_MEDIA_GUARD_INTERVAL_SECONDS: '10',
    });
    expect(config.browserMaxRssBytes).toBe(768 * 1024 * 1024);
    expect(config.browserMaxCpuPercent).toBe(450);
    expect(config.browserMaxSessionMs).toBe(90 * 60_000);
    expect(config.mediaGuardIntervalMs).toBe(10_000);

    await expect(
      loadXFrontendConfig({ ...setup.env, SOCIAL_X_BROWSER_MAX_RSS_MB: '128' }),
    ).rejects.toThrow('between 256 and 8192');
    await expect(
      loadXFrontendConfig({ ...setup.env, SOCIAL_X_BROWSER_MAX_SESSION_MINUTES: '0' }),
    ).rejects.toThrow('between 15 and 1440');
    await expect(
      loadXFrontendConfig({ ...setup.env, SOCIAL_X_BROWSER_MAX_CPU_PERCENT: '50' }),
    ).rejects.toThrow('between 100 and 800');
  });

  it.each(['0.0.0.0', '::1', 'localhost', '192.168.1.2'])(
    'rejects non-explicit loopback host %s',
    async (host) => {
      const setup = await fixture();
      await expect(
        loadXFrontendConfig({ ...setup.env, SOCIAL_X_FRONTEND_HOST: host }),
      ).rejects.toBeInstanceOf(XFrontendConfigError);
    },
  );

  it('validates distinct unprivileged ports', async () => {
    const setup = await fixture();
    await expect(
      loadXFrontendConfig({
        ...setup.env,
        SOCIAL_X_FRONTEND_PORT: '5908',
        SOCIAL_X_VNC_PORT: '5908',
      }),
    ).rejects.toThrow('ports must be different');
    await expect(
      loadXFrontendConfig({ ...setup.env, SOCIAL_X_FRONTEND_PORT: '443' }),
    ).rejects.toThrow('between 1024 and 65535');
    await expect(loadXFrontendConfig({ ...setup.env, SOCIAL_X_VNC_PORT: '65536' })).rejects.toThrow(
      'between 1024 and 65535',
    );
  });

  it.each(['0', ':0', ':98.0', 'host:98', ':10000'])(
    'rejects unsafe X display %s',
    async (display) => {
      const setup = await fixture();
      await expect(
        loadXFrontendConfig({ ...setup.env, SOCIAL_X_DISPLAY: display }),
      ).rejects.toThrow('isolated X display');
    },
  );

  it('requires absolute cookie/profile paths with exact private modes', async () => {
    const setup = await fixture();
    await expect(
      loadXFrontendConfig({ ...setup.env, SOCIAL_X_COOKIE_JAR_FILE: 'x.cookies.txt' }),
    ).rejects.toThrow('must be an absolute path');
    await expect(
      loadXFrontendConfig({ ...setup.env, SOCIAL_X_BROWSER_PROFILE_DIR: 'profile' }),
    ).rejects.toThrow('must be an absolute path');

    await chmod(setup.cookieJarPath, 0o640);
    await expect(loadXFrontendConfig(setup.env)).rejects.toThrow('exactly 600');
    await chmod(setup.cookieJarPath, 0o600);
    await chmod(setup.profileDir, 0o750);
    await expect(loadXFrontendConfig(setup.env)).rejects.toThrow('exactly 700');
  });

  it('rejects a symlinked credential file', async () => {
    const setup = await fixture();
    const linkedJar = join(setup.root, 'linked.cookies.txt');
    await symlink(setup.cookieJarPath, linkedJar);
    await expect(
      loadXFrontendConfig({ ...setup.env, SOCIAL_X_COOKIE_JAR_FILE: linkedJar }),
    ).rejects.toThrow('must not be a symbolic link');
  });
});

describe('X Firefox resource guard', () => {
  it('installs block-all autoplay and bounded media-cache preferences in code', () => {
    expect(X_FRONTEND_FIREFOX_PREFERENCES['media.autoplay.default']).toBe(5);
    expect(X_FRONTEND_FIREFOX_PREFERENCES['media.autoplay.allow-muted']).toBe(false);
    expect(X_FRONTEND_FIREFOX_PREFERENCES['media.memory_caches_combined_limit_kb']).toBe(65_536);
  });

  it('parses parent and resident bytes from Linux proc status without guessing missing fields', () => {
    expect(
      parseLinuxProcStatus('Name:\tfirefox\nPPid:\t2478\nVmRSS:\t505140 kB\nThreads:\t7\n'),
    ).toEqual({ parentPid: 2478, rssBytes: 505_140 * 1024 });
    expect(parseLinuxProcStatus('Name:\tfirefox\nPPid:\t1\n')).toBeNull();
  });

  it('selects only the exact dedicated-profile Firefox tree', () => {
    const rows = [
      {
        pid: 10,
        parentPid: 1,
        rssBytes: 100,
        argv: ['/snap/firefox/firefox', '-profile', '/safe/x'],
      },
      {
        pid: 11,
        parentPid: 10,
        rssBytes: 200,
        argv: ['/snap/firefox/firefox', '-contentproc'],
      },
      {
        pid: 12,
        parentPid: 11,
        rssBytes: 300,
        argv: ['/snap/firefox/firefox', '-contentproc'],
      },
      {
        pid: 20,
        parentPid: 1,
        rssBytes: 400,
        argv: ['/snap/firefox/firefox', '-profile', '/personal'],
      },
      {
        pid: 21,
        parentPid: 20,
        rssBytes: 500,
        argv: ['/snap/firefox/firefox', '-contentproc'],
      },
      {
        pid: 30,
        parentPid: 1,
        rssBytes: 600,
        argv: ['/tmp/not-firefox', '-profile', '/safe/x'],
      },
    ];

    expect([...profileBrowserTreePids(rows, '/safe/x')].sort((a, b) => a - b)).toEqual([
      10, 11, 12,
    ]);
  });
});

describe('X Netscape cookie parser', () => {
  it('keeps only valid, unexpired X/Twitter cookies and preserves HttpOnly', () => {
    const cookies = parseXNetscapeCookies(
      [
        '# Netscape HTTP Cookie File',
        '#HttpOnly_.x.com\tTRUE\t/\tTRUE\t2000\tauth_token\tfixture-auth-value',
        '.x.com\tTRUE\t/\tTRUE\t2000\tct0\tfixture-csrf-value',
        '.mobile.twitter.com\tTRUE\t/\tTRUE\t0\ttwid\tfixture-user-value',
        '.example.com\tTRUE\t/\tTRUE\t2000\tforeign\tfixture-foreign-value',
        '.evilx.com\tTRUE\t/\tTRUE\t2000\tbad-boundary\tfixture-bad-value',
        '.x.com\tTRUE\t/\tTRUE\t999\texpired\tfixture-expired-value',
        'malformed',
        '',
      ].join('\n'),
      { nowSeconds: 1000 },
    );

    expect(cookies).toEqual([
      {
        name: 'auth_token',
        value: 'fixture-auth-value',
        domain: 'x.com',
        includeSubdomains: true,
        path: '/',
        secure: true,
        httpOnly: true,
        expiresAt: 2000,
      },
      {
        name: 'ct0',
        value: 'fixture-csrf-value',
        domain: 'x.com',
        includeSubdomains: true,
        path: '/',
        secure: true,
        httpOnly: false,
        expiresAt: 2000,
      },
      {
        name: 'twid',
        value: 'fixture-user-value',
        domain: 'mobile.twitter.com',
        includeSubdomains: true,
        path: '/',
        secure: true,
        httpOnly: false,
        expiresAt: undefined,
      },
    ]);
    expect(Object.isFrozen(cookies)).toBe(true);
    expect(cookies.every((cookie) => Object.isFrozen(cookie))).toBe(true);
  });

  it('fails closed when the authenticated session pair is incomplete without exposing values', () => {
    const secret = 'fixture-value-that-must-not-appear';
    expect(() =>
      parseXNetscapeCookies(`.x.com\tTRUE\t/\tTRUE\t4102444800\tauth_token\t${secret}\n`),
    ).toThrow(XNetscapeCookieJarError);
    try {
      parseXNetscapeCookies(`.x.com\tTRUE\t/\tTRUE\t4102444800\tauth_token\t${secret}\n`);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('re-checks file mode while reading the authenticated jar', async () => {
    const setup = await fixture();
    await expect(readXNetscapeCookieJar(setup.cookieJarPath)).resolves.toHaveLength(2);
    await chmod(setup.cookieJarPath, 0o644);
    await expect(readXNetscapeCookieJar(setup.cookieJarPath)).rejects.toThrow('mode-0600');
  });
});
