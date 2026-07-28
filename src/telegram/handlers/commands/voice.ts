import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';

/**
 * /voice - turn a message into a voice note.
 *   - as a reply to a message: voices THAT message's text.
 *   - alone: voices the most recent message in the chat.
 */
export const voiceCommand: CommandSpec = {
  command: 'voice',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, context }) {
    if (!services.tts.enabled) return { text: 'voice_unavailable' };

    // Telegram already includes replied text/captions in the update. Prefer it so /voice works
    // even when conversation tracking was disabled and the replied message is absent from Mongo.
    let text = context.repliedToText?.trim();
    if (!text) {
      const source = context.repliedToMessageId
        ? await services.storage.messages.findByMessageId(
            context.chatId,
            context.repliedToMessageId,
          )
        : await services.storage.messages.getLatest(context.chatId);
      text = source?.message.messageText?.trim();
    }
    if (!text) return { text: 'voice_none' };

    const language = await services.getLanguage(context.chatId);
    const ogg = await services.tts.synth(text, language);
    if (!ogg) return { text: 'voice_failed' };
    const resp: CommandResponse = { audioBuffer: ogg };
    return resp;
  },
};
