import { isAbsolute, join as pathJoin } from 'node:path';
import { statSync } from 'node:fs';
import type { Env, LLMProviderName } from './env.js';
import { getEnv } from './env.js';

export * from './env.js';
export * from './modes.js';
export * from './i18n.js';

/**
 * Resolved LLM provider configuration. `baseUrl`/`model` defaults depend on the provider.
 * Nothing here is hardcoded into business logic - these are config defaults only.
 */
export interface LLMConfig {
  provider: LLMProviderName;
  baseUrl: string;
  apiKey: string | undefined;
  model: string | undefined;
  visionModel: string | undefined;
  /** Optional separate endpoint for vision (e.g. an Ollama running llama3.2-vision). */
  visionBaseUrl: string | undefined;
  /** Optional full vision URL for routers that expose a dedicated endpoint. */
  visionEndpointUrl: string | undefined;
  visionApiKey: string | undefined;
  imageModel: string | undefined;
  transcriptionModel: string | undefined;
  ttsModel: string | undefined;
  /** uncensored model used for NSFW routing; undefined => NSFW routing disabled */
  nsfwModel: string | undefined;
  /** optional separate endpoint for the NSFW model; undefined => reuse the primary base/key */
  nsfwBaseUrl: string | undefined;
  nsfwApiKey: string | undefined;
  requestTimeoutMs: number;
  /** optional fallback chat endpoint used when the primary throws; undefined => no fallback */
  fallback: { baseUrl: string; apiKey: string | undefined; model: string } | undefined;
}

export interface EmbeddingsConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  dim: number;
  groupTopK: number;
  knowledgeTopK: number;
  newsTopK: number;
  minScore: number;
}

/** Resolve the optional fallback LLM endpoint (active only when base URL + model are set). */
function resolveFallback(env: Env): LLMConfig['fallback'] {
  if (!env.LLM_FALLBACK_BASE_URL || !env.LLM_FALLBACK_MODEL) return undefined;
  return {
    baseUrl: env.LLM_FALLBACK_BASE_URL.replace(/\/+$/, ''),
    apiKey: env.LLM_FALLBACK_API_KEY,
    model: env.LLM_FALLBACK_MODEL,
  };
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
      visionEndpointUrl: env.LLM_VISION_ENDPOINT_URL,
      visionApiKey: env.LLM_VISION_API_KEY,
      imageModel: env.LLM_IMAGE_MODEL,
      transcriptionModel: env.LLM_TRANSCRIPTION_MODEL,
      ttsModel: env.LLM_TTS_MODEL,
      nsfwModel: env.LLM_NSFW_MODEL,
      nsfwBaseUrl: env.LLM_NSFW_BASE_URL,
      nsfwApiKey: env.LLM_NSFW_API_KEY,
      requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
      fallback: resolveFallback(env),
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
    visionEndpointUrl: env.LLM_VISION_ENDPOINT_URL,
    visionApiKey: env.LLM_VISION_API_KEY,
    imageModel: env.LLM_IMAGE_MODEL,
    transcriptionModel: env.LLM_TRANSCRIPTION_MODEL,
    ttsModel: env.LLM_TTS_MODEL,
    nsfwModel: env.LLM_NSFW_MODEL,
    nsfwBaseUrl: env.LLM_NSFW_BASE_URL,
    nsfwApiKey: env.LLM_NSFW_API_KEY,
    requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    fallback: resolveFallback(env),
  };
}

