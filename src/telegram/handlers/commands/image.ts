import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';

const MINOR_RE =
  /\b(child|children|minor|underage|under-aged|loli|shota|toddler|infant|preteen)\b/i;

/** /image <prompt> - generate an original image with the configured Stable Diffusion backend. */
export const imageCommand: CommandSpec = {
  command: 'image',
  aliases: ['img', 'genera'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, args }: HandlerInput): Promise<CommandResponse | null> {
    const prompt = args.join(' ').trim();
    if (!prompt) return { rawText: 'Dimmi cosa devo generare: /image <prompt>' };
    if (MINOR_RE.test(prompt))
      return { rawText: 'No: niente immagini sessualizzate o ambigue con minori.' };
    const image = await services.media.generateImage(prompt);
    if (!image?.buffer)
      return { rawText: 'Generatore immagini non disponibile adesso. Riprova tra poco.' };
    return { rawText: `Fatto: ${prompt.slice(0, 180)}`, imageBuffer: image.buffer };
  },
};
