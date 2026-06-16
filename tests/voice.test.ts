import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { resolveVoiceConfig } from '../src/config/index.js';
import { voiceCommand } from '../src/telegram/handlers/commands/voice.js';
import type { HandlerInput } from '../src/telegram/handlers/types.js';
import type { ChatContext, Person } from '../src/domain/types.js';

const base = { TELEGRAM_BOT_TOKEN: 't' };

describe('resolveVoiceConfig', () => {
  it('disables TTS/STT when the ffmpeg/whisper binaries are missing', () => {
    const env = loadEnv({
      ...base,
      TTS_ENABLED: 'true',
      TTS_BASE_URL: 'http://x:8880',
      STT_ENABLED: 'true',
      FFMPEG_BIN: '/nonexistent/ffmpeg',
      WHISPER_BIN: '/nonexistent/whisper',
      WHISPER_MODEL: '/nonexistent/model.bin',
    });
    const v = resolveVoiceConfig(env);
    expect(v.tts.enabled).toBe(false); // ffmpeg missing
    expect(v.stt.enabled).toBe(false);
    expect(v.tts.baseUrl).toBe('http://x:8880');
    expect(v.tts.voice).toBe('im_nicola');
  });

  it('defaults voice/model knobs', () => {
    const v = resolveVoiceConfig(loadEnv(base));
    expect(v.tts.model).toBe('tts-1');
    expect(v.stt.language).toBe('auto');
    expect(v.stt.transcribeAll).toBe(true);
  });
});

const person: Person = { telegramId: 1, userHandle: '@bob' };
const ctx = (over: Partial<ChatContext> = {}): ChatContext => ({
  chatId: -1,
  isGroup: true,
  isBotMentioned: false,
  isGroupAdmin: false,
  isReplyToBot: false,
  ...over,
});
function input(services: unknown, context = ctx()): HandlerInput {
  return {
    services: services as HandlerInput['services'],
    person,
    context,
    message: { messageText: '', timestamp: new Date() },
    args: [],
    botUsername: 'GoonersBot',
    addressed: true,
  };
}

describe('/voice command', () => {
  it('reports unavailable when TTS is off', async () => {
    const services = { tts: { enabled: false } };
    const res = await voiceCommand.handle(input(services));
    expect(res?.text).toBe('voice_unavailable');
  });

  it('voices the replied message', async () => {
    const synth = vi.fn().mockResolvedValue(Buffer.from('OGG'));
    const findByMessageId = vi.fn().mockResolvedValue({ message: { messageText: 'ciao mondo' } });
    const services = {
      tts: { enabled: true, synth },
      getLanguage: () => 'italian',
      storage: { messages: { findByMessageId, getLatest: vi.fn() } },
    };
    const res = await voiceCommand.handle(input(services, ctx({ repliedToMessageId: 42 })));
    expect(findByMessageId).toHaveBeenCalledWith(-1, 42);
    expect(synth).toHaveBeenCalledWith('ciao mondo', 'italian');
    expect(res?.audioBuffer).toBeInstanceOf(Buffer);
  });

  it('voices the latest message when used alone', async () => {
    const synth = vi.fn().mockResolvedValue(Buffer.from('OGG'));
    const getLatest = vi.fn().mockResolvedValue({ message: { messageText: 'ultimo' } });
    const services = {
      tts: { enabled: true, synth },
      getLanguage: () => 'italian',
      storage: { messages: { findByMessageId: vi.fn(), getLatest } },
    };
    const res = await voiceCommand.handle(input(services));
    expect(getLatest).toHaveBeenCalledWith(-1);
    expect(res?.audioBuffer).toBeInstanceOf(Buffer);
  });

  it('returns voice_none when there is nothing to voice', async () => {
    const services = {
      tts: { enabled: true, synth: vi.fn() },
      getLanguage: () => 'italian',
      storage: {
        messages: { findByMessageId: vi.fn(), getLatest: vi.fn().mockResolvedValue(null) },
      },
    };
    const res = await voiceCommand.handle(input(services));
    expect(res?.text).toBe('voice_none');
  });

  it('returns voice_failed when synthesis returns null', async () => {
    const services = {
      tts: { enabled: true, synth: vi.fn().mockResolvedValue(null) },
      getLanguage: () => 'italian',
      storage: {
        messages: {
          findByMessageId: vi.fn(),
          getLatest: vi.fn().mockResolvedValue({ message: { messageText: 'x' } }),
        },
      },
    };
    const res = await voiceCommand.handle(input(services));
    expect(res?.text).toBe('voice_failed');
  });
});
