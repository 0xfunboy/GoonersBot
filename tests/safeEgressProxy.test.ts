import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSafeEgressProxy } from '../src/utils/safeEgressProxy.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('safe yt-dlp egress proxy', () => {
  it('rejects a CONNECT tunnel to loopback and removes its private socket on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goonerbot-egress-'));
    roots.push(root);
    const socketPath = join(root, 'proxy.sock');
    const proxy = await startSafeEgressProxy(socketPath);

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(
      proxyRequest(socketPath, 'CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'),
    ).resolves.toContain('403 Forbidden');

    await proxy.close();
    await expect(access(socketPath)).rejects.toThrow();
  });

  it('applies deployment content policy before resolving a CONNECT host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goonerbot-egress-'));
    roots.push(root);
    const socketPath = join(root, 'proxy.sock');
    const validateUrl = vi.fn(() => {
      throw new Error('blocked by policy');
    });
    const proxy = await startSafeEgressProxy(socketPath, { validateUrl });

    await expect(
      proxyRequest(socketPath, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n'),
    ).resolves.toContain('403 Forbidden');
    expect(validateUrl).toHaveBeenCalledWith(new URL('https://example.com/'));
    await proxy.close();
  });
});

function proxyRequest(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(socketPath, () => socket.write(request));
    socket.setTimeout(3_000, () => socket.destroy(new Error('proxy response timed out')));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