export function resolveEmbeddingsConfig(env: Env): EmbeddingsConfig {
  const fallbackBase = env.LLM_FALLBACK_BASE_URL;
  const primaryBase =
    env.LLM_PROVIDER === 'deepseek'
      ? (env.DEEPSEEK_BASE_URL || PROVIDER_DEFAULT_BASE_URL.deepseek).replace(/\/+$/, '') +
        (env.DEEPSEEK_BASE_URL?.endsWith('/v1') ? '' : '/v1')
      : env.LLM_BASE_URL || PROVIDER_DEFAULT_BASE_URL[env.LLM_PROVIDER];
  return {
    enabled: env.EMBEDDINGS_ENABLED,
    baseUrl: (env.EMBEDDING_BASE_URL || fallbackBase || primaryBase).replace(/\/+$/, ''),
    apiKey: env.EMBEDDING_API_KEY ?? env.LLM_FALLBACK_API_KEY ?? env.LLM_API_KEY,
    model: env.EMBEDDING_MODEL,
    dim: env.EMBEDDING_DIM,
    groupTopK: env.RAG_GROUP_TOPK,
    knowledgeTopK: env.RAG_KNOWLEDGE_TOPK,
    newsTopK: env.RAG_NEWS_TOPK,
    minScore: env.RAG_MIN_SCORE,
  };
}

/** Per-stage model + sampling config for the brain pipeline. Models fall back to the chat model. */
export interface BrainConfig {
  sceneModel: string | undefined;
  evaluatorEnabled: boolean;
  evaluatorModel: string | undefined;
  evaluatorTemperature: number;
  cortex: {
    enabled: boolean;
    model: string | undefined;
    temperature: number;
    maxTokens: number;
  };
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
    evaluatorEnabled: env.REALISTIC_EVALUATOR_ENABLED,
    evaluatorModel: env.REALISTIC_EVALUATOR_MODEL ?? fallback,
    evaluatorTemperature: env.REALISTIC_EVALUATOR_TEMPERATURE,
    cortex: {
      enabled: env.CORTEX_LLM_ENABLED,
      model: env.CORTEX_MODEL ?? fallback,
      temperature: env.CORTEX_TEMPERATURE,
      maxTokens: env.CORTEX_MAX_TOKENS,
    },
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
    tailPaddingMs: number;
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

