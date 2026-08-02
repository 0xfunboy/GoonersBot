import type { Context as GrammyContext } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import {
  sendCachedMedia,
  sendPreparedMedia,
} from '../src/providers/media/linkMedia/telegramSender.js';

function context(methods: Record<string, unknown>): GrammyContext {
  return methods as unknown as GrammyContext;
}

describe('link-media Telegram sender', () => {
  it('retries a video without an invalid reply target', async () => {
    const replyWithVideo = vi
      .fn()
      .mockRejectedValueOnce(new Error('Bad Request: message to be replied not found'))
      .mockResolvedValueOnce({ message_id: 8, video: { file_id: 'video-id' } });
    const ctx = context({ replyWithVideo, replyWithDocument: vi.fn() });

    await expect(
      sendPreparedMedia({
        ctx,
        kind: 'video',
        path: '/tmp/video.mp4',
        replyToMessageId: 7,
      }),
    ).resolves.toMatchObject({ kind: 'video', messageId: 8 });
    expect(replyWithVideo).toHaveBeenCalledTimes(2);
    expect(replyWithVideo.mock.calls[1]?.[1].reply_parameters).toBeUndefined();
  });

  it('falls back from a Telegram-incompatible photo to a document', async () => {
    const replyWithPhoto = vi
      .fn()
      .mockRejectedValue(new Error('Bad Request: PHOTO_INVALID_DIMENSIONS'));
    const replyWithDocument = vi
      .fn()
      .mockResolvedValue({ message_id: 10, document: { file_id: 'document-id' } });

    await expect(
      sendPreparedMedia({
        ctx: context({ replyWithPhoto, replyWithDocument }),
        kind: 'image',
        path: '/tmp/image.webp',
      }),
    ).resolves.toEqual({ fileId: 'document-id', messageId: 10, kind: 'document' });
  });

  it('does not amplify rate limits with format fallbacks', async () => {
    const error = Object.assign(new Error('Too Many Requests: retry after 20'), {
      error_code: 429,
    });
    const replyWithPhoto = vi.fn().mockRejectedValue(error);
    const replyWithDocument = vi.fn();

    await expect(
      sendPreparedMedia({
        ctx: context({ replyWithPhoto, replyWithDocument }),
        kind: 'image',
        path: '/tmp/image.jpg',
      }),
    ).rejects.toBe(error);
    expect(replyWithDocument).not.toHaveBeenCalled();
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
