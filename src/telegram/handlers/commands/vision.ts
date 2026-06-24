import type { CommandResponse, IncomingMessage } from '../../../domain/types.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';

/** /vision (Italian: /visione) - describe an attached or replied-to image/video. */
export const visionCommand: CommandSpec = {
  command: 'vision',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, message }: HandlerInput): Promise<CommandResponse> {
    const visual = await resolveVisual(services.media, message);
    if (!visual) return { text: 'vision_usage' };

    const description = await services.media.describeImage(visual.buffer, visual.mime);
    if (!description) return { text: 'vision_unavailable' };
    return { text: 'vision_result', vars: { description } };
  },
};

async function resolveVisual(
  media: HandlerInput['services']['media'],
  message: IncomingMessage,
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (message.imageBuffer) {
    return { buffer: message.imageBuffer, mime: message.imageMime ?? 'image/jpeg' };
  }
  if (message.repliedImageBuffer) {
    return { buffer: message.repliedImageBuffer, mime: message.repliedImageMime ?? 'image/jpeg' };
  }
  const video = message.videoBuffer ?? message.repliedVideoBuffer;
  if (!video) return null;
  const frame = await media.frameFromVideo(video);
  return frame ? { buffer: frame, mime: 'image/jpeg' } : null;
}
