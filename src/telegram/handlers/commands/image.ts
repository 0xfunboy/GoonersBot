import type { CommandResponse } from '../../../domain/types.js';
import type { Services } from '../../../services/index.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';
import type { ImageProfile } from '../../../providers/image/stableDiffusion.js';

const MINOR_RE =
  /\b(child|children|minor|underage|under-aged|loli|shota|toddler|infant|preteen)\b/i;

/** /genera <prompt> - generate an original image with the configured Stable Diffusion backend. */
export const imageCommand: CommandSpec = {
  command: 'genera',
  aliases: ['image', 'img'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, args }: HandlerInput): Promise<CommandResponse | null> {
    return generate(services, args, undefined, '/genera');
  },
};

/** /disegna <prompt> - force the PonyXL manga workflow. */
export const drawCommand: CommandSpec = {
  command: 'disegna',
  aliases: ['draw'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, args }: HandlerInput): Promise<CommandResponse | null> {
    return generate(services, args, 'manga', '/disegna');
  },
};

async function generate(
  services: Services,
  args: string[],
  profile: ImageProfile | undefined,
  command: string,
): Promise<CommandResponse> {
  const prompt = args.join(' ').trim();
  if (!prompt) return { rawText: `Dimmi cosa devo generare: ${command} <prompt>` };
  if (MINOR_RE.test(prompt)) {
    return { rawText: 'No: niente immagini sessualizzate o ambigue con minori.' };
  }
  const prepared = await services.imagePrompts.prepare(prompt, profile ? { profile } : {});
  const poseReference = prepared.poseReferenceQuery
    ? await services.imageFinder.findPoseReference(prepared.poseReferenceQuery)
    : null;
  const image = await services.media.generateImage(prepared.prompt, {
    ...(profile ? { profile } : {}),
    ...(poseReference ? { poseReference: poseReference.buffer } : {}),
  });
  if (!image?.buffer) {
    return { rawText: 'Generatore immagini non disponibile adesso. Riprova tra poco.' };
  }
  return { rawText: `Fatto: ${prompt.slice(0, 180)}`, imageBuffer: image.buffer };
}
