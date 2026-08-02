import { lookup } from 'node:dns/promises';
import { chmod, unlink } from 'node:fs/promises';
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import net, { type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { isBlockedNetworkAddress } from './safeRemoteFetch.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface SafeEgressProxyOptions {
  signal?: AbortSignal;
  validateUrl?: ((url: URL) => void | Promise<void>) | undefined;
}

export interface SafeEgressProxy {
  socketPath: string;
  close(): Promise<void>;
}

interface ResolvedTarget {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

/**
 * A private Unix-socket HTTP proxy used as the only network exit from the yt-dlp namespace. Every
 * request (including HTTPS CONNECT) is resolved by the parent process, rejected if any answer is
 * non-public, and connected to the exact checked address so DNS rebinding cannot win a second
 * lookup. The Unix socket is mode 0600 and lives inside the per-download scratch directory.
 */
export async function startSafeEgressProxy(
  socketPath: string,
  opts: SafeEgressProxyOptions = {},
): Promise<SafeEgressProxy> {
  await unlink(socketPath).catch(() => undefined);
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    void forwardHttpRequest(req, res, opts).catch(() => rejectHttp(res));
  });

  server.on('connect', (req, client, head) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    void forwardConnect(req, client, head, opts).catch(() => rejectConnect(client));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_err, socket) => rejectConnect(socket, 400));

  const onAbort = (): void => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    opts.signal?.removeEventListener('abort', onAbort);
    server.close();
    await unlink(socketPath).catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      opts.signal?.removeEventListener('abort', onAbort);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}

async function forwardConnect(
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  opts: SafeEgressProxyOptions,
): Promise<void> {
  const target = await resolveTarget(connectUrl(req.url), opts);
  const upstream = await connectChecked(target, opts.signal);
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head.length > 0) upstream.write(head);
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
}

async function forwardHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SafeEgressProxyOptions,
): Promise<void> {
  const targetUrl = absoluteHttpUrl(req);
  const target = await resolveTarget(targetUrl, opts);
  if (target.url.protocol !== 'http:') throw new Error('HTTPS proxy requests must use CONNECT');
  const checkedSocket = await connectChecked(target, opts.signal);

  const headers = forwardedHeaders(req.headers, target.url.host);
  await new Promise<void>((resolve, reject) => {
    const upstream = http.request(
      {
        method: req.method,
        hostname: target.url.hostname,
        port: target.url.port ? Number.parseInt(target.url.port, 10) : 80,
        path: `${target.url.pathname}${target.url.search}`,
        headers,
        agent: false,
        createConnection: () => checkedSocket,
      },
      (upstreamResponse) => {
        const responseHeaders = forwardedHeaders(upstreamResponse.headers);
        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(res);
        upstreamResponse.once('end', resolve);
        upstreamResponse.once('error', reject);
      },
    );
    const onAbort = (): void => {
      upstream.destroy(abortReason(opts.signal!));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    upstream.once('close', () => opts.signal?.removeEventListener('abort', onAbort));
    res.once('close', () => upstream.destroy());
    upstream.once('error', reject);
    req.once('error', reject);
    req.pipe(upstream);
  });
}

function connectUrl(authority: string | undefined): URL {
  if (!authority || /[/?#]/.test(authority)) throw new Error('invalid CONNECT authority');
  const url = new URL(`https://${authority}/`);
  if (!url.port) url.port = '443';
  return url;
}

function absoluteHttpUrl(req: IncomingMessage): URL {
  const raw = req.url ?? '';
  if (/^https?:\/\//i.test(raw)) return new URL(raw);
  const host = req.headers.host;
  if (!host || !raw.startsWith('/')) throw new Error('invalid proxy request target');
  return new URL(`http://${host}${raw}`);
}

async function resolveTarget(rawUrl: URL, opts: SafeEgressProxyOptions): Promise<ResolvedTarget> {
  if (opts.signal?.aborted) throw abortReason(opts.signal);
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('proxy target protocol is not allowed');
  }
  if (url.username || url.password) throw new Error('proxy target credentials are not allowed');
  await opts.validateUrl?.(new URL(url));

  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('proxy target is not publicly routable');
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily !== 0) {
    if (isBlockedNetworkAddress(hostname)) {
      throw new Error('proxy target is not publicly routable');
    }
    return {
      url,
      addresses: [{ address: hostname, family: literalFamily as 4 | 6 }],
    };
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((candidate) => isBlockedNetworkAddress(candidate.address))
  ) {
    throw new Error('proxy target is not publicly routable');
  }
  if (opts.signal?.aborted) throw abortReason(opts.signal);
  const usableAddresses = addresses.filter(
    (candidate): candidate is { address: string; family: 4 | 6 } =>
      candidate.family === 4 || candidate.family === 6,
  );
  if (usableAddresses.length === 0) throw new Error('proxy target has no usable address');
  return {
    url,
    // Prefer IPv4 on hosts without working IPv6, but retain every already-validated answer as a
    // connection fallback. No second DNS lookup occurs.
    addresses: usableAddresses.sort((left, right) => left.family - right.family),
  };
}

async function connectChecked(target: ResolvedTarget, signal?: AbortSignal): Promise<Socket> {
  const port = target.url.port
    ? Number.parseInt(target.url.port, 10)
    : target.url.protocol === 'https:'
      ? 443
      : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('proxy target port is invalid');
  }
  let lastError: unknown;
  for (const candidate of target.addresses) {
    try {
      return await connectAddress(candidate, port, signal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('proxy target connection failed');
}

function connectAddress(
  target: { address: string; family: 4 | 6 },
  port: number,
  signal?: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const socket = net.connect({ host: target.address, family: target.family, port });
    const onAbort = (): void => {
      socket.destroy(abortReason(signal!));
    };
    const onError = (error: Error): void => {
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      resolve(socket);
    });
  });
}

function forwardedHeaders(headers: IncomingHttpHeaders, host?: string): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) forwarded[name] = value;
  }
  if (host) forwarded.host = host;
  return forwarded;
}

function rejectHttp(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(403, { connection: 'close', 'content-type': 'text/plain' });
  res.end('Forbidden\n');
}

function rejectConnect(socket: Duplex, status = 403): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${status === 400 ? 'Bad Request' : 'Forbidden'}\r\nConnection: close\r\n\r\n`,
    );
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('proxy aborted');
}
