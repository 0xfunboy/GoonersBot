import { createHash } from 'node:crypto';

/** Stable short fingerprint of a reply's normalized text (for dedupe/feedback lookups). */
export function fingerprint(text: string): string {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/** Escape the HTML-significant characters for Telegram HTML parse_mode captions. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
