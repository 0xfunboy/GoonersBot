import type { CommandResponse } from '../../../domain/types.js';
import type { Services } from '../../../services/index.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';
import type { ImageProfile } from '../../../providers/image/stableDiffusion.js';
import { renderSocialContext } from '../../../social/index.js';
import { containsMinorMediaReference } from '../../../safety/mediaSafety.js';
import { MediaSafetyError } from '../../../safety/mediaSafety.js';
import type { PreparedImagePrompt } from '../../../services/imagePrompt.js';

import {
  cacheGeneratedImagePrompt,
  buildImagePlaygroundRows,
} from '../../../services/imagePromptCache.js';
import { ImageProgressReporter } from '../../imageProgress.js';

/** /genera <prompt> - generate an original image with the configured Stable Diffusion backend. */
export const imageCommand: CommandSpec = {
  command: 'genera',
  aliases: ['image', 'img'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, context, person, args, api }: HandlerInput): Promise<CommandResponse | null> {
    return generate(services, context.chatId, args, undefined, person.userHandle, api, context.messageId);
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
  async handle({ services, context, person, args, api }: HandlerInput): Promise<CommandResponse | null> {
    return generate(services, context.chatId, args, 'manga', person.userHandle, api, context.messageId);
  },
};

async function generate(
  services: Services,
  chatId: number,
  args: string[],
  profile: ImageProfile | undefined,
  creatorHandle?: string,
  api?: import('grammy').Api,
  messageId?: number,
): Promise<CommandResponse> {
  let requestedModel: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    if (
      (current === '--model' || current === '-m' || current === '--checkpoint') &&
      args[i + 1]
    ) {
      requestedModel = args[i + 1];
      i += 1;
    } else {
      filteredArgs.push(current ?? '');
    }
  }
  const prompt = filteredArgs.join(' ').trim();
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
  const chatNsfwMode = await services.storage.chats.getNsfwMode(
    chatId,
    services.config.env.LLM_NSFW_DEFAULT_MODE,
  );
  const nsfwEnabled = chatNsfwMode !== 'off';
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

  let progressReporter: ImageProgressReporter | null = null;
  if (api) {
    progressReporter = new ImageProgressReporter({
      api,
      chatId,
      replyToMessageId: messageId,
      initialPrompt: prompt,
      prefix: "Sto generando un'immagine",
    });
    await progressReporter.start(prompt);
  }

  let prepared: PreparedImagePrompt;
  try {
    prepared = await services.imagePrompts.prepare(prompt, {
      ...(profile ? { profile } : {}),
      ...(requestedModel ? { model: requestedModel } : model ? { model } : {}),
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
    await progressReporter?.update(15, prepared.prompt, 'Avvio generazione...');
  } catch (error) {
    await progressReporter?.delete();
    if (error instanceof MediaSafetyError) return { text: 'image_minor_refused' };
    throw error;
  }
  const poseLookup = prepared.poseReferenceQuery
    ? await services.imageFinder.findPoseReferenceWithUsage(prepared.poseReferenceQuery)
    : { image: null, visionCalls: 0 };
  const poseReference = poseLookup.image;

  try {
    const image = await services.media.generateImage(prepared.prompt, {
      profile: profile ?? prepared.profile,
      model: requestedModel,
      medium: prepared.medium,
      rating: prepared.rating,
      negativePrompt: prepared.negativePrompt,
      providerPrompts: prepared.providerPrompts,
      qualityBrief: prepared.qualityBrief,
      expectsPeople: prepared.expectsPeople,
      preferredProvider: 'pony',
      aspectRatio: prepared.aspectRatio,
      nsfwEnabled,
      ...(poseReference ? { poseReference: poseReference.buffer } : {}),
      onProgress: async (percent, stage) => {
        await progressReporter?.update(percent, prepared.prompt, stage);
      },
    });
    await progressReporter?.delete();
    if (!image?.buffer) {
      return { text: 'image_unavailable' };
    }
    const promptId = cacheGeneratedImagePrompt({
      prompt: prepared.prompt,
      profile: profile ?? prepared.profile,
      aspectRatio: prepared.aspectRatio as '16:9' | '9:16' | '1:1' | undefined,
      medium: prepared.medium,
      rating: prepared.rating,
      negativePrompt: prepared.negativePrompt,
    });

    return {
      rawText: '',
      imageBuffer: image.buffer,
      imageSpoiler: prepared.rating !== 'safe',
      customInlineKeyboard: buildImagePlaygroundRows(promptId),
      usage: {
        imageCalls: image.generationAttempts ?? 1,
        visionCalls: poseLookup.visionCalls + (image.qaVisionCalls ?? 0),
      },
    };
  } catch (err) {
    await progressReporter?.delete();
    throw err;
  }
}
