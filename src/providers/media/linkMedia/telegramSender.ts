import { InputFile, type Context as GrammyContext } from 'grammy';
import type { LinkMediaKind } from './types.js';
import { childLogger } from '../../../utils/logger.js';

const log = childLogger('link-media-telegram');

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

function withoutReply<T extends object>(opts: T): Omit<T, 'reply_parameters'> {
  const { reply_parameters: _reply, ...rest } = opts as T & {
    reply_parameters?: unknown;
  };
  return rest;
}

function isMissingReplyTarget(err: unknown): boolean {
  const record = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
  const message = [
    err instanceof Error ? err.message : '',
    typeof record?.['description'] === 'string' ? record['description'] : '',
  ]
    .join(' ')
    .toLowerCase();
  return /reply[^\n]*(?:message|target)[^\n]*(?:not found|invalid)|message to be replied not found/.test(
    message,
  );
}

function isMediaUploadError(err: unknown): boolean {
  const record = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
  const status = Number(record?.['error_code'] ?? record?.['statusCode']);
  if (status === 429 || status >= 500) return false;
  const message = [
    err instanceof Error ? err.message : '',
    typeof record?.['description'] === 'string' ? record['description'] : '',
  ]
    .join(' ')
    .toLowerCase();
  if (
    /too many requests|rate.?limit|timed? ?out|network|socket|forbidden|not enough rights/.test(
      message,
    )
  )
    return false;
  return /file|media|video|photo|image|animation|audio|thumbnail|dimension|content.?type/.test(
    message,
  );
}

async function sendDocumentWithReplyFallback(
  ctx: GrammyContext,
  media: InputFile,
  opts: ReturnType<typeof sendOpts>,
) {
  try {
    return await ctx.replyWithDocument(media, opts);
  } catch (err) {
    if (!opts.reply_parameters || !isMissingReplyTarget(err)) throw err;
    return ctx.replyWithDocument(media, withoutReply(opts));
  }
}

export interface SentTelegramMedia {
  fileId: string | null;
  messageId: number;
  kind: LinkMediaKind;
}

/** Upload a local file as the right Telegram media type; returns cache and delivery receipts. */
export async function sendPreparedMedia(input: SendPreparedMediaInput): Promise<SentTelegramMedia> {
  const opts = sendOpts(input.caption, input.replyToMessageId);
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
    try {
      const sent = await input.ctx.replyWithVideo(new InputFile(input.path), videoOpts);
      return { fileId: sent.video?.file_id ?? null, messageId: sent.message_id, kind: 'video' };
    } catch (firstError) {
      if (!isMissingReplyTarget(firstError) && !isMediaUploadError(firstError)) throw firstError;
      log.debug({ err: firstError }, 'video upload failed; retrying without thumbnail');
      const firstRetryOpts = isMissingReplyTarget(firstError) ? withoutReply(videoOpts) : videoOpts;
      try {
        const { thumbnail: _thumbnail, ...withoutThumbnail } = firstRetryOpts;
        const sent = await input.ctx.replyWithVideo(new InputFile(input.path), withoutThumbnail);
        return { fileId: sent.video?.file_id ?? null, messageId: sent.message_id, kind: 'video' };
      } catch (secondError) {
        if (!isMissingReplyTarget(secondError) && !isMediaUploadError(secondError))
          throw secondError;
        log.warn({ err: secondError }, 'inline video upload failed; delivering as document');
        const documentOpts = isMissingReplyTarget(secondError) ? withoutReply(opts) : opts;
        const sent = await sendDocumentWithReplyFallback(
          input.ctx,
          new InputFile(input.path),
          documentOpts,
        );
        return {
          fileId: sent.document?.file_id ?? null,
          messageId: sent.message_id,
          kind: 'document',
        };
      }
    }
  }
  if (input.kind === 'gif') {
    try {
      const sent = await input.ctx.replyWithAnimation(new InputFile(input.path), opts);
      return { fileId: sent.animation?.file_id ?? null, messageId: sent.message_id, kind: 'gif' };
    } catch (err) {
      if (!isMissingReplyTarget(err) && !isMediaUploadError(err)) throw err;
      log.warn({ err }, 'animation upload failed; delivering as document');
      const sent = await sendDocumentWithReplyFallback(
        input.ctx,
        new InputFile(input.path),
        isMissingReplyTarget(err) ? withoutReply(opts) : opts,
      );
      return {
        fileId: sent.document?.file_id ?? null,
        messageId: sent.message_id,
        kind: 'document',
      };
    }
  }
  if (input.kind === 'image') {
    try {
      const sent = await input.ctx.replyWithPhoto(new InputFile(input.path), opts);
      return {
        fileId: sent.photo?.at(-1)?.file_id ?? null,
        messageId: sent.message_id,
        kind: 'image',
      };
    } catch (err) {
      if (!isMissingReplyTarget(err) && !isMediaUploadError(err)) throw err;
      log.warn({ err }, 'photo upload failed; delivering as document');
      const sent = await sendDocumentWithReplyFallback(
        input.ctx,
        new InputFile(input.path),
        isMissingReplyTarget(err) ? withoutReply(opts) : opts,
      );
      return {
        fileId: sent.document?.file_id ?? null,
        messageId: sent.message_id,
        kind: 'document',
      };
    }
  }
  if (input.kind === 'audio') {
    try {
      const sent = await input.ctx.replyWithAudio(new InputFile(input.path), opts);
      return { fileId: sent.audio?.file_id ?? null, messageId: sent.message_id, kind: 'audio' };
    } catch (err) {
      if (!isMissingReplyTarget(err) && !isMediaUploadError(err)) throw err;
      log.warn({ err }, 'audio upload failed; delivering as document');
      const sent = await sendDocumentWithReplyFallback(
        input.ctx,
        new InputFile(input.path),
        isMissingReplyTarget(err) ? withoutReply(opts) : opts,
      );
      return {
        fileId: sent.document?.file_id ?? null,
        messageId: sent.message_id,
        kind: 'document',
      };
    }
  }
  const sent = await sendDocumentWithReplyFallback(input.ctx, new InputFile(input.path), opts);
  return { fileId: sent.document?.file_id ?? null, messageId: sent.message_id, kind: 'document' };
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
  const retryMissingReply = async <T extends { message_id: number }>(
    send: (options: ReturnType<typeof sendOpts>) => Promise<T>,
  ): Promise<number> => {
    try {
      return (await send(opts)).message_id;
    } catch (err) {
      if (!opts.reply_parameters || !isMissingReplyTarget(err)) throw err;
      return (await send(withoutReply(opts))).message_id;
    }
  };
  if (kind === 'video') return retryMissingReply((options) => ctx.replyWithVideo(fileId, options));
  if (kind === 'gif')
    return retryMissingReply((options) => ctx.replyWithAnimation(fileId, options));
  if (kind === 'image') return retryMissingReply((options) => ctx.replyWithPhoto(fileId, options));
  if (kind === 'audio') return retryMissingReply((options) => ctx.replyWithAudio(fileId, options));
  return retryMissingReply((options) => ctx.replyWithDocument(fileId, options));
}
