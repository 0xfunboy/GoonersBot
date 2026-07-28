import {
  assertSafeRemoteUrl,
  downloadSafeRemoteFile,
  fetchSafeRemoteBuffer,
} from '../../../utils/safeRemoteFetch.js';

const TEXT_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'application/json',
  'text/plain',
] as const;

export interface HttpFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  allowedContentTypes?: readonly string[];
}

/** Backward-compatible name used by the yt-dlp bridge. */
export const assertSafeUrl = assertSafeRemoteUrl;

export async function fetchText(url: string, opts: HttpFetchOptions): Promise<string> {
  const result = await fetchSafeRemoteBuffer(url, {
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    signal: opts.signal,
    allowedContentTypes: opts.allowedContentTypes ?? TEXT_CONTENT_TYPES,
    headers: {
      'user-agent': opts.userAgent,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.7',
      ...(opts.headers ?? {}),
    },
  });
  return result.buffer.toString('utf8');
}

export async function downloadToFile(
  url: string,
  dest: string,
  opts: HttpFetchOptions,
): Promise<void> {
  await downloadSafeRemoteFile(url, dest, {
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    signal: opts.signal,
    allowedContentTypes: opts.allowedContentTypes,
    headers: {
      'user-agent': opts.userAgent,
      accept: '*/*',
      ...(opts.headers ?? {}),
    },
  });
}
