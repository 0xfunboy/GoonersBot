import type { TranscribedMessage } from '../domain/types.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import type { Storage } from '../storage/index.js';

export const BOT_LABEL = 'bot';

/**
 * Conversation memory: stores relevant messages when tracking is enabled and exposes recent
 * context for prompt building. Retention/cap are enforced by the messages repository.
 */
export class ConversationService {
  constructor(
    private readonly storage: Storage,
    private readonly maxContextMessages: number,
  ) {}

  isTrackingEnabled(chatId: number): Promise<boolean> {
    return this.storage.chats.getConversationTracker(chatId);
  }

  isStarted(chatId: number): Promise<boolean> {
    return this.storage.chats.isStarted(chatId);
  }

  addUserMessage(chatId: number, handle: string, message: TranscribedMessage): Promise<void> {
    return this.storage.messages.add(chatId, handle, false, message);
  }

  addBotMessage(chatId: number, message: TranscribedMessage): Promise<void> {
    return this.storage.messages.add(chatId, BOT_LABEL, true, message);
  }

  getRecent(chatId: number): Promise<StoredMessage[]> {
    return this.storage.messages.getRecent(chatId, this.maxContextMessages);
  }

  reset(chatId: number): Promise<void> {
    return this.storage.messages.reset(chatId);
  }

  /** Count of bot messages in the recent window (used for autoengage energy/cooldown context). */
  async recentBotReplyCount(chatId: number): Promise<number> {
    const recent = await this.getRecent(chatId);
    return recent.filter((m) => m.isBot).length;
  }
}
