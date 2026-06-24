import type { CommandResponse } from '../../../domain/types.js';
import type { Services } from '../../../services/index.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';
import { selectImageProfile, type ImageProfile } from '../../../providers/image/stableDiffusion.js';

const MINOR_RE =
  /\b(child|children|minor|underage|under-aged|loli|shota|toddler|infant|preteen)\b/i;

/** /genera <prompt> - generate an original image with the configured Stable Diffusion backend. */
export const imageCommand: CommandSpec = {
  command: 'genera',
  aliases: ['image', 'img'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, context, args }: HandlerInput): Promise<CommandResponse | null> {
    return generate(services, context.chatId, args, undefined);
  },
};

/** /disegna <prompt> - force the PonyXL manga workflow. */
export const drawCommand: CommandSpec = {
  command: 'disegna',
  aliases: ['draw'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, context, args }: HandlerInput): Promise<CommandResponse | null> {
    return generate(services, context.chatId, args, 'manga');
  },
};

async function generate(
  services: Services,
  chatId: number,
  args: string[],
  profile: ImageProfile | undefined,
): Promise<CommandResponse> {
  const prompt = args.join(' ').trim();
  if (!prompt) return { text: 'image_needs_prompt' };
  if (MINOR_RE.test(prompt)) {
    return { text: 'image_minor_refused' };
  }
  const quota = await services.quota.reserve(chatId, 'image');
  if (!quota.allowed) {
    return {
      text: 'group_quota_exceeded',
      vars: { reason: quota.reason ?? 'image', retry_after: 0 },
    };
  }
  const model = await services.modelForChat(chatId);
  const prepared = await services.imagePrompts.prepare(prompt, {
    ...(profile ? { profile } : {}),
    ...(model ? { model } : {}),
  });
  const poseReference = prepared.poseReferenceQuery
    ? await services.imageFinder.findPoseReference(prepared.poseReferenceQuery)
    : null;
  const image = await services.media.generateImage(prepared.prompt, {
    ...(profile ? { profile } : {}),
    ...(poseReference ? { poseReference: poseReference.buffer } : {}),
  });
  if (!image?.buffer) {
    return { text: 'image_unavailable' };
  }
  return {
    text: 'image_done',
    vars: { prompt: prompt.slice(0, 180) },
    imageBuffer: image.buffer,
    imageSpoiler: selectImageProfile(prompt) === 'nsfw',
  };
}
