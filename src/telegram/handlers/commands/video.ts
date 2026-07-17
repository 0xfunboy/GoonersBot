import type { CommandResponse } from '../../../domain/types.js';
import type { Services } from '../../../services/index.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';
import { selectImageProfile } from '../../../providers/image/stableDiffusion.js';
import { VideoRateLimitError } from '../../../providers/video/agnes.js';
import { prepareVideoForTelegram } from '../../../providers/video/prepare.js';
import { childLogger } from '../../../utils/logger.js';

const log = childLogger('cmd-video');

const MINOR_RE = /\b(child|children|minor|underage|under-aged|loli|shota|toddler|infant|preteen)\b/i;

/**
 * /genvid <prompt> - generate a short clip with the remote text-to-video model.
 * Aliases cover the ways people actually ask for it in chat.
 */
export const videoCommand: CommandSpec = {
  command: 'genvid',
  aliases: ['video', 'genvideo', 'generavideo', 'vid', 'clip', 'animazione', 'genclip'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, context, args }: HandlerInput): Promise<CommandResponse | null> {
    return generateVideo(services, context.chatId, args.join(' ').trim());
  },
};

/** Shared by the command and the cortex `video_gen` tool. */
export async function generateVideo(
  services: Services,
  chatId: number,
  prompt: string,
): Promise<CommandResponse> {
  if (!prompt) return { text: 'video_needs_prompt' };
  if (MINOR_RE.test(prompt)) return { text: 'image_minor_refused' };
  if (!services.video.enabled) return { text: 'video_unavailable' };

  // A clip is expensive: it spends the group's generated-image budget.
  const quota = await services.quota.reserve(chatId, 'image');
  if (!quota.allowed) {
    return { text: 'group_quota_exceeded', vars: { reason: quota.reason ?? 'video', retry_after: 0 } };
  }

  try {
    const clip = await services.video.generate(prompt);
    const prepared = await prepareVideoForTelegram(
      clip.buffer,
      services.config.linkMedia.ffmpegBin,
    );
    const meta = {
      ...(prepared.width !== undefined ? { width: prepared.width } : {}),
      ...(prepared.height !== undefined ? { height: prepared.height } : {}),
      duration: prepared.duration ?? clip.seconds,
      ...(prepared.thumbnail ? { thumbnail: prepared.thumbnail } : {}),
    };
    return {
      text: 'video_done',
      vars: { prompt: prompt.slice(0, 180) },
      videoBuffer: prepared.buffer,
      videoMeta: meta,
      videoSpoiler: selectImageProfile(prompt) === 'nsfw',
    };
  } catch (err) {
    if (err instanceof VideoRateLimitError) {
      return {
        text: 'video_rate_limited',
        vars: { seconds: Math.ceil(err.retryAfterMs / 1000) },
      };
    }
    log.warn({ err }, 'video generation failed');
    return { text: 'video_failed' };
  }
}
