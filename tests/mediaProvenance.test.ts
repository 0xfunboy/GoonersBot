import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { buildIncomingMessage } from '../src/telegram/context.js';
import { ReplyService } from '../src/services/reply.js';
import { shouldInspectRepliedMedia } from '../src/telegram/handlers/message.js';
import { buildGeneratorSystem } from '../src/prompts/generator.js';

describe('Telegram media provenance', () => {
  it('tells the generator that current and replied media are different sources', () => {
    const system = buildGeneratorSystem({
      botUsername: 'GoonersBot',
      chatName: 'Gooners',
      language: 'italian',
      modeName: 'Default',
      modeDescription: 'natural',
      nsfwEnabled: false,
    });
    expect(system).toContain('MEDIA PROVENANCE');
    expect(system).toContain('CURRENT ... TRANSCRIPT');
    expect(system).toContain('REPLIED MEDIA TRANSCRIPT');
    expect(system).toContain('Never swap them');
  });

  it('retains current/replied media identity even when files exceed the inbound download cap', async () => {
    const ctx = {
      message: {
        message_id: 10,
        date: 1,
        chat: { id: -100, type: 'supergroup', title: 'g' },
        from: { id: 1, is_bot: false, first_name: 'A' },
        video: { file_id: 'current-video', file_size: 25 * 1024 * 1024 },
        reply_to_message: {
          message_id: 9,
          date: 1,
          chat: { id: -100, type: 'supergroup', title: 'g' },
          from: { id: 2, is_bot: true, first_name: 'Bot' },
          voice: { file_id: 'old-voice', file_size: 25 * 1024 * 1024 },
        },
      },
      api: { getFile: vi.fn() },
    } as unknown as Context;

    const message = await buildIncomingMessage(ctx, { image: true, voice: true });
    expect(message.currentMediaKind).toBe('video');
    expect(message.repliedMediaKind).toBe('voice');
    expect(message.videoBuffer).toBeUndefined();
    expect(message.repliedAudioBuffer).toBeUndefined();
  });

  it('does not inspect replied media when a new current attachment owns the turn unless explicitly requested', () => {
    expect(shouldInspectRepliedMedia(true, '')).toBe(false);
    expect(shouldInspectRepliedMedia(true, 'guarda questo')).toBe(false);
    expect(shouldInspectRepliedMedia(true, 'trascrivi il video a cui rispondo')).toBe(true);
    expect(shouldInspectRepliedMedia(false, '')).toBe(true);
  });

  it('never substitutes a replied visual when Telegram says the current message is a visual attachment', async () => {
    const frameFromVideo = vi.fn().mockResolvedValue(Buffer.from('frame'));
    const resolveVisual = (
      ReplyService.prototype as unknown as {
        resolveVisual(message: unknown): Promise<unknown>;
      }
    ).resolveVisual;

    const result = await resolveVisual.call(
      { media: { frameFromVideo } },
      {
        messageText: '',
        timestamp: new Date(),
        currentMediaKind: 'video',
        repliedImageBuffer: Buffer.from('old-photo'),
        repliedImageMime: 'image/jpeg',
      },
    );

    expect(result).toBeNull();
    expect(frameFromVideo).not.toHaveBeenCalled();
  });
});
