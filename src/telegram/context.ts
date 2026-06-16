import type { Context } from 'grammy';
import type { ChatContext, IncomingMessage, Person } from '../domain/types.js';
import { fallbackHandle, normalizeHandle } from '../utils/handles.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('tg-context');

const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20MB safety cap on downloads

export function buildPerson(ctx: Context): Person | null {
  const from = ctx.from;
  if (!from) return null;
  const handle = from.username ? normalizeHandle(from.username) : fallbackHandle(from.id);
  const person: Person = {
    telegramId: from.id,
    userHandle: handle,
  };
  if (from.first_name) person.firstName = from.first_name;
  if (from.last_name) person.lastName = from.last_name;
  if (from.is_premium !== undefined) person.isPremium = from.is_premium;
  return person;
}

/** True if the bot is addressed: private chat, reply-to-bot, or @mention in text. */
export function isBotAddressed(
  ctx: Context,
  botUsername: string,
): { mentioned: boolean; replyToBot: boolean } {
  const msg = ctx.message;
  if (!msg) return { mentioned: false, replyToBot: false };
  const isPrivate = ctx.chat?.type === 'private';
  const text = msg.text ?? msg.caption ?? '';
  const mentionTag = `@${botUsername.replace(/^@/, '')}`;
  const hasMention = text.toLowerCase().includes(mentionTag.toLowerCase());
  const replyToBot =
    msg.reply_to_message?.from?.is_bot === true &&
    msg.reply_to_message.from.username?.toLowerCase() ===
      botUsername.replace(/^@/, '').toLowerCase();
  return { mentioned: isPrivate || hasMention || replyToBot, replyToBot };
}

export async function isGroupAdmin(ctx: Context): Promise<boolean> {
  if (ctx.chat?.type === 'private') return true;
  if (!ctx.chat || !ctx.from) return false;
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return member.status === 'administrator' || member.status === 'creator';
  } catch (err) {
    log.warn({ err }, 'getChatMember failed; treating as non-admin');
    return false;
  }
}

export async function buildChatContext(
  ctx: Context,
  botUsername: string,
): Promise<ChatContext | null> {
  const chat = ctx.chat;
  if (!chat) return null;
  const { mentioned, replyToBot } = isBotAddressed(ctx, botUsername);
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const repliedUsername = ctx.message?.reply_to_message?.from?.username;

  const text = ctx.message?.text ?? ctx.message?.caption ?? '';
  const out: ChatContext = {
    chatId: chat.id,
    isGroup,
    isBotMentioned: mentioned,
    isGroupAdmin: await isGroupAdmin(ctx),
    isReplyToBot: replyToBot,
    mentionedHandles: extractMentions(text),
  };
  if ('title' in chat && chat.title) out.chatName = chat.title;
  if (ctx.message?.message_thread_id !== undefined) out.threadId = ctx.message.message_thread_id;
  if (ctx.message?.message_id !== undefined) out.messageId = ctx.message.message_id;
  if (repliedUsername) out.repliedToUserHandle = normalizeHandle(repliedUsername);
  if (ctx.message?.reply_to_message?.message_id !== undefined) {
    out.repliedToMessageId = ctx.message.reply_to_message.message_id;
  }
  return out;
}

/** Extract @handles mentioned in message text (excludes bare @). */
export function extractMentions(text: string): string[] {
  const matches = text.match(/@[A-Za-z0-9_]{3,}/g) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

/** Download a Telegram file by file_id into a Buffer (with size cap). */
async function downloadFile(ctx: Context, fileId: string): Promise<Buffer | null> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (file.file_size && file.file_size > MAX_MEDIA_BYTES) {
      log.warn({ size: file.file_size }, 'media exceeds size cap; skipping download');
      return null;
    }
    const token = ctx.api.token;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch (err) {
    log.warn({ err }, 'file download failed');
    return null;
  }
}

/**
 * Build the IncomingMessage. Image is downloaded only when the bot is addressed; voice is
 * downloaded per `opts.voice` (so STT can transcribe passive voice notes when enabled).
 */
export async function buildIncomingMessage(
  ctx: Context,
  opts: { image: boolean; voice: boolean },
): Promise<IncomingMessage> {
  const msg = ctx.message;
  const text = msg?.text ?? msg?.caption ?? '';
  const timestamp = msg?.date ? new Date(msg.date * 1000) : new Date();

  const out: IncomingMessage = { messageText: text, timestamp };

  if (opts.image && msg?.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    if (largest) {
      const buf = await downloadFile(ctx, largest.file_id);
      if (buf) {
        out.imageBuffer = buf;
        out.imageMime = 'image/jpeg';
      }
    }
  }
  if (opts.voice && msg?.voice) {
    const buf = await downloadFile(ctx, msg.voice.file_id);
    if (buf) {
      out.audioBuffer = buf;
      out.audioMime = msg.voice.mime_type ?? 'audio/ogg';
    }
  }
  return out;
}
