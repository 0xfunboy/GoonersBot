import { describe, expect, it } from 'vitest';
import type { MessageEntity } from 'grammy/types';
import { appendTextLinkUrls } from '../src/telegram/context.js';
import { extractUrls, mediaUrlKey } from '../src/providers/media/linkMedia/url.js';
import { isTelegramCompatibleVideo } from '../src/providers/media/linkMedia/normalizer.js';

describe('link-media URL intake', () => {
  it('includes a URL hidden behind a Telegram text_link entity', () => {
    const entities = [
      {
        type: 'text_link',
        offset: 0,
        length: 10,
        url: 'https://www.instagram.com/reel/ABC/?igsh=tracking',
      },
    ] as MessageEntity[];

    const text = appendTextLinkUrls('guarda qui', entities);
    expect(extractUrls(text, 2).map(String)).toEqual([
      'https://www.instagram.com/reel/ABC/?igsh=tracking',
    ]);
  });

  it('rejects non-http hidden links and does not duplicate literal URLs', () => {
    const literal = 'https://youtu.be/demo';
    const entities = [
      { type: 'text_link', offset: 0, length: 1, url: literal },
      { type: 'text_link', offset: 0, length: 1, url: 'file:///etc/passwd' },
    ] as MessageEntity[];

    expect(appendTextLinkUrls(literal, entities)).toBe(literal);
  });

  it('preserves the complete signed fetch query but compares equivalent tracking variants', () => {
    const [signed] = extractUrls(
      'https://cdn.example/video.mp4?Policy=two&Signature=one&utm_source=chat',
      1,
    );
    expect(signed?.search).toBe('?Policy=two&Signature=one&utm_source=chat');
    expect(mediaUrlKey(signed!)).toBe(
      mediaUrlKey('https://cdn.example/video.mp4?Signature=one&Policy=two#preview'),
    );
  });

  it('never removes signature-like names such as si from a fetch target', () => {
    const [signed] = extractUrls('https://cdn.example/video?id=7&si=required-signature', 1);
    expect(signed?.toString()).toBe('https://cdn.example/video?id=7&si=required-signature');
    expect(mediaUrlKey(signed!)).toBe('https://cdn.example/video?id=7');
  });
});

describe('Telegram video compatibility', () => {
  it('accepts H.264/yuv420p with AAC or no audio', () => {
    expect(
      isTelegramCompatibleVideo({
        videoCodec: 'h264',
        audioCodec: 'aac',
        pixelFormat: 'yuv420p',
      }),
    ).toBe(true);
    expect(isTelegramCompatibleVideo({ videoCodec: 'h264', pixelFormat: 'yuv420p' })).toBe(true);
  });

  it('forces transcoding for AV1, VP9, Opus, and non-420 pixel formats', () => {
    expect(isTelegramCompatibleVideo({ videoCodec: 'av1', audioCodec: 'aac' })).toBe(false);
    expect(isTelegramCompatibleVideo({ videoCodec: 'vp9', audioCodec: 'opus' })).toBe(false);
    expect(
      isTelegramCompatibleVideo({
        videoCodec: 'h264',
        audioCodec: 'opus',
        pixelFormat: 'yuv420p',
      }),
    ).toBe(false);
    expect(
      isTelegramCompatibleVideo({
        videoCodec: 'h264',
        audioCodec: 'aac',
        pixelFormat: 'yuv444p',
      }),
    ).toBe(false);
  });
});
