const URL_RE = /https?:\/\/[^\s<>()]+/gi;

/** Extract up to `max` distinct, tracking-cleaned http(s) URLs from free text. */
export function extractUrls(text: string, max: number): URL[] {
  const out: URL[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0].replace(/[),.?!]+$/g, '').replace(/&amp;/g, '&');

    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|fbclid|gclid|igsh|si$)/i.test(key)) {
          url.searchParams.delete(key);
        }
      }
      const normalized = url.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(url);
      }
    } catch {
      // ignore invalid URL
    }

    if (out.length >= max) break;
  }

  return out;
}

export function hostOf(url: URL): string {
  return url.hostname.replace(/^www\./, '').toLowerCase();
}
