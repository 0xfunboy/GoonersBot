import { basename, extname } from 'node:path';
import { InputFile, type Api, type Context as GrammyContext } from 'grammy';
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
  messageThreadId?: number | undefined;
  filename?: string | undefined;
  video?: VideoMeta | undefined;
  signal?: AbortSignal | undefined;
}

export type PreparedMediaTelegramApi = Pick<
  Api,
  'sendVideo' | 'sendAnimation' | 'sendPhoto' | 'sendAudio' | 'sendDocument'
>;

type GrammyAbortSignal = Parameters<PreparedMediaTelegramApi['sendVideo']>[3];

/**
 * grammY's Node declarations still name the structurally compatible `abort-controller` polyfill
 * type. Node's native signal is what the rest of this application uses, so keep the compatibility
 * assertion at this single transport boundary instead of leaking a second signal type upstream.
 */
function toGrammyAbortSignal(signal: AbortSignal | undefined): GrammyAbortSignal {
  return signal as unknown as GrammyAbortSignal;
}

/** Persistable destination data used by background jobs after the originating update is gone. */
export interface TelegramMediaDestination {
  api: PreparedMediaTelegramApi;
  chatId: number | string;
  messageThreadId?: number | undefined;
  replyToMessageId?: number | undefined;
  filename?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface SendPreparedMediaToChatInput extends TelegramMediaDestination {
  kind: LinkMediaKind;
  path: string;
  caption?: string | undefined;
  video?: VideoMeta | undefined;
}

function sendOpts(caption?: string, replyToMessageId?: number, messageThreadId?: number) {
  return {
    ...(caption ? { caption } : {}),
    ...(typeof messageThreadId === 'number' ? { message_thread_id: messageThreadId } : {}),
    ...(typeof replyToMessageId === 'number'
      ? { reply_parameters: { message_id: replyToMessageId } }
      : {}),
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

const MAX_UPLOAD_FILENAME_LENGTH = 180;

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Strip path traversal, control characters and multipart-hostile filename characters. */
export function sanitizeTelegramFilename(path: string, requested?: string): string {
  const pathFallback = basename(path) || 'media';
  const raw = (requested?.trim() || pathFallback).normalize('NFKC').replaceAll('\\', '/');
  const leaf = basename(raw);
  const withoutControls = [...leaf]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('');
  const cleaned = withoutControls
    .replace(/[<>:"/\\|?*]/gu, '_')
    .replace(/^\.+/u, '')
    .trim();
  const fallbackExtension = extname(pathFallback)
    .replace(/[^.a-zA-Z0-9]/gu, '')
    .slice(0, 16);
  const safe = cleaned || `media${fallbackExtension}`;
  if (Buffer.byteLength(safe) <= MAX_UPLOAD_FILENAME_LENGTH) return safe;

  const rawExtension = extname(safe);
  const extension = truncateUtf8(rawExtension, 16);
  const stem = safe.slice(0, safe.length - rawExtension.length);
  const stemLimit = Math.max(1, MAX_UPLOAD_FILENAME_LENGTH - Buffer.byteLength(extension));
  return `${truncateUtf8(stem, stemLimit)}${extension}`;
}

function localMedia(path: string, filename: string): InputFile {
  return new InputFile(path, filename);
}

async function sendDocumentWithReplyFallback(
  destination: TelegramMediaDestination,
  path: string,
  filename: string,
  opts: ReturnType<typeof sendOpts>,
) {
  try {
    return await destination.api.sendDocument(
      destination.chatId,
      localMedia(path, filename),
      opts,
      toGrammyAbortSignal(destination.signal),
    );
  } catch (err) {
    if (!opts.reply_parameters || !isMissingReplyTarget(err)) throw err;
    return destination.api.sendDocument(
      destination.chatId,
      localMedia(path, filename),
      withoutReply(opts),
      toGrammyAbortSignal(destination.signal),
    );
  }
}

export interface SentTelegramMedia {
  fileId: string | null;
  messageId: number;
  kind: LinkMediaKind;
}

/** Upload a local file without depending on a live grammY update context. */
export async function sendPreparedMediaToChat(
  input: SendPreparedMediaToChatInput,
): Promise<SentTelegramMedia> {
  const opts = sendOpts(input.caption, input.replyToMessageId, input.messageThreadId);
  const filename = sanitizeTelegramFilename(input.path, input.filename);
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
      ...(v.thumbnailPath
        ? {
            thumbnail: new InputFile(v.thumbnailPath, sanitizeTelegramFilename(v.thumbnailPath)),
          }
        : {}),
    };
    try {
      const sent = await input.api.sendVideo(
        input.chatId,
        localMedia(input.path, filename),
        videoOpts,
        toGrammyAbortSignal(input.signal),
      );
      return { fileId: sent.video?.file_id ?? null, messageId: sent.message_id, kind: 'video' };
    } catch (firstError) {
      if (!isMissingReplyTarget(firstError) && !isMediaUploadError(firstError)) throw firstError;
      log.debug({ err: firstError }, 'video upload failed; retrying without thumbnail');
      const firstRetryOpts = isMissingReplyTarget(firstError) ? withoutReply(videoOpts) : videoOpts;
      try {
        const { thumbnail: _thumbnail, ...withoutThumbnail } = firstRetryOpts;
        const sent = await input.api.sendVideo(
          input.chatId,
          localMedia(input.path, filename),
          withoutThumbnail,
          toGrammyAbortSignal(input.signal),
        );
        return { fileId: sent.video?.file_id ?? null, messageId: sent.message_id, kind: 'video' };
      } catch (secondError) {
        if (!isMissingReplyTarget(secondError) && !isMediaUploadError(secondError))
          throw secondError;
        log.warn({ err: secondError }, 'inline video upload failed; delivering as document');
        const documentOpts =
          isMissingReplyTarget(firstError) || isMissingReplyTarget(secondError)
            ? withoutReply(opts)
            : opts;
        const sent = await sendDocumentWithReplyFallback(input, input.path, filename, documentOpts);
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
      const sent = await input.api.sendAnimation(
        input.chatId,
        localMedia(input.path, filename),
        opts,
        toGrammyAbortSignal(input.signal),
      );
      return { fileId: sent.animation?.file_id ?? null, messageId: sent.message_id, kind: 'gif' };
    } catch (err) {
      if (!isMissingReplyTarget(err) && !isMediaUploadError(err)) throw err;
      log.warn({ err }, 'animation upload failed; delivering as document');
      const sent = await sendDocumentWithReplyFallback(
        input,
        input.path,
        filename,
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
      const sent = await input.api.sendPhoto(
        input.chatId,
        localMedia(input.path, filename),
        opts,
        toGrammyAbortSignal(input.signal),
      );
      return {
        fileId: sent.photo?.at(-1)?.file_id ?? null,
        messageId: sent.message_id,
        kind: 'image',
      };
    } catch (err) {
      if (!isMissingReplyTarget(err) && !isMediaUploadError(err)) throw err;
      log.warn({ err }, 'photo upload failed; delivering as document');
      const sent = await sendDocumentWithReplyFallback(
        input,
        input.path,
        filename,
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
      const sent = await input.api.sendAudio(
        input.chatId,
        localMedia(input.path, filename),
        opts,
        toGrammyAbortSignal(input.signal),
      );
      return { fileId: sent.audio?.file_id ?? null, messageId: sent.message_id, kind: 'audio' };
    } catch (err) {
      if (!isMissingReplyTarget(err) && !isMediaUploadError(err)) throw err;
      log.warn({ err }, 'audio upload failed; delivering as document');
      const sent = await sendDocumentWithReplyFallback(
        input,
        input.path,
        filename,
        isMissingReplyTarget(err) ? withoutReply(opts) : opts,
      );
      return {
        fileId: sent.document?.file_id ?? null,
        messageId: sent.message_id,
        kind: 'document',
      };
    }
  }
  const sent = await sendDocumentWithReplyFallback(input, input.path, filename, opts);
  return { fileId: sent.document?.file_id ?? null, messageId: sent.message_id, kind: 'document' };
}

/** Context wrapper retained for the synchronous generic link-media path. */
export async function sendPreparedMedia(input: SendPreparedMediaInput): Promise<SentTelegramMedia> {
  const chatId = input.ctx.chatId;
  if (typeof chatId !== 'number') {
    throw new Error('cannot send prepared media without a Telegram chat');
  }
  const contextThreadId = input.ctx.msg?.message_thread_id;
  return sendPreparedMediaToChat({
    api: input.ctx.api,
    chatId,
    kind: input.kind,
    path: input.path,
    ...(input.caption ? { caption: input.caption } : {}),
    ...(typeof input.replyToMessageId === 'number'
      ? { replyToMessageId: input.replyToMessageId }
      : {}),
    ...(typeof input.messageThreadId === 'number'
      ? { messageThreadId: input.messageThreadId }
      : typeof contextThreadId === 'number'
        ? { messageThreadId: contextThreadId }
        : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.video ? { video: input.video } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
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
