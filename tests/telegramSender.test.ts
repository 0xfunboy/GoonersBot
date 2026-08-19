import { InputFile, type Context as GrammyContext } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import {
  sanitizeTelegramFilename,
  sendCachedMedia,
  sendPreparedMedia,
  sendPreparedMediaToChat,
  type PreparedMediaTelegramApi,
} from '../src/providers/media/linkMedia/telegramSender.js';

function context(methods: Record<string, unknown>): GrammyContext {
  return methods as unknown as GrammyContext;
}

function api(methods: Record<string, unknown>): PreparedMediaTelegramApi {
  return methods as unknown as PreparedMediaTelegramApi;
}

function sendingContext(methods: Record<string, unknown>, messageThreadId?: number): GrammyContext {
  return context({
    api: api(methods),
    chatId: -10042,
    ...(typeof messageThreadId === 'number' ? { msg: { message_thread_id: messageThreadId } } : {}),
  });
}

describe('link-media Telegram sender', () => {
  it('retries a video without an invalid reply target', async () => {
    const sendVideo = vi
      .fn()
      .mockRejectedValueOnce(new Error('Bad Request: message to be replied not found'))
      .mockResolvedValueOnce({ message_id: 8, video: { file_id: 'video-id' } });
    const ctx = sendingContext({ sendVideo, sendDocument: vi.fn() });

    await expect(
      sendPreparedMedia({
        ctx,
        kind: 'video',
        path: '/tmp/video.mp4',
        replyToMessageId: 7,
      }),
    ).resolves.toMatchObject({ kind: 'video', messageId: 8 });
    expect(sendVideo).toHaveBeenCalledTimes(2);
    expect(sendVideo.mock.calls[1]?.[2].reply_parameters).toBeUndefined();
  });

  it('falls back from a Telegram-incompatible photo to a document', async () => {
    const sendPhoto = vi.fn().mockRejectedValue(new Error('Bad Request: PHOTO_INVALID_DIMENSIONS'));
    const sendDocument = vi
      .fn()
      .mockResolvedValue({ message_id: 10, document: { file_id: 'document-id' } });

    await expect(
      sendPreparedMedia({
        ctx: sendingContext({ sendPhoto, sendDocument }),
        kind: 'image',
        path: '/tmp/image.webp',
      }),
    ).resolves.toEqual({ fileId: 'document-id', messageId: 10, kind: 'document' });
  });

  it('does not amplify rate limits with format fallbacks', async () => {
    const error = Object.assign(new Error('Too Many Requests: retry after 20'), {
      error_code: 429,
    });
    const sendPhoto = vi.fn().mockRejectedValue(error);
    const sendDocument = vi.fn();

    await expect(
      sendPreparedMedia({
        ctx: sendingContext({ sendPhoto, sendDocument }),
        kind: 'image',
        path: '/tmp/image.jpg',
      }),
    ).rejects.toBe(error);
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it('sends from a persisted destination and keeps the thread on a reply retry', async () => {
    const sendVideo = vi
      .fn()
      .mockRejectedValueOnce(new Error('Bad Request: reply message not found'))
      .mockResolvedValueOnce({ message_id: 21, video: { file_id: 'video-21' } });
    const signal = new AbortController().signal;

    await expect(
      sendPreparedMediaToChat({
        api: api({ sendVideo, sendDocument: vi.fn() }),
        chatId: -10099,
        messageThreadId: 12,
        replyToMessageId: 7,
        filename: '../../Season\\..\\Episode:01\r\n.mp4',
        kind: 'video',
        path: '/tmp/prepared.mp4',
        video: { thumbnailPath: '/tmp/thumb.jpg' },
        signal,
      }),
    ).resolves.toEqual({ fileId: 'video-21', messageId: 21, kind: 'video' });

    expect(sendVideo).toHaveBeenCalledTimes(2);
    for (const call of sendVideo.mock.calls) {
      expect(call[0]).toBe(-10099);
      expect(call[1]).toBeInstanceOf(InputFile);
      expect((call[1] as InputFile).filename).toBe('Episode_01.mp4');
      expect(call[2].message_thread_id).toBe(12);
      expect(call[3]).toBe(signal);
    }
    expect(sendVideo.mock.calls[0]?.[2].reply_parameters).toEqual({ message_id: 7 });
    expect(sendVideo.mock.calls[1]?.[2].reply_parameters).toBeUndefined();
    expect(sendVideo.mock.calls[1]?.[2].thumbnail).toBeUndefined();
  });

  it('keeps the destination thread when inline video falls back to a document', async () => {
    const sendVideo = vi
      .fn()
      .mockRejectedValue(new Error('Bad Request: VIDEO_CONTENT_TYPE_INVALID'));
    const sendDocument = vi
      .fn()
      .mockResolvedValue({ message_id: 31, document: { file_id: 'document-31' } });

    await expect(
      sendPreparedMediaToChat({
        api: api({ sendVideo, sendDocument }),
        chatId: -10031,
        messageThreadId: 4,
        replyToMessageId: 3,
        kind: 'video',
        path: '/tmp/episode.mp4',
      }),
    ).resolves.toEqual({ fileId: 'document-31', messageId: 31, kind: 'document' });

    expect(sendVideo).toHaveBeenCalledTimes(2);
    expect(sendVideo.mock.calls.every((call) => call[2].message_thread_id === 4)).toBe(true);
    expect(sendDocument).toHaveBeenCalledTimes(1);
    expect(sendDocument.mock.calls[0]?.[2]).toMatchObject({
      message_thread_id: 4,
      reply_parameters: { message_id: 3 },
    });
  });

  it('derives the current forum topic in the context wrapper', async () => {
    const sendDocument = vi
      .fn()
      .mockResolvedValue({ message_id: 41, document: { file_id: 'document-41' } });

    await sendPreparedMedia({
      ctx: sendingContext({ sendDocument }, 77),
      kind: 'document',
      path: '/tmp/archive.zip',
    });

    expect(sendDocument.mock.calls[0]?.[2].message_thread_id).toBe(77);
  });

  it('bounds empty and very long upload filenames', () => {
    expect(sanitizeTelegramFilename('/tmp/video.mp4', '../..\u0000')).toBe('media.mp4');
    expect(sanitizeTelegramFilename('/tmp/video.mp4', `${'a'.repeat(300)}.mp4`)).toHaveLength(180);
    expect(sanitizeTelegramFilename('/tmp/video.mp4', `${'a'.repeat(300)}.mp4`)).toMatch(/\.mp4$/);
    const unicode = sanitizeTelegramFilename('/tmp/video.mp4', `${'🚀'.repeat(100)}.mp4`);
    expect(Buffer.byteLength(unicode)).toBeLessThanOrEqual(180);
    expect(unicode).toMatch(/\.mp4$/);
  });

  it('retries a cached file once without a deleted reply target', async () => {
    const replyWithVideo = vi
      .fn()
      .mockRejectedValueOnce(new Error('Bad Request: reply message not found'))
      .mockResolvedValueOnce({ message_id: 12 });

    await expect(
      sendCachedMedia(context({ replyWithVideo }), 'video', 'cached-id', undefined, 7),
    ).resolves.toBe(12);
    expect(replyWithVideo.mock.calls[1]?.[1].reply_parameters).toBeUndefined();
  });
});
