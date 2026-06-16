import { isAbsolute, join as pathJoin } from 'node:path';
import { statSync } from 'node:fs';
import type { Env, LLMProviderName } from './env.js';
import { getEnv } from './env.js';

export * from './env.js';
export * from './modes.js';
export * from './i18n.js';

/**
 * Resolved LLM provider configuration. `baseUrl`/`model` defaults depend on the provider.
 * Nothing here is hardcoded into business logic — these are config defaults only.
 */
export interface LLMConfig {
  provider: LLMProviderName;
  baseUrl: string;
  apiKey: string | undefined;
  model: string | undefined;
  visionModel: string | undefined;
  /** Optional separate endpoint for vision (e.g. an Ollama running llama3.2-vision). */
  visionBaseUrl: string | undefined;
  visionApiKey: string | undefined;
  imageModel: string | undefined;
  transcriptionModel: string | undefined;
  ttsModel: string | undefined;
  /** uncensored model used for NSFW routing; undefined => NSFW routing disabled */
  nsfwModel: string | undefined;
  requestTimeoutMs: number;
}

/** Default base URLs per provider. These are examples/defaults, overridable via env. */
const PROVIDER_DEFAULT_BASE_URL: Record<LLMProviderName, string> = {
  solclawn: 'https://llm.solclawn.com/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  custom_openai_compatible: 'http://127.0.0.1:8080/v1',
};

export function resolveLLMConfig(env: Env): LLMConfig {
  const provider = env.LLM_PROVIDER;

  // DeepSeek has its own dedicated env block; fall back to generic LLM_* otherwise.
  if (provider === 'deepseek') {
    const base = (env.DEEPSEEK_BASE_URL || PROVIDER_DEFAULT_BASE_URL.deepseek).replace(/\/+$/, '');
    const baseUrl = base.endsWith('/v1') ? base : `${base}/v1`;
    return {
      provider,
      baseUrl,
      apiKey: env.DEEPSEEK_API_KEY ?? env.LLM_API_KEY,
      model: env.DEEPSEEK_MODEL ?? env.LLM_MODEL,
      visionModel: env.LLM_VISION_MODEL,
      visionBaseUrl: env.LLM_VISION_BASE_URL,
      visionApiKey: env.LLM_VISION_API_KEY,
      imageModel: env.LLM_IMAGE_MODEL,
      transcriptionModel: env.LLM_TRANSCRIPTION_MODEL,
      ttsModel: env.LLM_TTS_MODEL,
      nsfwModel: env.LLM_NSFW_MODEL,
      requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    };
  }

  const baseUrl = (env.LLM_BASE_URL || PROVIDER_DEFAULT_BASE_URL[provider]).replace(/\/+$/, '');
  return {
    provider,
    baseUrl,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    visionModel: env.LLM_VISION_MODEL,
    visionBaseUrl: env.LLM_VISION_BASE_URL,
    visionApiKey: env.LLM_VISION_API_KEY,
    imageModel: env.LLM_IMAGE_MODEL,
    transcriptionModel: env.LLM_TRANSCRIPTION_MODEL,
    ttsModel: env.LLM_TTS_MODEL,
    nsfwModel: env.LLM_NSFW_MODEL,
    requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
  };
}

/** Per-stage model + sampling config for the brain pipeline. Models fall back to the chat model. */
export interface BrainConfig {
  sceneModel: string | undefined;
  plannerModel: string | undefined;
  replyModel: string | undefined;
  rankerModel: string | undefined;
  memoryModel: string | undefined;
  sceneTemperature: number;
  plannerTemperature: number;
  replyTemperature: number;
  rankerTemperature: number;
  memoryTemperature: number;
  replyCandidateCount: number;
  replyMaxRegenerations: number;
  replyTopP: number;
  replyFrequencyPenalty: number;
  replyPresencePenalty: number;
  maxReplyChars: number;
  maxReplyLines: number;
}

export function resolveBrainConfig(env: Env): BrainConfig {
  const fallback = env.LLM_MODEL;
  return {
    sceneModel: env.SCENE_MODEL ?? fallback,
    plannerModel: env.PLANNER_MODEL ?? fallback,
    replyModel: env.REPLY_MODEL ?? fallback,
    rankerModel: env.RANKER_MODEL ?? fallback,
    memoryModel: env.MEMORY_MODEL ?? fallback,
    sceneTemperature: env.SCENE_TEMPERATURE,
    plannerTemperature: env.PLANNER_TEMPERATURE,
    replyTemperature: env.REPLY_TEMPERATURE,
    rankerTemperature: env.RANKER_TEMPERATURE,
    memoryTemperature: env.MEMORY_TEMPERATURE,
    replyCandidateCount: env.REPLY_CANDIDATE_COUNT,
    replyMaxRegenerations: env.REPLY_MAX_REGENERATIONS,
    replyTopP: env.REPLY_TOP_P,
    replyFrequencyPenalty: env.REPLY_FREQUENCY_PENALTY,
    replyPresencePenalty: env.REPLY_PRESENCE_PENALTY,
    maxReplyChars: env.MAX_REPLY_CHARS,
    maxReplyLines: env.MAX_REPLY_LINES,
  };
}

