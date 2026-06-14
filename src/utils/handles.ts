/**
 * Telegram handle normalization helpers.
 */

/** Ensure a handle starts with '@'. Returns the trimmed, prefixed handle. */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

/** Build a stable fallback handle for users without a Telegram username. */
export function fallbackHandle(telegramId: number): string {
  return `@id${telegramId}`;
}

/** True when a handle is the synthetic id-based fallback. */
export function isFallbackHandle(handle: string): boolean {
  return /^@id\d+$/.test(handle);
}
