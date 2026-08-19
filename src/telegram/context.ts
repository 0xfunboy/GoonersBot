import type { Context } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import type { ChatContext, IncomingMessage, MessageAttachment, Person } from '../domain/types.js';
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
  const repliedFrom = ctx.message?.reply_to_message?.from;

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
  // `ctx.message` is absent on callback queries, while `ctx.msg` resolves both ordinary and
  // callback-origin messages. Keeping the topic here is essential for resumable background jobs.
  const originMessage = ctx.msg;
  if (originMessage?.message_thread_id !== undefined)
    out.threadId = originMessage.message_thread_id;
  if (originMessage?.message_id !== undefined) out.messageId = originMessage.message_id;
  if (repliedFrom) {
    out.repliedToUserHandle = repliedFrom.username
      ? normalizeHandle(repliedFrom.username)
      : fallbackHandle(repliedFrom.id);
  }
  if (ctx.message?.reply_to_message?.message_id !== undefined) {
    out.repliedToMessageId = ctx.message.reply_to_message.message_id;
  }
  const repliedText = ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption;
  if (repliedText) out.repliedToText = repliedText;
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
  opts: { image: boolean; voice: boolean; documents?: boolean },
): Promise<IncomingMessage> {
  const msg = ctx.message;
  const rawText = msg?.text ?? msg?.caption ?? '';
  const entities = msg?.text !== undefined ? msg.entities : msg?.caption_entities;
  const text = appendTextLinkUrls(rawText, entities);
  const timestamp = msg?.date ? new Date(msg.date * 1000) : new Date();

  const out: IncomingMessage = { messageText: text, timestamp };

  // ---- current-message media ----
  if (opts.image && msg?.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const buf = largest ? await downloadFile(ctx, largest.file_id) : null;
    if (buf) {
      out.imageBuffer = buf;
      out.imageMime = 'image/jpeg';
    }
  }
  // Voice notes, audio files, videos and round video-notes all feed STT. ffmpeg extracts the
  // audio track from video containers, so the same transcription path covers every kind.
  if (opts.voice) {
    const media = msg?.voice ?? msg?.audio ?? msg?.video ?? msg?.video_note;
    if (media) {
      const buf = await downloadFile(ctx, media.file_id);
      if (buf) {
        out.audioBuffer = buf;
        out.audioMime = ('mime_type' in media && media.mime_type) || 'application/octet-stream';
        // A video also carries visual content → keep it so a frame can be extracted for vision.
        if (msg?.video || msg?.video_note) out.videoBuffer = buf;
      }
    }
  }
  if (opts.documents && msg?.document && !isAudioOrVideoDocument(msg.document.mime_type)) {
    const buf = await downloadFile(ctx, msg.document.file_id);
    if (buf) {
      out.attachments = [
        toAttachment(
          buf,
          msg.document.file_name,
          msg.document.mime_type,
          msg.document.file_size,
          'current',
        ),
      ];
    }
  }

  // ---- replied-to media (only when addressed): "chi è/cosa c'è in questo video", "cosa ha detto" ----
  const replied = msg?.reply_to_message;
  if (opts.image && replied) {
    const repliedPhoto = replied.photo;
    if (repliedPhoto && repliedPhoto.length > 0) {
      const largest = repliedPhoto[repliedPhoto.length - 1];
      const buf = largest ? await downloadFile(ctx, largest.file_id) : null;
      if (buf) {
        out.repliedImageBuffer = buf;
        out.repliedImageMime = 'image/jpeg';
      }
    }
    // video / round video-note / gif-like animation / a video document sent as a file
    const repliedDoc = replied.document;
    const repliedDocVideo =
      repliedDoc && /^video\//.test(repliedDoc.mime_type ?? '') ? repliedDoc : undefined;
    const repliedVideo =
      replied.video ?? replied.video_note ?? replied.animation ?? repliedDocVideo;
    if (repliedVideo) {
      const buf = await downloadFile(ctx, repliedVideo.file_id);
      if (buf) out.repliedVideoBuffer = buf;
    }
    const repliedDocAudio =
      repliedDoc && /^audio\//.test(repliedDoc.mime_type ?? '') ? repliedDoc : undefined;
    const repliedAudio = replied.voice ?? replied.audio ?? repliedDocAudio;
    if (repliedAudio) {
      const buf = await downloadFile(ctx, repliedAudio.file_id);
      if (buf) {
        out.repliedAudioBuffer = buf;
        out.repliedAudioMime =
          ('mime_type' in repliedAudio && repliedAudio.mime_type) || 'application/octet-stream';
      }
    }
    if (opts.documents && repliedDoc && !repliedDocAudio && !repliedDocVideo) {
      const buf = await downloadFile(ctx, repliedDoc.file_id);
      if (buf) {
        out.attachments = [
          ...(out.attachments ?? []),
          toAttachment(
            buf,
            repliedDoc.file_name,
            repliedDoc.mime_type,
            repliedDoc.file_size,
            'reply',
          ),
        ];
      }
    }
  }
  return out;
}

/** Include URLs hidden behind Telegram text_link/caption entities in the normal URL pipeline. */
export function appendTextLinkUrls(
  text: string,
  entities: readonly MessageEntity[] | undefined,
): string {
  const hiddenUrls = (entities ?? []).flatMap((entity) => {
    if (entity.type !== 'text_link') return [];
    try {
      const url = new URL(entity.url);
      return url.protocol === 'http:' || url.protocol === 'https:' ? [url.toString()] : [];
    } catch {
      return [];
    }
  });
  const missing = [...new Set(hiddenUrls)].filter((url) => !text.includes(url));
  return [text, ...missing].filter(Boolean).join('\n');
}

function isAudioOrVideoDocument(mime: string | undefined): boolean {
  return /^(audio|video)\//.test(mime ?? '');
}

function toAttachment(
  buffer: Buffer,
  fileName: string | undefined,
  mime: string | undefined,
  declaredSize: number | undefined,
  source: MessageAttachment['source'],
): MessageAttachment {
  return {
    buffer,
    fileName: fileName?.trim() || 'attachment',
    mime: mime?.trim() || 'application/octet-stream',
    size: declaredSize ?? buffer.byteLength,
    source,
  };
}