/** Resolved voice (TTS + STT) configuration with absolute tool paths and effective enable flags. */
export interface VoiceConfig {
  tts: {
    enabled: boolean;
    baseUrl: string | undefined;
    model: string;
    voice: string;
    apiKey: string | undefined;
    format: string;
    speed: number;
    maxChars: number;
    timeoutMs: number;
    autoVoiceProbability: number;
    replyToVoice: boolean;
    ffmpegBin: string;
    ffmpegAvailable: boolean;
  };
  stt: {
    enabled: boolean;
    whisperBin: string;
    whisperModel: string;
    ffmpegBin: string;
    language: string;
    threads: number;
    timeoutMs: number;
    transcribeAll: boolean;
  };
}

export function resolveVoiceConfig(env: Env): VoiceConfig {
  // Lazy node imports keep this module importable in tests without touching the fs unnecessarily.

  const resolve = (p: string): string => (isAbsolute(p) ? p : pathJoin(process.cwd(), p));
  const exists = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };

  const ffmpegBin = resolve(env.FFMPEG_BIN);
  const ffmpegAvailable = exists(ffmpegBin);
  const whisperBin = resolve(env.WHISPER_BIN);
  const whisperModel = resolve(env.WHISPER_MODEL);

  // When TTS_FORMAT=opus the server returns Telegram-ready OGG/Opus, so the GoonerBot host needs
  // NO local ffmpeg for TTS (encoding is offloaded to the Kokoro server). Other formats transcode locally.
  const ttsNeedsFfmpeg = env.TTS_FORMAT !== 'opus';

  return {
    tts: {
      enabled: env.TTS_ENABLED && Boolean(env.TTS_BASE_URL) && (!ttsNeedsFfmpeg || ffmpegAvailable),
      baseUrl: env.TTS_BASE_URL ? env.TTS_BASE_URL.replace(/\/+$/, '') : undefined,
      model: env.TTS_MODEL,
      voice: env.TTS_VOICE,
      apiKey: env.TTS_API_KEY,
      format: env.TTS_FORMAT,
      speed: env.TTS_SPEED,
      maxChars: env.TTS_MAX_CHARS,
      timeoutMs: env.TTS_TIMEOUT_MS,
      autoVoiceProbability: env.TTS_AUTO_VOICE_PROBABILITY,
      replyToVoice: env.TTS_REPLY_TO_VOICE,
      ffmpegBin,
      ffmpegAvailable,
    },
    stt: {
      enabled: env.STT_ENABLED && ffmpegAvailable && exists(whisperBin) && exists(whisperModel),
      whisperBin,
      whisperModel,
      ffmpegBin,
      language: env.STT_LANGUAGE,
      threads: env.STT_THREADS,
      timeoutMs: env.STT_TIMEOUT_MS,
      transcribeAll: env.STT_TRANSCRIBE_ALL,
    },
  };
}

/** Web/image grounding config (free SearXNG backend + vision-model reverse-image lookup). */
export interface SearchConfig {
  webEnabled: boolean;
  imageEnabled: boolean;
  searxngUrl: string | undefined;
  maxResults: number;
  timeoutMs: number;
}

export function resolveSearchConfig(env: Env): SearchConfig {
  return {
    webEnabled: env.WEB_SEARCH_ENABLED && Boolean(env.SEARXNG_URL),
    imageEnabled: env.IMAGE_LOOKUP_ENABLED && env.WEB_SEARCH_ENABLED && Boolean(env.SEARXNG_URL),
    searxngUrl: env.SEARXNG_URL ? env.SEARXNG_URL.replace(/\/+$/, '') : undefined,
    maxResults: env.WEB_SEARCH_MAX_RESULTS,
    timeoutMs: env.WEB_SEARCH_TIMEOUT_MS,
  };
}

export interface AppConfig {
  env: Env;
  llm: LLMConfig;
  brain: BrainConfig;
  voice: VoiceConfig;
  search: SearchConfig;
}

export function loadConfig(): AppConfig {
  const env = getEnv();
  return {
    env,
    llm: resolveLLMConfig(env),
    brain: resolveBrainConfig(env),
    voice: resolveVoiceConfig(env),
    search: resolveSearchConfig(env),
  };
}
