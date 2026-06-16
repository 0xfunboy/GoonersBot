import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';

/**
 * /news (alias /nuovo) - force an autonomous post NOW: a styled take on a current event (RSS) with
 * the source link, or a commented waifu/anime image. Same composer the scheduler uses on its own.
 */
export const newsCommand: CommandSpec = {
  command: 'news',
  aliases: ['nuovo'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }: HandlerInput): Promise<CommandResponse | null> {
    if (!services.autonomousPoster.enabled) return { text: 'news_unavailable' };
    const language = await services.getLanguage(context.chatId);
    const post = await services.autonomousPoster.compose(language);
    if (!post) return { text: 'news_unavailable' };
    const resp: CommandResponse = {};
    if (post.imageBuffer) resp.imageBuffer = post.imageBuffer; // text becomes the photo caption
    if (post.text) resp.rawText = post.text;
    return resp;
  },
};
