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
    });
    expect(Object.isFrozen(config)).toBe(true);
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
