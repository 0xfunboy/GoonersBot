import type { ResponseTextFormat } from '../domain/types.js';

export interface RenderedTelegramText {
  text: string;
  parseMode: 'HTML';
}

const PLACEHOLDER_OPEN = '\u0001';
const PLACEHOLDER_CLOSE = '\u0002';

/**
 * Render a response into Telegram's deliberately small HTML dialect.
 *
 * LLM output is CommonMark-like, not Telegram MarkdownV2. Converting it here avoids exposing raw
 * `**bold**` markers and, unlike forwarding MarkdownV2 directly, does not require the model to
 * correctly escape every punctuation character. Raw HTML emitted by a model is escaped.
 */
export function renderTelegramText(
  input: string,
  format: ResponseTextFormat = 'markdown',
): RenderedTelegramText {
  if (format === 'html') return { text: input, parseMode: 'HTML' };
  if (format === 'plain') return { text: escapeTelegramHtml(input), parseMode: 'HTML' };
  return { text: markdownToTelegramHtml(input), parseMode: 'HTML' };
}

/** Convert the supported CommonMark subset into valid Telegram HTML. */
export function markdownToTelegramHtml(input: string): string {
  const protectedFragments: string[] = [];
  const protect = (value: string): string => {
    const index = protectedFragments.push(value) - 1;
    return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
  };

  let text = input
    .replace(/\r\n?/g, '\n')
    .replaceAll(PLACEHOLDER_OPEN, '')
    .replaceAll(PLACEHOLDER_CLOSE, '');

  // Code must be protected before any other inline syntax is interpreted.
  text = text.replace(/```[^\S\n]*[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) =>
    protect(`<pre>${escapeTelegramHtml(code.replace(/\n$/, ''))}</pre>`),
  );
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    protect(`<code>${escapeTelegramHtml(code)}</code>`),
  );

  // Backslash-escaped Markdown punctuation is literal.
  text = text.replace(/\\([\\`*_[\]()>#+\-.!|~])/g, (_match, literal: string) =>
    protect(escapeTelegramHtml(literal)),
  );

  // Only allow explicit web links. Everything else remains visible text instead of becoming an
  // unsafe/invalid Telegram entity.
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)\)/gi,
    (_match, label: string, href: string) => {
      const safeHref = safeWebHref(href);
      if (!safeHref) return `${label} (${href})`;
      return protect(
        `<a href="${escapeTelegramHtmlAttribute(safeHref)}">${escapeTelegramHtml(label)}</a>`,
      );
    },
  );

  const escaped = escapeTelegramHtml(text);
  const lines = escaped.split('\n');
  const rendered: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      const quoted: string[] = [];
      let cursor = index;
      while (cursor < lines.length) {
        const match = (lines[cursor] ?? '').match(/^\s*&gt;\s?(.*)$/);
        if (!match) break;
        quoted.push(renderInlineMarkdown(match[1] ?? ''));
        cursor += 1;
      }
      rendered.push(`<blockquote>${quoted.join('\n')}</blockquote>`);
      index = cursor - 1;
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      rendered.push(`<b>${renderInlineMarkdown(heading[1] ?? '')}</b>`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-+*]\s+(.+)$/);
    if (bullet) {
      rendered.push(`${bullet[1] ?? ''}• ${renderInlineMarkdown(bullet[2] ?? '')}`);
      continue;
    }

    rendered.push(renderInlineMarkdown(line));
  }

  return restoreProtected(rendered.join('\n'), protectedFragments);
}

function renderInlineMarkdown(input: string): string {
  return input
    .replace(/\|\|([^|\n]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>')
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '<i>$1</i>');
}

function restoreProtected(input: string, fragments: string[]): string {
  return input.replace(
    new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, 'g'),
    (_match, rawIndex: string) => fragments[Number(rawIndex)] ?? '',
  );
}

function safeWebHref(input: string): string | null {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function escapeTelegramHtml(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeTelegramHtmlAttribute(input: string): string {
  return escapeTelegramHtml(input).replaceAll('"', '&quot;');
}

/**
 * Produce a readable parse-free fallback. This is used only if Telegram rejects a formatted send;
 * users should never lose the answer because of one malformed provider/localization fragment.
 */
export function telegramPlainText(input: string, format: ResponseTextFormat): string {
  if (format === 'plain') return input;
  const html = format === 'html' ? input : markdownToTelegramHtml(input);
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_match, value: string) =>
      String.fromCodePoint(Number.parseInt(value, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) =>
      String.fromCodePoint(Number.parseInt(value, 16)),
    )
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** Preserve a complete long answer while staying below Telegram's 4096-character text limit. */
export function splitTelegramText(text: string, maxChars = 3_900): string[] {
  const remaining = text.trim();
  if (!remaining) return [];
  const chunks: string[] = [];
  let rest = remaining;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const candidates = [
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf(' '),
    ];
    const splitAt = candidates.find((index) => index >= Math.floor(maxChars * 0.55)) ?? maxChars;
    const includePunctuation = window.slice(splitAt, splitAt + 2) === '. ' ? 1 : 0;
    const chunk = rest.slice(0, splitAt + includePunctuation).trim();
    chunks.push(chunk || rest.slice(0, maxChars));
    rest = rest.slice(splitAt + includePunctuation).trimStart();
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

/**
 * Split Markdown while balancing fenced code blocks across chunks. Inline formatting is local to
 * each chunk, but a long code sample remains a valid `<pre>` entity instead of leaking backticks.
 */
export function splitTelegramMarkdown(text: string, maxChars = 3_900): string[] {
  const sourceChunks = splitTelegramText(text, Math.max(64, maxChars - 8));
  const chunks: string[] = [];
  let insideFence = false;

  for (const source of sourceChunks) {
    const startsInsideFence = insideFence;
    const fenceCount = (source.match(/^\s*```[^\n]*$/gm) ?? []).length;
    insideFence = fenceCount % 2 === 1 ? !insideFence : insideFence;
    chunks.push(`${startsInsideFence ? '```\n' : ''}${source}${insideFence ? '\n```' : ''}`.trim());
  }

  return chunks;
}
