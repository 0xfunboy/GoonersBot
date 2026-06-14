import { InlineKeyboard } from 'grammy';
import type { KeyboardResponse } from '../domain/types.js';

const PAGE_SIZE = 8;

/**
 * Build a paginated inline keyboard from a KeyboardResponse.
 *
 * Callback data layout (ported from the original):
 * - selection button:  `${buttonAction}|${id}`        -> handler args = [id]
 * - pagination button: `${callback}|${buttonAction}|${page}` -> handler args = [buttonAction, page]
 */
export function buildInlineKeyboard(keyboard: KeyboardResponse, pageIndex = 0): InlineKeyboard {
  const kb = new InlineKeyboard();
  const start = pageIndex * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pageItems = keyboard.options.slice(start, end);

  for (const item of pageItems) {
    kb.text(capitalize(item.label), `${keyboard.buttonAction}|${item.id}`).row();
  }

  const nav: Array<{ label: string; data: string }> = [];
  if (start > 0) {
    nav.push({ label: '«', data: `${keyboard.callback}|${keyboard.buttonAction}|${pageIndex - 1}` });
  }
  if (end < keyboard.options.length) {
    nav.push({ label: '»', data: `${keyboard.callback}|${keyboard.buttonAction}|${pageIndex + 1}` });
  }
  if (nav.length > 0) {
    for (const n of nav) kb.text(n.label, n.data);
    kb.row();
  }
  return kb;
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Parse callback_data into [action, ...args] (mirrors python split('|')). */
export function parseCallbackData(data: string): { action: string; args: string[] } {
  const parts = data.split('|');
  return { action: parts[0] ?? '', args: parts.slice(1) };
}
