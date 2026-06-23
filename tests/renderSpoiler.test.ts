import { describe, expect, it, vi } from 'vitest';
import { sendResponse } from '../src/telegram/render.js';

function context() {
  return {
    message: { message_id: 7 },
    replyWithPhoto: vi.fn().mockResolvedValue({ message_id: 8 }),
  };
}

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
