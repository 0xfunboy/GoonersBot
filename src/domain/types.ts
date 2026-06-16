/**
 * Platform-agnostic domain types. The Telegram adapter builds these from grammY updates;
 * services and handlers only ever see these (never raw grammY objects). This preserves the
 * original project's deliberately portable core.
 */

/** A person interacting with the bot (group member or DM user). */
export interface Person {
  telegramId: number;
  /** normalized handle, always starts with '@'; falls back to '@id<telegramId>' if no username */
  userHandle: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  isPremium?: boolean | undefined;
}

/** The chat context an interaction happens in. */
export interface ChatContext {
  chatId: number;
  chatName?: string | undefined;
  threadId?: number | undefined;
  /** id of the triggering message (when available) */
  messageId?: number | undefined;
  isGroup: boolean;
  isBotMentioned: boolean;
  isGroupAdmin: boolean;
  /** handle of the user whose message was replied to, if any */
  repliedToUserHandle?: string | undefined;
  /** id of the replied-to message, if any (used for reply-centered /fact and /forget) */
  repliedToMessageId?: number | undefined;
  /** @handles mentioned in the message text */
  mentionedHandles?: string[] | undefined;
  /** true when the replied-to message was authored by the bot */
  isReplyToBot: boolean;
}

/** A raw incoming message with optional media buffers (downloaded only when relevant). */
export interface IncomingMessage {
  messageText: string;
  timestamp: Date;
  imageBuffer?: Buffer | undefined;
  imageMime?: string | undefined;
  audioBuffer?: Buffer | undefined;
  audioMime?: string | undefined;
  /** photo from the replied-to message (for "who/what is this image" reverse-image lookups) */
  repliedImageBuffer?: Buffer | undefined;
  repliedImageMime?: string | undefined;
}

/** A message after media has been transcribed/described to text. */
export interface TranscribedMessage {
  messageText: string | null;
  timestamp: Date;
  imageDescription?: string | null;
  voiceDescription?: string | null;
}

/** The full input passed to a handler. */
export interface BotInput {
  person: Person;
  context: ChatContext;
  message: IncomingMessage;
  args: string[];
}

/** A single inline-keyboard built from id->label pairs (with pagination support). */
export interface KeyboardResponse {
  /** ordered map of value-id -> display label */
  options: Array<{ id: string; label: string }>;
  /** callback namespace used for pagination repaint */
  callback: string;
  /** action prefix encoded into each button's callback_data */
  buttonAction: string;
}

/**
 * Abstract response returned by handlers. `text` is a translation KEY (localized later),
 * unless `rawText` is set (already-final text, e.g. AI output). Mirrors the original
 * CommandResponse/LocalizedCommandResponse split.
 */
export interface CommandResponse {
  /** translation key to localize */
  text?: string | undefined;
  /** interpolation vars for the translation key */
  vars?: Record<string, string | number> | undefined;
  /** already-final text that must NOT be localized (AI output) */
  rawText?: string | undefined;
  /** image to send (url or buffer) */
  imageUrl?: string | undefined;
  imageBuffer?: Buffer | undefined;
  /** audio (TTS) to send */
  audioBuffer?: Buffer | undefined;
  keyboard?: KeyboardResponse | undefined;
}

/** A localized, render-ready response. */
export interface LocalizedResponse {
  text?: string | undefined;
  imageUrl?: string | undefined;
  imageBuffer?: Buffer | undefined;
  audioBuffer?: Buffer | undefined;
  keyboard?: KeyboardResponse | undefined;
}
