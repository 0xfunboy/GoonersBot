import type { ExtractedMediaPost, PostStats } from './types.js';

export const SOCIAL_CAPTION_MAX_LENGTH = 1000;

const STAT_KEYS = [
  'likes',
  'reposts',
  'shares',
  'replies',
  'comments',
  'views',
  'score',
] as const satisfies readonly (keyof PostStats)[];

/** Normalize untrusted social text without interpreting Markdown or HTML. */
export function cleanSocialText(value: unknown, maxLength = 20_000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = replaceControlCharacters(value.replace(/\r\n?/g, '\n'))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? `${cleaned.slice(0, Math.max(0, maxLength - 1))}…` : cleaned;
}

function replaceControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result +=
      (code < 32 && character !== '\n' && character !== '\t') || code === 127 ? ' ' : character;
  }
  return result;
}

function validCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/** Merge platform metadata without allowing a weaker fallback to overwrite native API values. */
export function mergePostStats(
  preferred: PostStats | undefined,
  fallback: PostStats | undefined,
): PostStats | undefined {
  const merged: PostStats = {};
  for (const key of STAT_KEYS) {
    const value = validCount(preferred?.[key]) ?? validCount(fallback?.[key]);
    if (value !== undefined) merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function formatPostStats(stats: PostStats | undefined): string {
  if (!stats) return '';
  const parts: string[] = [];
  const likes = validCount(stats.likes);
  const reshares = validCount(stats.reposts) ?? validCount(stats.shares);
  const discussion = validCount(stats.comments) ?? validCount(stats.replies);
  const views = validCount(stats.views);
  const score = validCount(stats.score);
  if (likes !== undefined) parts.push(`❤ ${compactCount(likes)}`);
  if (reshares !== undefined) parts.push(`🔁 ${compactCount(reshares)}`);
  if (discussion !== undefined) parts.push(`💬 ${compactCount(discussion)}`);
  if (views !== undefined) parts.push(`👁 ${compactCount(views)}`);
  if (score !== undefined) parts.push(`⬆ ${compactCount(score)}`);
  return parts.join('  ');
}

/**
 * Produce the Telegram caption deterministically from extractor/download metadata. The engagement
 * and author suffix is budgeted first, so a long description cannot hide the requested counts.
 */
export function buildSocialCaption(
  post: Pick<
    ExtractedMediaPost,
    'title' | 'description' | 'author' | 'authorHandle' | 'caption' | 'stats'
  >,
  maxLength = SOCIAL_CAPTION_MAX_LENGTH,
): string | undefined {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) return undefined;

  const title = cleanSocialText(post.title, 2_000);
  const description = cleanSocialText(post.description);
  const legacyCaption = cleanSocialText(post.caption);
  const author = normalizeAuthor(post.author);
  const handle = normalizeHandle(post.authorHandle);
  const authorLine = formatAuthor(author, handle);
  const statsLine = formatPostStats(post.stats);

  const bodyLines: string[] = [];
  if (title && (!description || !substantiallyDuplicates(title, description))) {
    bodyLines.push(title);
  }
  if (description) bodyLines.push(description);
  if (bodyLines.length === 0 && legacyCaption) bodyLines.push(legacyCaption);

  const suffix = [authorLine, statsLine].filter(Boolean).join('\n');
  const suffixCost = suffix ? suffix.length + (bodyLines.length > 0 ? 1 : 0) : 0;
  const bodyBudget = Math.max(0, maxLength - suffixCost);
  const body = truncate(bodyLines.join('\n').trim(), bodyBudget);
  const caption = [body, suffix].filter(Boolean).join('\n').trim();
  return caption ? caption.slice(0, maxLength) : undefined;
}

function normalizeHandle(value: unknown): string | undefined {
  const handle = cleanSocialText(value, 200);
  if (!handle) return undefined;
  const withoutMarker = handle.replace(/^@+/, '').trim();
  return withoutMarker ? neutralizeTelegramMentions(withoutMarker) : undefined;
}

function normalizeAuthor(value: unknown): string | undefined {
  const author = cleanSocialText(value, 300);
  if (!author) return undefined;
  const externalHandle = author.replace(/^@+/, '').trim();
  if (externalHandle !== author) {
    return externalHandle ? `social: ${neutralizeTelegramMentions(externalHandle)}` : undefined;
  }
  return neutralizeTelegramMentions(author);
}

/** Telegram auto-links ASCII @names even when no parse mode is enabled. */
function neutralizeTelegramMentions(value: string): string {
  return value.replace(/@(?=[A-Za-z0-9_])/g, '＠');
}

function formatAuthor(author: string | undefined, handle: string | undefined): string {
  if (!author && !handle) return '';
  if (!author) return `👤 social: ${handle}`;
  if (
    !handle ||
    (author.toLowerCase().startsWith('social: ') &&
      author.toLowerCase().slice('social: '.length) === handle.toLowerCase())
  ) {
    return `👤 ${author}`;
  }
  return `👤 ${author} (social: ${handle})`;
}

function substantiallyDuplicates(left: string, right: string): boolean {
  const normalizedLeft = left.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedRight = right.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight || normalizedRight.includes(normalizedLeft);
}

function truncate(value: string, maxLength: number): string {
  if (maxLength < 1) return '';
  if (value.length <= maxLength) return value;
  if (maxLength === 1) return '…';
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function compactCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(value);
}
