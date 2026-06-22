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

/** Upload a local file as the right Telegram media type; returns the resulting file_id. */
export async function sendPreparedMedia(input: SendPreparedMediaInput): Promise<string | null> {
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
    return sent.video?.file_id ?? null;
  }
  if (input.kind === 'gif') {
    const sent = await input.ctx.replyWithAnimation(file, opts);
    return sent.animation?.file_id ?? null;
  }
  if (input.kind === 'image') {
    const sent = await input.ctx.replyWithPhoto(file, opts);
    return sent.photo?.at(-1)?.file_id ?? null;
  }
  if (input.kind === 'audio') {
    const sent = await input.ctx.replyWithAudio(file, opts);
    return sent.audio?.file_id ?? null;
  }
  const sent = await input.ctx.replyWithDocument(file, opts);
  return sent.document?.file_id ?? null;
}

/** Re-send a previously cached Telegram file by file_id, using the matching media method. */
export async function sendCachedMedia(
  ctx: GrammyContext,
  kind: LinkMediaKind,
  fileId: string,
  caption?: string,
  replyToMessageId?: number,
): Promise<void> {
  const opts = sendOpts(caption, replyToMessageId);
  if (kind === 'video') await ctx.replyWithVideo(fileId, opts);
  else if (kind === 'gif') await ctx.replyWithAnimation(fileId, opts);
  else if (kind === 'image') await ctx.replyWithPhoto(fileId, opts);
  else if (kind === 'audio') await ctx.replyWithAudio(fileId, opts);
  else await ctx.replyWithDocument(fileId, opts);
}
