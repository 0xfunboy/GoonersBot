import { InputFile, type Context as GrammyContext } from 'grammy';
import type { LinkMediaKind } from './types.js';

export interface VideoMeta {
  width?: number;
  height?: number;
  duration?: number;
  /** local path to a small JPEG poster for the inline preview */
  thumbnailPath?: string;
}

export interface SendPreparedMediaInput {
  ctx: GrammyContext;
  kind: LinkMediaKind;
  path: string;
  caption?: string | undefined;
  replyToMessageId?: number | undefined;
  video?: VideoMeta | undefined;
}

function sendOpts(caption?: string, replyToMessageId?: number) {
  return {
    ...(caption ? { caption } : {}),
    ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
  };
}

export interface SentTelegramMedia {
  fileId: string | null;
  messageId: number;
}

/** Upload a local file as the right Telegram media type; returns cache and delivery receipts. */
export async function sendPreparedMedia(input: SendPreparedMediaInput): Promise<SentTelegramMedia> {
  const opts = sendOpts(input.caption, input.replyToMessageId);
  const file = new InputFile(input.path);

  if (input.kind === 'video') {
    // supports_streaming + dimensions + a thumbnail make Telegram show an inline, autoplaying video
    // (with a poster) instead of a downloadable file. Requires the mp4 to be +faststart.
    const v = input.video ?? {};
    const videoOpts = {
      ...opts,
      supports_streaming: true,
      ...(typeof v.width === 'number' ? { width: v.width } : {}),
      ...(typeof v.height === 'number' ? { height: v.height } : {}),
      ...(typeof v.duration === 'number' ? { duration: v.duration } : {}),
      ...(v.thumbnailPath ? { thumbnail: new InputFile(v.thumbnailPath) } : {}),
    };
    const sent = await input.ctx.replyWithVideo(file, videoOpts);
    return { fileId: sent.video?.file_id ?? null, messageId: sent.message_id };
  }
  if (input.kind === 'gif') {
    const sent = await input.ctx.replyWithAnimation(file, opts);
    return { fileId: sent.animation?.file_id ?? null, messageId: sent.message_id };
  }
  if (input.kind === 'image') {
    const sent = await input.ctx.replyWithPhoto(file, opts);
    return { fileId: sent.photo?.at(-1)?.file_id ?? null, messageId: sent.message_id };
  }
  if (input.kind === 'audio') {
    const sent = await input.ctx.replyWithAudio(file, opts);
    return { fileId: sent.audio?.file_id ?? null, messageId: sent.message_id };
  }
  const sent = await input.ctx.replyWithDocument(file, opts);
  return { fileId: sent.document?.file_id ?? null, messageId: sent.message_id };
}

/** Re-send a previously cached Telegram file by file_id, using the matching media method. */
export async function sendCachedMedia(
  ctx: GrammyContext,
  kind: LinkMediaKind,
  fileId: string,
  caption?: string,
  replyToMessageId?: number,
): Promise<number> {
  const opts = sendOpts(caption, replyToMessageId);
  if (kind === 'video') return (await ctx.replyWithVideo(fileId, opts)).message_id;
  if (kind === 'gif') return (await ctx.replyWithAnimation(fileId, opts)).message_id;
  if (kind === 'image') return (await ctx.replyWithPhoto(fileId, opts)).message_id;
  if (kind === 'audio') return (await ctx.replyWithAudio(fileId, opts)).message_id;
  return (await ctx.replyWithDocument(fileId, opts)).message_id;
}
