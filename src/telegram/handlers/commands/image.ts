import type { CommandResponse } from '../../../domain/types.js';
import type { Services } from '../../../services/index.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';
import type { ImageProfile } from '../../../providers/image/stableDiffusion.js';
import { renderSocialContext } from '../../../social/index.js';
import { containsMinorMediaReference } from '../../../safety/mediaSafety.js';
import { MediaSafetyError } from '../../../safety/mediaSafety.js';
import type { PreparedImagePrompt } from '../../../services/imagePrompt.js';

/** /genera <prompt> - generate an original image with the configured Stable Diffusion backend. */
export const imageCommand: CommandSpec = {
  command: 'genera',
  aliases: ['image', 'img'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, context, person, args }: HandlerInput): Promise<CommandResponse | null> {
    return generate(services, context.chatId, args, undefined, person.userHandle);
  },
};

/** /disegna <prompt> - force manga planning/style while retaining capability-aware routing. */
export const drawCommand: CommandSpec = {
  command: 'disegna',
  aliases: ['draw'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, context, person, args }: HandlerInput): Promise<CommandResponse | null> {
    return generate(services, context.chatId, args, 'manga', person.userHandle);
  },
};

async function generate(
  services: Services,
  chatId: number,
  args: string[],
  profile: ImageProfile | undefined,
  creatorHandle?: string,
): Promise<CommandResponse> {
  const prompt = args.join(' ').trim();
  if (!prompt) return { text: 'image_needs_prompt' };
  if (containsMinorMediaReference(prompt)) {
    return { text: 'image_minor_refused' };
  }
  const quota = await services.quota.reserve(chatId, 'image');
  if (!quota.allowed) {
    return {
      text: 'group_quota_exceeded',
      vars: {
        reason: quota.reason ?? 'image',
        retry_after: quota.retryAfterSeconds ?? 0,
      },
    };
  }
  const model = await services.modelForChat(chatId);
  const mentionedHandles = [...prompt.matchAll(/@([A-Za-z0-9_]{2,})/g)].map(
    (match) => match[1] ?? '',
  );
  const focusHandles = [
    ...new Set([creatorHandle, ...mentionedHandles].filter(Boolean)),
  ] as string[];
  const [social, history] = await Promise.all([
    services.social.getContext(chatId, {
      focusHandles,
      maxMembers: 10,
      maxJokes: 2,
    }),
    services.conversation.getRecent(chatId),
  ]);
  const socialContext = renderSocialContext(social);
  let prepared: PreparedImagePrompt;
  try {
    prepared = await services.imagePrompts.prepare(prompt, {
      ...(profile ? { profile } : {}),
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
  } catch (error) {
    if (error instanceof MediaSafetyError) return { text: 'image_minor_refused' };
    throw error;
  }
  const poseLookup = prepared.poseReferenceQuery
    ? await services.imageFinder.findPoseReferenceWithUsage(prepared.poseReferenceQuery)
    : { image: null, visionCalls: 0 };
  const poseReference = poseLookup.image;
  const image = await services.media.generateImage(prepared.prompt, {
    profile: profile ?? prepared.profile,
    medium: prepared.medium,
    rating: prepared.rating,
    negativePrompt: prepared.negativePrompt,
    providerPrompts: prepared.providerPrompts,
    qualityBrief: prepared.qualityBrief,
    expectsPeople: prepared.expectsPeople,
    preferredProvider: prepared.preferredProvider,
    aspectRatio: prepared.aspectRatio,
    ...(poseReference ? { poseReference: poseReference.buffer } : {}),
  });
  if (!image?.buffer) {
    return { text: 'image_unavailable' };
  }
  return {
    text: 'image_done',
    vars: { prompt: prompt.slice(0, 180) },
    imageBuffer: image.buffer,
    imageSpoiler: prepared.rating !== 'safe',
    usage: {
      imageCalls: image.generationAttempts ?? 1,
      visionCalls: poseLookup.visionCalls + (image.qaVisionCalls ?? 0),
    },
  };
}
