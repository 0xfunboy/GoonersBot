import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';
import { escapeHtml } from '../../../utils/text.js';

function captionFor(
  title: string,
  url: string,
  truncated: boolean,
  truncationLabel: string,
): string {
  const head = url ? `🎵 <a href="${url}">${escapeHtml(title)}</a>` : `🎵 ${escapeHtml(title)}`;
  const tail = truncated ? `\n(${truncationLabel})` : '';
  return head + tail;
}

/** Shared handler for /play and /sing: resolve a query to a YouTube audio voice note. */
async function handleMusic({
  services,
  context,
  args,
}: HandlerInput): Promise<CommandResponse | null> {
  if (!services.music.enabled) return { text: 'music_unavailable' };

  // query from command args, else the text of the message being replied to
  let query = args.join(' ').trim();
  if (!query && context.repliedToText) query = context.repliedToText.trim();
  if (!query) return { text: 'music_none' };

  const quota = await services.quota.reserve(context.chatId, 'media');
  if (!quota.allowed) {
    return {
      text: 'group_quota_exceeded',
      vars: { reason: quota.reason ?? 'media', retry_after: 0 },
    };
  }

  const result = await services.music.fetch(query);
  if (!result) return { text: 'music_not_found', vars: { query } };

  const language = await services.getLanguage(context.chatId);
  return {
    audioBuffer: result.ogg,
    rawText: captionFor(
      result.title,
      result.url,
      result.truncated,
      services.localizer.t(
        'music_truncated',
        { minutes: Math.round(services.config.music.maxDurationSeconds / 60) },
        language,
      ) ?? 'music_truncated',
    ),
  };
}

/**
 * /play (alias /suona /riproduci /reproduce) - search YouTube for the query, extract the audio
 * (up to MUSIC_MAX_DURATION_SECONDS) and send it as a voice note.
 */
export const playCommand: CommandSpec = {
  command: 'play',
  aliases: ['suona', 'riproduci', 'reproduce'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  handle: handleMusic,
};

/** /sing (alias /canta /cantami /cantame) - same as /play, phrased for songs. */
export const singCommand: CommandSpec = {
  command: 'sing',
  aliases: ['canta', 'cantami', 'cantame'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  handle: handleMusic,
};
