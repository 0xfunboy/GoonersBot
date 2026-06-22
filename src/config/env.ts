import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Coerce common truthy/falsy string env values into booleans.
 */
const boolFromString = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const intFromString = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? def : n;
    });

const floatFromString = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      const n = Number.parseFloat(v);
      return Number.isNaN(n) ? def : n;
    });

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const csvHandles = z
  .string()
  .optional()
  .transform((v): string[] | null => {
    if (v === undefined) return null;
    const trimmed = v.trim();
    if (trimmed === '' || trimmed === '*') return null; // null => no restriction
    return trimmed
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0)
      .map((h) => (h.startsWith('@') ? h : `@${h}`));
  });

const csvNumbers = z
  .string()
  .optional()
  .transform((v): number[] =>
    (v ?? '')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  );

/**
 * Provider enum kept open via `custom_openai_compatible` for arbitrary backends.
 */
export const llmProviderEnum = z.enum([
  'solclawn',
  'openai',
  'deepseek',
  'ollama',
  'custom_openai_compatible',
]);

export type LLMProviderName = z.infer<typeof llmProviderEnum>;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  BOT_USERNAME: z.string().default('GoonersBot'),

  // Access control (handles normalized to @handle; null => unrestricted)
  ALLOWED_HANDLES: csvHandles,
  ADMIN_HANDLES: csvHandles,

  // Approval gate: only bot admins, approved user ids, or approved chat ids get the model, media
  // generation and link-media. Everyone else (incl. private DMs) is limited to tos/terms/help and
  // receives the "request approval" notice. The JSON store is seeded from these ids on first run.
  APPROVED_CHATS: csvNumbers,
  APPROVED_USERS: csvNumbers,
  APPROVED_STORE_PATH: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'data/approved.json')),

  // MongoDB
  MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/goonerbot'),
  MONGO_DB: z.string().default('goonerbot'),

  // LLM provider selection
  LLM_PROVIDER: llmProviderEnum.default('ollama'),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_VISION_MODEL: z.string().optional(),
  // Vision usually lives on a different backend (solclawn has no vision). Point these at a
  // vision-capable Ollama (e.g. llama3.2-vision). Empty => vision reuses LLM_BASE_URL/LLM_API_KEY.
  LLM_VISION_BASE_URL: z.string().optional(),
  LLM_VISION_API_KEY: z.string().optional(),
  LLM_IMAGE_MODEL: z.string().optional(),
  LLM_TRANSCRIPTION_MODEL: z.string().optional(),
  LLM_TTS_MODEL: z.string().optional(),
  LLM_REQUEST_TIMEOUT_MS: intFromString(60_000),
  // Fallback LLM endpoint (used for chat/reasoning when the primary throws): e.g. local
  // Ollama gpt-oss on the GPU box. Active when BASE_URL + MODEL are both set.
  LLM_FALLBACK_BASE_URL: z.string().optional(),
  LLM_FALLBACK_API_KEY: z.string().optional(),
  LLM_FALLBACK_MODEL: z.string().optional(),

  // Per-user "heat": verbal-hostility escalation that rises when a user pushes the bot and
  // cools over time / when the user de-escalates. Scored 0..100.
  HEAT_ENABLED: boolFromString(true),
  HEAT_BASELINE: intFromString(12),
  HEAT_MAX: intFromString(100),
  HEAT_DECAY_PER_MINUTE: intFromString(1),

  // Knowledge base (nerd/anime/manga/IT/TV culture) recalled on-demand (RAG), capped so it never
  // bloats the prompt nor makes the character monothematic.
  KNOWLEDGE_ENABLED: boolFromString(true),
  KNOWLEDGE_MAX_ITEMS: intFromString(2),
  KNOWLEDGE_SEED_ON_BOOT: boolFromString(true),

  // Image sending: fetch a waifu/anime image online (SearXNG images), vision-verify it, then send
  // with an on-theme comment. Requires the SearXNG backend + a vision model.
  IMAGE_SEND_ENABLED: boolFromString(true),
  IMAGE_SEND_PROBABILITY: floatFromString(0.15), // chance to attach an image on anime/waifu replies
  IMAGE_QUERY_POOL: z.string().optional(), // comma-separated query seeds (defaults provided)

  // Stable Diffusion / Automatic1111 image generation. The endpoint returns base64 bitmap data.
  SD_ENABLED: boolFromString(true),
  SD_API_URL: z.string().default('http://192.168.178.87:7860'),
  SD_MODEL: optStr, // legacy override for the default realistic checkpoint
  // Keep one checkpoint loaded on the shared Forge host. Switching SDXL/SD 1.5 checkpoints was
  // exhausting host RAM on this deployment, so PonyXL is the common generation checkpoint.
  SD_ANIME_MODEL: z.string().default('ponyDiffusionV6XL_v6StartWithThisOne.safetensors'),
  SD_REALISTIC_MODEL: z.string().default('ponyDiffusionV6XL_v6StartWithThisOne.safetensors'),
  SD_NSFW_MODEL: z.string().default('ponyDiffusionV6XL_v6StartWithThisOne.safetensors'),
  SD_NEGATIVE_PROMPT: z
    .string()
    .default(
      'lowres, blurry, bad anatomy, extra fingers, watermark, text, logo, signature, child, loli, shota',
    ),
  SD_STEPS: intFromString(24),
  SD_WIDTH: intFromString(768),
  SD_HEIGHT: intFromString(768),
  SD_CFG_SCALE: floatFromString(6.5),
  // A checkpoint change on a shared Forge host can take longer than the actual sampling run.
  // Keep this generous so the bot waits for the server instead of falsely reporting it offline.
  SD_TIMEOUT_MS: intFromString(300_000),
  SD_QUEUE_TIMEOUT_MS: intFromString(300_000),
  SD_QUEUE_POLL_MS: intFromString(2_000),
  SD_CONTROLNET_ENABLED: boolFromString(true),
  SD_CONTROLNET_OPENPOSE_MODEL: z.string().default('OpenPoseXL2'),
  SD_CONTROLNET_WEIGHT: floatFromString(0.85),
  SD_CONTROLNET_PROCESSOR_RESOLUTION: intFromString(512),

  // Autonomous posting: every interval, with a probability, drop an unprompted line (a styled take
  // on a current event from RSS, or a commented waifu image). Also triggerable via /news (/nuovo).
  AUTOPOST_ENABLED: boolFromString(true),
  AUTOPOST_DEFAULT_ENABLED: boolFromString(false), // per-chat default (opt-in, avoids spam)
  AUTOPOST_INTERVAL_MINUTES: intFromString(10),
  AUTOPOST_PROBABILITY: floatFromString(0.05),
  AUTOPOST_IMAGE_RATIO: floatFromString(0.4), // share of autoposts that are a waifu image vs news
  GENERATED_IMAGE_AUTOPOST_ENABLED: boolFromString(false), // keep off until generation quality is approved
  GENERATED_IMAGE_AUTOPOST_INTERVAL_MINUTES: intFromString(10),
  GENERATED_IMAGE_AUTOPOST_PROBABILITY: floatFromString(0.05),
  RSS_FEEDS: z.string().optional(), // comma-separated feed URLs (defaults provided)
  NEWS_MAX_AGE_HOURS: intFromString(12), // only surface items published within this many hours

  // Web/image grounding (free: self-hosted SearXNG + vision-model reverse-image lookup)
  // WEB_SEARCH: ground recency/factual questions with fresh web results.
  WEB_SEARCH_ENABLED: boolFromString(false),
  SEARXNG_URL: z.string().optional(),
  WEB_SEARCH_MAX_RESULTS: intFromString(5),
  WEB_SEARCH_TIMEOUT_MS: intFromString(8000),
  // IMAGE_LOOKUP: answer "who/what is this image / where to buy" by identifying the subject with
  // the vision model and searching it on SearXNG (needs WEB_SEARCH backend too). Lens-equivalent.
  IMAGE_LOOKUP_ENABLED: boolFromString(false),

  // NSFW model routing (hybrid: mode flag > per-chat nsfw mode > lexicon > default model)
  LLM_NSFW_MODEL: z.string().optional(),
  // Optional separate endpoint for the NSFW model (e.g. amoral-gemma on a router) so adult turns
  // can run on a different backend than the primary chat. Empty => reuse LLM_BASE_URL/LLM_API_KEY.
  LLM_NSFW_BASE_URL: z.string().optional(),
  LLM_NSFW_API_KEY: z.string().optional(),
  // initial per-chat NSFW mode: off (never) | base (whole chat uses NSFW model) | smart (per-message lexicon)
  // default 'smart' => new chats use the fast default model for ordinary turns and switch to the
  // NSFW model only on explicit lexicon hits or refusal backstop. With no LLM_NSFW_MODEL set this
  // is inert (the router falls back to the default text model).
  LLM_NSFW_DEFAULT_MODE: z.enum(['off', 'base', 'smart']).default('smart'),
  // optional extra comma-separated NSFW trigger terms appended to the built-in lexicon
  LLM_NSFW_LEXICON: z.string().optional(),
  // buffered refusal backstop: if the default model refuses, silently retry with the NSFW model
  LLM_REFUSAL_FALLBACK: boolFromString(true),
  LLM_REFUSAL_BUFFER_CHARS: intFromString(160),

  // DeepSeek-specific (used when LLM_PROVIDER=deepseek)
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().optional(),

  // Behaviour defaults (per-chat toggles seed values)
  DEFAULT_LANGUAGE: z.string().default('italian'),
  AUTOENGAGE_DEFAULT_ENABLED: boolFromString(true),
  CONVERSATION_TRACKER_DEFAULT_ENABLED: boolFromString(true),
  AUTOFACT_DEFAULT_ENABLED: boolFromString(false),

  // Autoengage limits / cooldowns
  MAX_REPLIES_PER_CHAT_PER_HOUR: intFromString(15),
  AUTOENGAGE_MIN_COOLDOWN_SECONDS: intFromString(45),
  AUTOENGAGE_USER_COOLDOWN_SECONDS: intFromString(20),
  AUTOENGAGE_MIN_CONFIDENCE: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return 0.6;
      const n = Number.parseFloat(v);
      return Number.isNaN(n) ? 0.6 : n;
    }),

  // Conversation memory / retention
  MESSAGE_HISTORY_RETENTION_DAYS: intFromString(30),
  MAX_CONTEXT_MESSAGES: intFromString(25),
  MAX_STORED_MESSAGES_PER_CHAT: intFromString(500),

  // Usage limits (points). Large default => effectively unlimited unless configured.
  DEFAULT_USAGE_LIMIT: intFromString(1_000_000_000),

  // Default ban duration in seconds when /ban is used without an explicit duration.
  // 0 => permanent.
  DEFAULT_BAN_SECONDS: intFromString(0),

  // Telegram streaming UX
  ENABLE_MESSAGE_STREAMING: boolFromString(true),
  STREAM_EDIT_INTERVAL_MS: intFromString(1200),

  // Anti-spam: minimum seconds between accepted command invocations per user.
  COMMAND_RATE_LIMIT_SECONDS: intFromString(1),

  // ---- Brain: per-stage model overrides (empty => fall back to LLM_MODEL) ----
  SCENE_MODEL: optStr,
  REALISTIC_EVALUATOR_ENABLED: boolFromString(true),
  REALISTIC_EVALUATOR_MODEL: optStr,
  REALISTIC_EVALUATOR_TEMPERATURE: floatFromString(0.1),
  PLANNER_MODEL: optStr,
  REPLY_MODEL: optStr,
  RANKER_MODEL: optStr,
  MEMORY_MODEL: optStr,

  // Brain temperatures
  SCENE_TEMPERATURE: floatFromString(0.2),
  PLANNER_TEMPERATURE: floatFromString(0.3),
  REPLY_TEMPERATURE: floatFromString(0.95),
  RANKER_TEMPERATURE: floatFromString(0.1),
  MEMORY_TEMPERATURE: floatFromString(0.1),

  // Reply generation
  REPLY_CANDIDATE_COUNT: intFromString(1),
  REPLY_MAX_REGENERATIONS: intFromString(2),
  REPLY_TOP_P: floatFromString(0.95),
  REPLY_FREQUENCY_PENALTY: floatFromString(0.6),
  REPLY_PRESENCE_PENALTY: floatFromString(0.4),
  MAX_REPLY_CHARS: intFromString(420),
  MAX_REPLY_LINES: intFromString(3),

  // Memory engine
  MEMORY_MIN_CONFIDENCE: floatFromString(0.68),
  MEMORY_AUTO_MIN_CONFIDENCE: floatFromString(0.75),
  MEMORY_MANUAL_MIN_CONFIDENCE: floatFromString(0.62),
  MEMORY_MIN_SALIENCE: floatFromString(0.45),
  MEMORY_MAX_CANDIDATES_PER_RUN: intFromString(5),
  MEMORY_MAX_ITEMS_PER_REPLY: intFromString(3),
  MEMORY_MAX_EXPLICIT_CALLBACKS_PER_REPLY: intFromString(1),
  MEMORY_ITEM_COOLDOWN_MINUTES: intFromString(45),
  MEMORY_SUBJECT_COOLDOWN_MINUTES: intFromString(20),
  FACT_EXTRACTION_CONTEXT_MESSAGES: intFromString(30),
  FACT_REPLY_CONTEXT_BEFORE: intFromString(10),
  FACT_REPLY_CONTEXT_AFTER: intFromString(10),

  // Jobs
  MEMORY_MINING_ENABLED: boolFromString(true),
  MEMORY_MINING_EVERY_MESSAGES: intFromString(25),
  MEMORY_MINING_MIN_ACTIVE_MESSAGES: intFromString(8),
  MEMORY_MINING_INTERVAL_SECONDS: intFromString(300),
  FEEDBACK_LEARNING_ENABLED: boolFromString(true),
  FEEDBACK_LOOKAHEAD_MESSAGES: intFromString(10),
  BRAIN_DEBUG_TTL_DAYS: intFromString(7),
  BOT_REPLIES_RETENTION_DAYS: intFromString(30),

  // Debug
  BRAIN_DEBUG_ENABLED: boolFromString(true),
  DEBUG_COMMANDS_ADMIN_ONLY: boolFromString(true),

  // Repetition guard
  REPETITION_SIMILARITY_THRESHOLD: floatFromString(0.72),

  // ---- Voice: TTS (Kokoro / OpenAI-compatible) ----
  TTS_ENABLED: boolFromString(false),
  TTS_BASE_URL: optStr, // e.g. http://192.168.178.87:8880
  TTS_MODEL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'tts-1')),
  TTS_VOICE: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'im_nicola')),
  TTS_API_KEY: optStr,
  TTS_FORMAT: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'wav')),
  TTS_SPEED: floatFromString(1),
  TTS_MAX_CHARS: intFromString(600),
  TTS_TIMEOUT_MS: intFromString(30000),
  TTS_TAIL_PADDING_MS: intFromString(600),
  // Probability of voicing a normal reply on its own (0..1). Voice replies to incoming voice are separate.
  TTS_AUTO_VOICE_PROBABILITY: floatFromString(0.12),
  // Always reply with voice when the user sent a voice message.
  TTS_REPLY_TO_VOICE: boolFromString(true),

  // ---- Voice: STT (local whisper.cpp) ----
  STT_ENABLED: boolFromString(false),
  WHISPER_BIN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'vendor/whisper.cpp/build/bin/whisper-cli')),
  WHISPER_MODEL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'vendor/models/ggml-base.bin')),
  FFMPEG_BIN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'vendor/bin/ffmpeg')),
  STT_LANGUAGE: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'auto')),
  STT_THREADS: intFromString(4),
  STT_TIMEOUT_MS: intFromString(60000),
  // Transcribe every incoming voice message (not only when the bot is addressed).
  STT_TRANSCRIBE_ALL: boolFromString(true),

  // Music: /sing /play (and natural language: "mi canti X", "suona X", "play X", "cántame X").
  // Searches YouTube via yt-dlp, extracts up to MUSIC_MAX_DURATION_SECONDS of audio, converts to
  // OGG/Opus and sends it as a voice note. Needs the yt-dlp binary + ffmpeg.
  MUSIC_ENABLED: boolFromString(true),
  YTDLP_BIN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'vendor/bin/yt-dlp')),
  MUSIC_MAX_DURATION_SECONDS: intFromString(720), // 12 minutes
  MUSIC_TIMEOUT_MS: intFromString(240000), // search + download + transcode budget
  MUSIC_PROXY: z.string().optional(), // optional outbound proxy for yt-dlp

  // ---- Link media rehost: download media from URLs posted in chat and re-upload as Telegram
  // attachments (native TypeScript extractors, no Python/yt-dlp). ffmpeg normalizes for Telegram.
  LINK_MEDIA_ENABLED: boolFromString(true),
  LINK_MEDIA_AUTO_REHOST: boolFromString(true),
  LINK_MEDIA_AI_COMMENT_ENABLED: boolFromString(true),
  LINK_MEDIA_COMMENT_ONLY_WHEN_ADDRESSED: boolFromString(false),
  LINK_MEDIA_MAX_URLS_PER_MESSAGE: intFromString(2),
  LINK_MEDIA_MAX_MEDIA_PER_URL: intFromString(6),
  LINK_MEDIA_MAX_DOWNLOAD_MB: intFromString(150),
  LINK_MEDIA_MAX_UPLOAD_MB: intFromString(45),
  LINK_MEDIA_MAX_DURATION_SECONDS: intFromString(180),
  LINK_MEDIA_AI_MAX_DURATION_SECONDS: intFromString(90),
  LINK_MEDIA_TIMEOUT_MS: intFromString(240000),
  LINK_MEDIA_CHAT_COOLDOWN_SECONDS: intFromString(8),
  LINK_MEDIA_USER_COOLDOWN_SECONDS: intFromString(20),
  LINK_MEDIA_TMP_DIR: z.string().default('.tmp-link-media'),
  LINK_MEDIA_ALLOWED_HOSTS: z.string().optional(),
  LINK_MEDIA_BLOCKED_HOSTS: z.string().optional(),
  LINK_MEDIA_NSFW_ALLOW: boolFromString(false),
  LINK_MEDIA_COOKIES_INSTAGRAM: z.string().optional(),
  LINK_MEDIA_COOKIES_TIKTOK: z.string().optional(),
  LINK_MEDIA_COOKIES_FACEBOOK: z.string().optional(),
  LINK_MEDIA_COOKIES_X: z.string().optional(),
  LINK_MEDIA_PROXY: z.string().optional(),
  LINK_MEDIA_CACHE_TTL_DAYS: intFromString(30),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Parse and validate process.env. Fails fast (throws) on invalid required config.
 * Optional capabilities (vision/image/transcription models, provider keys) never fail here.
 */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test helper to reset the cached env. */
export function resetEnvCache(): void {
  cached = null;
}