  // When TTS_FORMAT=opus the server returns Telegram-ready OGG/Opus, so the GoonersBot host needs
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
      tailPaddingMs: env.TTS_TAIL_PADDING_MS,
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

/** Image-sending + autonomous-posting (news/waifu) config. */
export interface AutoConfig {
  imageSendEnabled: boolean;
  imageSendProbability: number;
  imageQueryPool: string[];
  autopostEnabled: boolean;
  autopostDefaultEnabled: boolean;
  autopostIntervalMinutes: number;
  autopostProbability: number;
  autopostImageRatio: number;
  generatedImageAutopostEnabled: boolean;
  generatedImageAutopostIntervalMinutes: number;
  generatedImageAutopostProbability: number;
  rssFeeds: string[];
  newsMaxAgeHours: number;
}

const DEFAULT_IMAGE_QUERIES = [
  'anime waifu',
  'cute anime girl',
  'anime girl wallpaper',
  'best girl anime',
  'kawaii anime girl art',
  'anime aesthetic girl',
];

// Italy + international, all with reliable pubDate and frequent updates (no stale-entry feeds).
const DEFAULT_RSS_FEEDS = [
  'https://feeds.feedburner.com/TheHackersNews',
  'https://www.bleepingcomputer.com/feed/',
  'https://techcrunch.com/category/artificial-intelligence/feed/',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://www.ansa.it/sito/ansait_rss.xml',
  'https://www.repubblica.it/rss/homepage/rss2.0.xml',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://www.theguardian.com/world/rss',
  'https://feeds.bbci.co.uk/news/rss.xml',
];

function csv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

export function resolveAutoConfig(env: Env): AutoConfig {
  return {
    imageSendEnabled: env.IMAGE_SEND_ENABLED,
    imageSendProbability: env.IMAGE_SEND_PROBABILITY,
    imageQueryPool: csv(env.IMAGE_QUERY_POOL, DEFAULT_IMAGE_QUERIES),
    autopostEnabled: env.AUTOPOST_ENABLED,
    autopostDefaultEnabled: env.AUTOPOST_DEFAULT_ENABLED,
    autopostIntervalMinutes: env.AUTOPOST_INTERVAL_MINUTES,
    autopostProbability: env.AUTOPOST_PROBABILITY,
    autopostImageRatio: env.AUTOPOST_IMAGE_RATIO,
    generatedImageAutopostEnabled: env.GENERATED_IMAGE_AUTOPOST_ENABLED,
    generatedImageAutopostIntervalMinutes: env.GENERATED_IMAGE_AUTOPOST_INTERVAL_MINUTES,
    generatedImageAutopostProbability: env.GENERATED_IMAGE_AUTOPOST_PROBABILITY,
    rssFeeds: csv(env.RSS_FEEDS, DEFAULT_RSS_FEEDS),
    newsMaxAgeHours: env.NEWS_MAX_AGE_HOURS,
  };
}

export interface StableDiffusionConfig {
  enabled: boolean;
  apiUrl: string;
  animeModel: string;
  realisticModel: string;
  nsfwModel: string;
  negativePrompt: string;
  steps: number;
  width: number;
  height: number;
  cfgScale: number;
  timeoutMs: number;
  queueTimeoutMs: number;
  queuePollMs: number;
  controlNet: {
    enabled: boolean;
    openPoseModel: string;
    weight: number;
    processorResolution: number;
  };
}

export function resolveStableDiffusionConfig(env: Env): StableDiffusionConfig {
  return {
    enabled: env.SD_ENABLED && Boolean(env.SD_API_URL),
    apiUrl: env.SD_API_URL.replace(/\/+$/, ''),
    animeModel: env.SD_ANIME_MODEL,
    realisticModel: env.SD_MODEL ?? env.SD_REALISTIC_MODEL,
    nsfwModel: env.SD_NSFW_MODEL,
    negativePrompt: env.SD_NEGATIVE_PROMPT,
    steps: env.SD_STEPS,
    width: env.SD_WIDTH,
    height: env.SD_HEIGHT,
    cfgScale: env.SD_CFG_SCALE,
    timeoutMs: env.SD_TIMEOUT_MS,
    queueTimeoutMs: env.SD_QUEUE_TIMEOUT_MS,
    queuePollMs: env.SD_QUEUE_POLL_MS,
    controlNet: {
      enabled: env.SD_CONTROLNET_ENABLED,
      openPoseModel: env.SD_CONTROLNET_OPENPOSE_MODEL,
      weight: env.SD_CONTROLNET_WEIGHT,
      processorResolution: env.SD_CONTROLNET_PROCESSOR_RESOLUTION,
    },
  };
}

/** Music fetcher (/sing /play + natural language) config. */
export interface MusicConfig {
  enabled: boolean;
  ytdlpBin: string;
  ffmpegBin: string;
  ffmpegAvailable: boolean;
  maxDurationSeconds: number;
  timeoutMs: number;
  proxy: string | undefined;
}

export function resolveMusicConfig(env: Env): MusicConfig {
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
  const ytdlpBin = resolve(env.YTDLP_BIN);
  return {
    enabled: env.MUSIC_ENABLED && ffmpegAvailable && exists(ytdlpBin),
    ytdlpBin,
    ffmpegBin,
    ffmpegAvailable,
    maxDurationSeconds: env.MUSIC_MAX_DURATION_SECONDS,
    timeoutMs: env.MUSIC_TIMEOUT_MS,
    proxy: env.MUSIC_PROXY,
  };
}

/** Link-media rehost (download media from posted URLs, re-upload as Telegram attachments). */
export interface LinkMediaConfig {
  enabled: boolean;
  autoRehost: boolean;
  aiCommentEnabled: boolean;
  commentOnlyWhenAddressed: boolean;
  maxUrlsPerMessage: number;
  maxMediaPerUrl: number;
  maxDownloadBytes: number;
  maxUploadBytes: number;
  maxDurationSeconds: number;
  aiMaxDurationSeconds: number;
  timeoutMs: number;
  chatCooldownSeconds: number;
  userCooldownSeconds: number;
  tmpDir: string;
  allowedHosts: string[];
  blockedHosts: string[];
  nsfwAllow: boolean;
  cookies: {
    instagram: string | undefined;
    tiktok: string | undefined;
    facebook: string | undefined;
    x: string | undefined;
  };
  proxy: string | undefined;
  cacheTtlDays: number;
  ffmpegBin: string;
  ffmpegAvailable: boolean;
  ytdlpBin: string;
  ytdlpAvailable: boolean;
  userAgent: string;
}

const LINK_MEDIA_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function resolveLinkMediaConfig(env: Env): LinkMediaConfig {
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
  const ytdlpBin = resolve(env.YTDLP_BIN);
  const ytdlpAvailable = exists(ytdlpBin);
  return {
    enabled: env.LINK_MEDIA_ENABLED && ffmpegAvailable,
    autoRehost: env.LINK_MEDIA_AUTO_REHOST,
    aiCommentEnabled: env.LINK_MEDIA_AI_COMMENT_ENABLED,
    commentOnlyWhenAddressed: env.LINK_MEDIA_COMMENT_ONLY_WHEN_ADDRESSED,
    maxUrlsPerMessage: env.LINK_MEDIA_MAX_URLS_PER_MESSAGE,
    maxMediaPerUrl: env.LINK_MEDIA_MAX_MEDIA_PER_URL,
    maxDownloadBytes: env.LINK_MEDIA_MAX_DOWNLOAD_MB * 1024 * 1024,
    maxUploadBytes: env.LINK_MEDIA_MAX_UPLOAD_MB * 1024 * 1024,
    maxDurationSeconds: env.LINK_MEDIA_MAX_DURATION_SECONDS,
    aiMaxDurationSeconds: env.LINK_MEDIA_AI_MAX_DURATION_SECONDS,
    timeoutMs: env.LINK_MEDIA_TIMEOUT_MS,
    chatCooldownSeconds: env.LINK_MEDIA_CHAT_COOLDOWN_SECONDS,
    userCooldownSeconds: env.LINK_MEDIA_USER_COOLDOWN_SECONDS,
    tmpDir: resolve(env.LINK_MEDIA_TMP_DIR),
    allowedHosts: csv(env.LINK_MEDIA_ALLOWED_HOSTS, []),
    blockedHosts: csv(env.LINK_MEDIA_BLOCKED_HOSTS, []),
    nsfwAllow: env.LINK_MEDIA_NSFW_ALLOW,
    cookies: {
      instagram: env.LINK_MEDIA_COOKIES_INSTAGRAM,
      tiktok: env.LINK_MEDIA_COOKIES_TIKTOK,
      facebook: env.LINK_MEDIA_COOKIES_FACEBOOK,
      x: env.LINK_MEDIA_COOKIES_X,
    },
    proxy: env.LINK_MEDIA_PROXY,
    cacheTtlDays: env.LINK_MEDIA_CACHE_TTL_DAYS,
    ffmpegBin,
    ffmpegAvailable,
    ytdlpBin,
    ytdlpAvailable,
    userAgent: LINK_MEDIA_USER_AGENT,
  };
}

export interface AppConfig {
  env: Env;
  llm: LLMConfig;
  embeddings: EmbeddingsConfig;
  brain: BrainConfig;
  voice: VoiceConfig;
  search: SearchConfig;
  auto: AutoConfig;
  stableDiffusion: StableDiffusionConfig;
  music: MusicConfig;
  linkMedia: LinkMediaConfig;
}

export function loadConfig(): AppConfig {
  const env = getEnv();
  return {
    env,
    llm: resolveLLMConfig(env),
    embeddings: resolveEmbeddingsConfig(env),
    brain: resolveBrainConfig(env),
    voice: resolveVoiceConfig(env),
    search: resolveSearchConfig(env),
    auto: resolveAutoConfig(env),
    stableDiffusion: resolveStableDiffusionConfig(env),
    music: resolveMusicConfig(env),
    linkMedia: resolveLinkMediaConfig(env),
  };
}
