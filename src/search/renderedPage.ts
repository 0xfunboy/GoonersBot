import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createAbortScope } from '../utils/abort.js';
import { runProcessChecked } from '../utils/process.js';
import { fetchSafeRemoteBuffer } from '../utils/safeRemoteFetch.js';
import type { PageSummary } from './pageScanner.js';

export interface RenderedPageConfig {
  enabled: boolean;
  /** Absolute system executable path, never a user-supplied command. */
  chromiumCommand?: string;
  sandboxCommand?: string;
}

export interface RenderedPageResult {
  page: PageSummary;
  screenshot: Buffer;
  inspectedAt: string;
  sourceSha256: string;
  renderedTextSha256: string;
  limitations: string[];
}

export async function renderedPageReadiness(
  config: RenderedPageConfig,
): Promise<{ ready: boolean; reason?: string }> {
  if (!config.enabled)
    return { ready: false, reason: 'Rendered page reading is disabled by host configuration' };
  if (process.platform !== 'linux')
    return { ready: false, reason: 'An isolated Linux network namespace is required' };
  for (const executable of [
    config.chromiumCommand ?? '/usr/bin/chromium',
    config.sandboxCommand ?? '/usr/bin/bwrap',
  ]) {
    if (!isAbsolute(executable))
      return {
        ready: false,
        reason: 'Renderer commands must be absolute host-configured system paths',
      };
    try {
      await access(executable, constants.X_OK);
    } catch {
      return { ready: false, reason: `Required renderer executable is unavailable: ${executable}` };
    }
  }
  try {
    // Availability includes kernel namespace permission, not merely a file named bwrap.
    await runProcessChecked(
      config.sandboxCommand ?? '/usr/bin/bwrap',
      [
        '--unshare-all',
        '--die-with-parent',
        '--clearenv',
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind',
        '/lib',
        '/lib',
        '--ro-bind-try',
        '/lib64',
        '/lib64',
        '--',
        '/usr/bin/true',
      ],
      { timeoutMs: 3000, maxStderrBytes: 1024 },
      'renderer isolation probe',
    );
  } catch {
    return {
      ready: false,
      reason: 'Kernel namespace isolation is unavailable; renderer remains disabled',
    };
  }
  return { ready: true };
}

/**
 * Render a downloaded public snapshot, never a live account browser. Every network fetch
 * happens in the SSRF-safe host reader; JavaScript runs without any network namespace or
 * access to /home, host environment, credentials, or a persistent browser profile.
 */
