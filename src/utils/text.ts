import { createHash } from 'node:crypto';

/** Stable short fingerprint of a reply's normalized text (for dedupe/feedback lookups). */
export function fingerprint(text: string): string {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}
