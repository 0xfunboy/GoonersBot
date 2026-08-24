import { describe, expect, it, vi } from 'vitest';
import { isTelegramReplyTargetMissingError, sendResponse } from '../src/telegram/render.js';

function context() {
  return {
    message: { message_id: 7 },
    replyWithPhoto: vi.fn().mockResolvedValue({ message_id: 8 }),
  };
}

describe('Telegram render resilience', () => {
  it('recognizes a deleted Telegram reply target', () => {
    expect(
      isTelegramReplyTargetMissingError(
        new Error(
          "Call to 'sendMessage' failed! (400: Bad Request: message to be replied not found)",
        ),
      ),
    ).toBe(true);
    expect(isTelegramReplyTargetMissingError(new Error('network timeout'))).toBe(false);
  });

  it('retries text without reply_parameters when the triggering message disappeared', async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(new Error('400: Bad Request: message to be replied not found'))
      .mockResolvedValueOnce({ message_id: 9 });
    const ctx = { message: { message_id: 7 }, reply };
    const sent = await sendResponse(ctx as never, { text: 'ciao', textFormat: 'plain' });
    expect(sent?.message_id).toBe(9);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[0]?.[1]).toHaveProperty('reply_parameters');
    expect(reply.mock.calls[1]?.[1]).not.toHaveProperty('reply_parameters');
  });
});

describe('Telegram image spoilers', () => {
  it('marks only explicitly flagged images as spoilers', async () => {
    const ctx = context();
    await sendResponse(ctx as never, { imageBuffer: Buffer.from('nsfw'), imageSpoiler: true });
    expect(ctx.replyWithPhoto.mock.calls[0]?.[1]).toMatchObject({ has_spoiler: true });
  });

  it('leaves normal images without a spoiler flag', async () => {
    const ctx = context();
    await sendResponse(ctx as never, { imageBuffer: Buffer.from('safe') });
    expect(ctx.replyWithPhoto.mock.calls[0]?.[1]).not.toHaveProperty('has_spoiler');
  });
});