export async function renderPublicPage(
  url: string,
  config: RenderedPageConfig,
  signal?: AbortSignal,
): Promise<RenderedPageResult> {
  const readiness = await renderedPageReadiness(config);
  if (!readiness.ready) throw new Error(readiness.reason ?? 'Isolated renderer unavailable');
  const browser = await realpath(config.chromiumCommand ?? '/usr/bin/chromium');
  if (!browser.startsWith('/usr/') && !browser.startsWith('/bin/') && !browser.startsWith('/lib/'))
    throw new Error('Renderer executable must live inside read-only system directories');
  const directory = await mkdtemp(join(tmpdir(), 'goonerbot-render-'));
  const output = join(directory, 'output');
  const scope = createAbortScope(60_000, signal, 'isolated page rendering');
  const limitations = [
    'Rendered an offline public snapshot; no account session, forms, authenticated content, or live API requests were used.',
    'Only up to three same-origin scripts/styles are acquired; network-dependent content, images, fonts, imports and cross-origin assets may be absent.',
    'A screenshot and visible DOM do not establish server-side source access or confirmed vulnerabilities.',
  ];
  try {
    const fetched = await fetchSafeRemoteBuffer(url, {
      timeoutMs: 15_000,
      maxBytes: 1_000_000,
      allowedContentTypes: ['text/html', 'application/xhtml+xml'],
      signal: scope.signal,
    });
    if (fetched.status < 200 || fetched.status >= 300)
      throw new Error(`Page returned HTTP ${fetched.status}`);
    const base = new URL(fetched.finalUrl);
    const $ = load(fetched.buffer.toString('utf8'));
    // No browser navigation or embedded browsing contexts, including meta refresh and srcdoc.
    $('base, iframe, frame, object, embed, meta[http-equiv="refresh" i]').remove();
    $('form').removeAttr('action').removeAttr('method');
    $('a').removeAttr('href');
    $('video,audio').removeAttr('autoplay').removeAttr('src');
    $('source').remove();
    let assetCount = 0;
    let totalBytes = fetched.buffer.length;
    const assets = $('script[src],link[rel~="stylesheet"][href]').toArray();
    for (const element of assets) {
      const node = $(element);
      const raw = node.attr('src') ?? node.attr('href') ?? '';
      let target: URL;
      try {
        target = new URL(raw, base);
      } catch {
        node.remove();
        continue;
      }
      if (assetCount >= 3 || target.origin !== base.origin || target.username || target.password) {
        node.remove();
        continue;
      }
      try {
        const asset = await fetchSafeRemoteBuffer(target, {
          timeoutMs: 8000,
          maxBytes: Math.min(350_000, 2_000_000 - totalBytes),
          signal: scope.signal,
          allowedContentTypes: [
            'text/javascript',
            'application/javascript',
            'text/css',
            'application/x-javascript',
          ],
          validateUrl: (redirect) => {
            if (redirect.origin !== base.origin)
              throw new Error('Cross-origin renderer asset rejected');
          },
        });
        totalBytes += asset.buffer.length;
        if (asset.status < 200 || asset.status >= 300) {
          node.remove();
          continue;
        }
        const script = element.tagName === 'script';
        const name = `asset-${assetCount++}.${script ? 'js' : 'css'}`;
        await writeFile(join(directory, name), asset.buffer, { mode: 0o600 });
        node
          .attr(script ? 'src' : 'href', `file:///work/${name}`)
          .removeAttr('integrity')
          .removeAttr('crossorigin');
      } catch {
        scope.signal.throwIfAborted();
        node.remove();
      }
    }
    // Namespace isolation is the security boundary, CSP is an additional fail-closed guard.
    $('head').prepend(
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' file:; style-src 'unsafe-inline' file:; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; media-src 'none'\">",
    );
    await writeFile(join(directory, 'index.html'), $.html(), { mode: 0o600 });
    await mkdir(output, { mode: 0o700 });
    const args = [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--clearenv',
      '--setenv',
      'PATH',
      '/usr/bin:/bin',
      '--setenv',
      'HOME',
      '/tmp',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/bin',
      '/bin',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind-try',
      '/lib64',
      '/lib64',
      '--ro-bind-try',
      '/etc/fonts',
      '/etc/fonts',
      '--ro-bind-try',
      '/etc/ld.so.cache',
      '/etc/ld.so.cache',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/run',
      '--ro-bind',
      directory,
      '/work',
      '--bind',
      output,
      '/output',
      '--chdir',
      '/work',
      '--',
      browser,
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=user-gesture-required',
      '--user-data-dir=/tmp/profile',
      '--window-size=1280,960',
      '--virtual-time-budget=3000',
      '--screenshot=/output/page.png',
      '--dump-dom',
      'file:///work/index.html',
    ];
    const rendered = await runProcessChecked(
      config.sandboxCommand ?? '/usr/bin/bwrap',
      args,
      {
        timeoutMs: 25_000,
        signal: scope.signal,
        collectStdout: true,
        maxStdoutBytes: 2_000_000,
        maxFileBytes: 8_000_000,
        maxRssBytes: 768 * 1024 * 1024,
        maxCpuSeconds: 20,
      },
      'isolated public renderer',
    );
    const screenshotPath = join(output, 'page.png');
    if ((await stat(screenshotPath)).size > 8_000_000)
      throw new Error('Rendered screenshot exceeds its size budget');
    const screenshot = await readFile(screenshotPath);
    if (!screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('Renderer did not produce a valid PNG screenshot');
    const dom = load(rendered.stdout.toString('utf8'));
    dom('script,style,noscript,svg').remove();
    const text = dom('body').text().replace(/\s+/gu, ' ').trim().slice(0, 16_000);
    return {
      page: {
        url: fetched.finalUrl,
        title: dom('title').text().slice(0, 240),
        text,
        facts: [],
        outboundLinks: [],
      },
      screenshot,
      inspectedAt: new Date().toISOString(),
      sourceSha256: createHash('sha256').update(fetched.buffer).digest('hex'),
      renderedTextSha256: createHash('sha256').update(text).digest('hex'),
      limitations,
    };
  } finally {
    scope.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
