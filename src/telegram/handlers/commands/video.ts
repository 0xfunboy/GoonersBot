import type { CommandResponse } from '../../../domain/types.js';
import type { Services } from '../../../services/index.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';
import { selectImageProfile } from '../../../providers/image/stableDiffusion.js';
import { VideoRateLimitError } from '../../../providers/video/agnes.js';
import { prepareVideoForTelegram } from '../../../providers/video/prepare.js';
import { childLogger } from '../../../utils/logger.js';
import { renderSocialContext } from '../../../social/index.js';
import { containsMinorMediaReference, MediaSafetyError } from '../../../safety/mediaSafety.js';

const log = childLogger('cmd-video');

/**
 * /genvid <prompt> - generate a short clip with the remote text-to-video model.
 * Aliases cover the ways people actually ask for it in chat.
 */
export const videoCommand: CommandSpec = {
  command: 'genvid',
  aliases: ['video', 'genvideo', 'generavideo', 'vid', 'clip', 'animazione', 'genclip'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, context, person, args }: HandlerInput): Promise<CommandResponse | null> {
    return generateVideo(services, context.chatId, args.join(' ').trim(), person.userHandle);
  },
};

/** Shared by the command and the cortex `video_gen` tool. */
export async function generateVideo(
  services: Services,
  chatId: number,
  prompt: string,
  creatorHandle?: string,
): Promise<CommandResponse> {
  if (!prompt) return { text: 'video_needs_prompt' };
  if (containsMinorMediaReference(prompt)) return { text: 'image_minor_refused' };
  if (!services.video.enabled) return { text: 'video_unavailable' };

  // A clip is expensive: it spends the group's generated-image budget.
  const quota = await services.quota.reserve(chatId, 'image');
  if (!quota.allowed) {
    return {
      text: 'group_quota_exceeded',
      vars: { reason: quota.reason ?? 'video', retry_after: 0 },
    };
  }

  try {
    const [social, history, model] = await Promise.all([
      services.social.getContext(chatId, {
        focusHandles: creatorHandle ? [creatorHandle] : [],
        maxMembers: 10,
        maxJokes: 2,
      }),
      services.conversation.getRecent(chatId),
      services.modelForChat(chatId),
    ]);
    const socialContext = renderSocialContext(social);
    const videoPrompt = await services.videoPrompts.prepare(prompt, {
      ...(model ? { model } : {}),
      context: {
        ...(creatorHandle ? { creatorHandle } : {}),
        intent: prompt,
        relevantLore: socialContext ? [socialContext.slice(0, 1_200)] : [],
        recentMessages: history.slice(-6).map((message) => ({
          handle: message.handle,
          text: message.message.messageText ?? '',
        })),
      },
    });
    const clip = await services.video.generate(videoPrompt.prompt);
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
      videoSpoiler: videoPrompt.profile === 'nsfw' || selectImageProfile(prompt) === 'nsfw',
      usage: { imageCalls: 1 },
    };
  } catch (err) {
    if (err instanceof MediaSafetyError) return { text: 'image_minor_refused' };
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
