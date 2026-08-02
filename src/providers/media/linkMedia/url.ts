const URL_RE = /https?:\/\/[^\s<>()]+/gi;

/** Extract up to `max` distinct, fetchable http(s) URLs from free text. */
export function extractUrls(text: string, max: number): URL[] {
  const out: URL[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0].replace(/[),.?!]+$/g, '').replace(/&amp;/g, '&');

    try {
      const url = normalizeMediaUrl(raw);
      if (!url) continue;
      const key = mediaUrlKey(url) ?? url.toString();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(url);
      }
    } catch {
      // ignore invalid URL
    }

    if (out.length >= max) break;
  }

  return out;
}

/**
 * Normalize a fetch target without changing its query. Even parameters that commonly carry
 * tracking data can be part of a CDN signature, so only the non-request fragment is removed.
 */
export function normalizeMediaUrl(value: string | URL): URL | null {
  try {
    const url = value instanceof URL ? new URL(value) : new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

/** Stable comparison/cache key; cleanup and sorting happen only on this non-fetching copy. */
export function mediaUrlKey(value: string | URL): string | null {
  const url = normalizeMediaUrl(value);
  if (!url) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$|igsh$|si$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function hostOf(url: URL): string {
  return url.hostname
    .replace(/\.$/, '')
    .replace(/^www\./, '')
    .toLowerCase();
}
