import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';

/**
 * /voice — turn a message into a voice note.
 *   - as a reply to a message: voices THAT message's text.
 *   - alone: voices the most recent message in the chat.
 */
export const voiceCommand: CommandSpec = {
  command: 'voice',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    if (!services.tts.enabled) return { text: 'voice_unavailable' };

    const source = context.repliedToMessageId
      ? await services.storage.messages.findByMessageId(context.chatId, context.repliedToMessageId)
      : await services.storage.messages.getLatest(context.chatId);

    const text = source?.message.messageText?.trim();
    if (!text) return { text: 'voice_none' };

    const ogg = await services.tts.synth(text);
    if (!ogg) return { text: 'voice_failed' };
    const resp: CommandResponse = { audioBuffer: ogg };
    return resp;
  },
};
