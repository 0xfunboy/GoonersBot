/* eslint-disable no-console */
/** Voice round-trip smoke: TTS synth → OGG/Opus → whisper STT. Run: pnpm tsx scripts/smoke-voice.ts */
import { loadConfig } from '../src/config/index.js';
import { TtsProvider } from '../src/providers/voice/tts.js';
import { SttProvider } from '../src/providers/voice/stt.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log('TTS enabled:', config.voice.tts.enabled, '| STT enabled:', config.voice.stt.enabled);
  console.log('ffmpeg:', config.voice.tts.ffmpegBin, '| whisper:', config.voice.stt.whisperBin);

  const tts = new TtsProvider(config.voice.tts);
  const stt = new SttProvider(config.voice.stt);

  const phrase = 'Ciao gooners, questa è una prova vocale del bot.';
  console.log('\nsynthesizing:', JSON.stringify(phrase));
  const t0 = Date.now();
  const ogg = await tts.synth(phrase);
  if (!ogg) {
    console.log('✗ TTS returned null');
    process.exit(1);
  }
  console.log(`✓ TTS -> OGG/Opus ${ogg.length} bytes in ${Date.now() - t0}ms`);

  console.log('\ntranscribing the synthesized clip with whisper...');
  const t1 = Date.now();
  const text = await stt.transcribe(ogg);
  console.log(`✓ STT in ${Date.now() - t1}ms -> ${JSON.stringify(text)}`);

  process.exit(text ? 0 : 1);
}

main().catch((err) => {
  console.error('VOICE SMOKE FATAL:', err);
  process.exit(1);
});
