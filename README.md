<p align="center">
  <img src="assets/banner.svg" alt="GoonerBot, the group gremlin" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-3c873a?logo=node.js&logoColor=white" alt="Node >= 22">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/Telegram-grammY-2aabee?logo=telegram&logoColor=white" alt="grammY">
  <img src="https://img.shields.io/badge/MongoDB-6.x-47a248?logo=mongodb&logoColor=white" alt="MongoDB">
  <img src="https://img.shields.io/badge/tests-vitest-6e9f18?logo=vitest&logoColor=white" alt="vitest">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
  <img src="https://img.shields.io/badge/docker-not%20required-555?logo=docker&logoColor=white" alt="no docker">
</p>

<h1 align="center">GoonerBot 🤖</h1>

<p align="center">
  <b>A group-native entertainment, roleplay, meme and memory Telegram bot for the <i>Gooners</i> community.</b><br>
  Not an assistant and not ChatGPT in a chat. It is a chat character that knows the group culture:
  it listens, remembers user and group lore, jumps in when it fits, runs chat modes, and keeps the
  group alive without spamming.
</p>

---

## Table of contents

- [Highlights](#highlights)
- [Quick start (no Docker)](#quick-start-no-docker)
- [Telegram setup and Privacy Mode](#telegram-setup-and-privacy-mode)
- [LLM providers](#llm-providers)
- [NSFW routing](#nsfw-routing)
- [Commands](#commands)
- [Built-in modes](#built-in-modes)
- [Voice (TTS and STT)](#voice-tts-and-stt)
- [Vision](#vision)
- [Web and image grounding](#web-and-image-grounding)
- [Per-user heat](#per-user-heat)
- [Knowledge base](#knowledge-base)
- [Images and autonomous posting](#images-and-autonomous-posting)
- [Brain and memory](#brain-and-memory)
- [Configuration](#configuration)
- [Security](#security)
- [Development and testing](#development-and-testing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Highlights

- Group chat character: reads the room, replies in context, short and direct.
- Per-chat modes you add, select and delete at runtime, plus built-in Gooners modes.
- Memory: manual and mined facts about users and the group, retrieved only when relevant.
- Per-user heat: hostility escalates with users who push the bot and cools when they back off.
- Auto-engage: a scorer decides when to jump in (cooldowns, hourly cap, confidence, risk).
- Voice in and out: local whisper.cpp STT (voice, audio, video) and Kokoro TTS voice notes.
- Vision: looks at photos and video frames through a separate vision endpoint.
- Free grounding: web search and reverse-image lookup via a self-hosted SearXNG, no API keys.
- Image sending: fetches a waifu/anime image online and vision-checks it before posting.
- Autonomous posting: timed, opt-in takes on current events (RSS) or a commented image, plus `/news`.
- Translation: `/translate` (alias `/traduci`) translates the replied message into any language.
- NSFW routing to a separate uncensored model, decided before generation, with a refusal backstop.
- Pluggable LLM backends (solclawn, OpenAI, DeepSeek, Ollama, any OpenAI-compatible host) with an
  optional fallback endpoint.
- No Docker and no Python. Node plus a local MongoDB. Strict TypeScript, ESM, eslint, prettier, vitest.

---

## Quick start (no Docker)

> Requirements: Node.js 23.3 (see `.nvmrc`) or a recent LTS, pnpm, and a running MongoDB.

```bash
# 1. Node
nvm use                      # picks up .nvmrc (23.3.0); or: nvm install 23.3.0

# 2. Install
pnpm install

# 3. MongoDB (any local instance). A helper for a user-local, auth-enabled mongod is included:
scripts/mongo-local.sh start         # or: sudo systemctl start mongod  / mongod --dbpath ./.mongo-data

# 4. Configure
cp .env.example .env
#   edit .env: set TELEGRAM_BOT_TOKEN, MONGO_URI and your LLM provider

# 5. Run
pnpm dev                     # watch mode (tsx)
# or production:
pnpm build && pnpm start
```

### Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` | run with hot reload (tsx) |
| `pnpm build` | compile TypeScript to `dist/` |
| `pnpm start` | run the compiled bot (`node dist/main.js`) |
| `pnpm typecheck` | strict type check, no emit |
| `pnpm lint` / `pnpm lint:fix` | eslint |
| `pnpm format` / `pnpm format:check` | prettier |
| `pnpm test` / `pnpm test:watch` | vitest |

---

## Telegram setup and Privacy Mode

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Add the bot to your group.
3. Put the deployer's `@handle` in `ADMIN_HANDLES` so they can run control commands anywhere, even
   without being a group admin. `ALLOWED_HANDLES=*` lets everyone chat.

By default Telegram bots run with Privacy Mode ON: the bot only receives commands, replies to its own
messages, and messages that mention it. Conversation tracking and auto-engage need every message, so
either disable Privacy Mode in @BotFather (`/setprivacy`, then remove and re-add the bot) or make the
bot a group admin. With Privacy Mode ON and no admin rights, commands, mentions and replies still work;
the bot just cannot passively track or auto-engage. No group ID is ever hardcoded.

---

## LLM providers

Pick a provider with `LLM_PROVIDER`. Base URL and model are configurable, nothing is hardcoded in
business logic. Media capabilities activate only when you set the matching model var; if unset, that
capability is disabled and the bot degrades gracefully instead of crashing.

```env
# solclawn (OpenAI-compatible router, default)
LLM_PROVIDER=solclawn
LLM_BASE_URL=https://llm.solclawn.com/v1
LLM_API_KEY=<router client bearer token>
LLM_MODEL=<a model exposed by the router, e.g. gpt-oss:latest>

# DeepSeek
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=<key>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

# Ollama / OpenAI / any OpenAI-compatible host
LLM_PROVIDER=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=llama3.1
```

An optional fallback endpoint (`LLM_FALLBACK_BASE_URL` + `LLM_FALLBACK_MODEL`) is used for chat and
reasoning calls when the primary throws (timeout, connection refused, 5xx), e.g. a local Ollama
gpt-oss on a GPU box. It is transparent to the rest of the code; vision, STT and TTS stay on the
primary. The provider reports capabilities (`chat`, `vision`, `transcription`, `imageGeneration`,
`tts`); a missing one is logged once and skipped.

---

## NSFW routing

GoonerBot can route adult turns to a separate uncensored model while keeping a normal model for
everyday banter. Set `LLM_NSFW_MODEL`. Routing is decided before generation (no extra LLM call) and
gated per chat by an admin.

| `/nsfw <mode>` | behaviour |
| --- | --- |
| `base` (or `on`) | the whole chat uses the uncensored model. |
| `off` | never use the uncensored model. |
| `smart` | default. Per message: an instant lexicon picks the uncensored model for NSFW-looking turns; for the rest the default model runs with a buffered refusal backstop, so a refusal is silently retried on the uncensored model and never shown. |

A custom mode created with a leading `[nsfw]` tag always routes to the uncensored model in
NSFW-enabled chats. Hard limits always apply regardless of model or mode: nothing involving minors,
no real-world non-consent, no sexual content about real named people without consent, nothing
illegal, no doxxing. NSFW is opt-in per chat and meant for private, consenting adult communities. If
`LLM_NSFW_MODEL` is empty, all routing is inert and the default model is always used.

---

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/start` | admin | wake GoonerBot in this chat |
| `/stop` | admin | put it to sleep |
| `/reset` | admin | wipe conversation memory |
| `/mode` | admin | pick a mode |
| `/addmode <description>` | admin | add a custom mode (`[nsfw]` prefix flags it adult) |
| `/deletemode` | admin | delete a mode |
| `/introduce <text>` | anyone | tell GoonerBot who you are (saved as lore) |
| `/fact` | anyone | mine durable lore from recent chat or the replied-to window |
| `/setfact @handle <text>` | admin | manually insert lore |
| `/facts [@handle]` | anyone | show stored lore |
| `/clearfacts [@handle]` | self / admin | expire stored lore (self anytime, others need admin) |
| `/lore` | anyone | top group lore (max 5) |
| `/forget` | reply / admin | reply to forget lore mined from a message; admin `/forget <id>` |
| `/translate <language>` | anyone | translate the replied message (alias `/traduci`) |
| `/voice` | anyone | turn the last message, or the replied one, into a voice note |
| `/news` | anyone | force an autonomous post now (alias `/nuovo`) |
| `/autopost` | admin | toggle timed autonomous posts in this chat |
| `/usage` | anyone | your usage and limits |
| `/language` | admin | set chat language (it, en, ru, es) |
| `/terms` | anyone | terms of use and acceptance |
| `/conversationtracker` | admin | toggle passive tracking |
| `/autofact` | admin | toggle automatic fact extraction |
| `/autoengage` | admin | toggle auto-engage |
| `/nsfw [off\|base\|smart]` | admin | NSFW model routing |
| `/ban @handle [seconds]` | bot admin | ban a Gooner (reply-aware, duration optional, 0 = permanent) |
| `/unban @handle` | bot admin | unban a Gooner |
| `/brain`, `/debuglast` | admin | inspect why the bot answered the way it did |
| `/help` | anyone | help |

admin means group admin or bot admin (`ADMIN_HANDLES`). bot admin means listed in `ADMIN_HANDLES`.
Most commands that act on the chat need `/terms` accepted first.

---

## Built-in modes

| Mode | Vibe |
| --- | --- |
| `default` | natural group participant, funny, short, contextual |
| `roast` | light roast and banter, never hateful, no protected categories |
| `hype` | hypes the group: raids, announcements, wins, updates |
| `lorekeeper` | tracks recurring jokes, group and user facts, callbacks |
| `chaos` | unpredictable but rate-limited and safe |
| `market_degen` | crypto and degen vibes, never financial advice as certainty |
| `meme_recorder` | turns funny moments into quote/meme candidates and remembers them |

Add your own with `/addmode <description>` (the mode name is the first sentence). Prefix with
`[nsfw]` to make it adult.

---

## Voice (TTS and STT)

- STT: a local whisper.cpp build transcribes incoming voice notes, audio files, videos and round
  video-notes. ffmpeg extracts the audio track from video containers, so the brain reads them as
  text and stores them as context. No cloud, modest CPU.
- TTS: an OpenAI-compatible `/v1/audio/speech` server (for example
  [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)) synthesizes replies. With
  `TTS_FORMAT=opus` the server returns Telegram-ready OGG/Opus, so the host needs no local ffmpeg for
  TTS; other formats are transcoded locally.
- The bot replies with a voice note when you sent it one (`TTS_REPLY_TO_VOICE`), or occasionally on
  its own (`TTS_AUTO_VOICE_PROBABILITY`).
- `/voice` voices the last chat message, or the replied-to message when used as a reply.
- Multilingual: the TTS voice and whisper language follow the chat language (it `im_nicola`, en
  `am_michael`, es `em_alex`; no Russian voice, so it falls back to the default).

```bash
# 1. Provision the local toolchain into vendor/ (gitignored): static ffmpeg, whisper.cpp, model
scripts/setup-voice.sh           # or: scripts/setup-voice.sh small   (better Italian, more CPU)

# 2. Enable in .env
TTS_ENABLED=true
TTS_BASE_URL=http://<kokoro-host>:8880
TTS_VOICE=im_nicola
STT_ENABLED=true                 # paths default to the vendor/ build
```

Verify the round-trip with `pnpm tsx scripts/smoke-voice.ts`. The default whisper model is `base`
(multilingual, ~142 MB); set `WHISPER_MODEL` to `small` for better Italian at a bit more CPU. No GPU
required.

---

## Vision

The bot can look at photos and at a frame extracted from a video, then react. Vision is gated by
`LLM_VISION_MODEL`. Because some chat backends (such as solclawn) have no vision, it can target a
separate OpenAI-compatible endpoint, ideally an Ollama on a box with a GPU:

```bash
# on the GPU host:
ollama pull minicpm-v4.5         # or: gemma4 / qwen3-vl / llava / moondream
# make sure Ollama listens on the LAN: OLLAMA_HOST=0.0.0.0:11434

# in .env:
LLM_VISION_MODEL=minicpm-v4.5:8b
LLM_VISION_BASE_URL=http://<gpu-host>:11434/v1   # empty reuses LLM_BASE_URL/LLM_API_KEY
LLM_VISION_API_KEY=                              # Ollama needs none
```

Images are analysed only when the bot is addressed (mention or reply), for the current message or the
replied-to one. If the endpoint is down, vision degrades gracefully.

---

## Web and image grounding

When a turn needs facts the model cannot know, a grounding layer fetches them and injects a context
block; the persona model still writes the reply. Two heuristic-gated triggers run in parallel with
memory retrieval, both backed by a free self-hosted SearXNG (no API keys):

- Web search for recency or factual questions (who won yesterday, how much is the 5090, latest news).
- Image lookup for "who/what is this" or product questions: the vision model identifies the subject
  of a photo or video frame, then SearXNG searches that identification for confirmation and product
  links. This is the free equivalent of Google Lens, which now needs a headless browser and a public
  image URL.

Everything degrades to nothing on failure, and the model is told never to claim it searched the web.

```bash
# 1. One-time: clone SearXNG, venv, deps, settings, and install a systemd --user service
scripts/searxng.sh setup
# 2. Run it on 127.0.0.1:8888 (systemd --user service: auto-restart, survives reboot via lingering;
#    falls back to a plain process where systemd --user is unavailable)
scripts/searxng.sh start          # stop | restart | status

# 3. Enable in .env
WEB_SEARCH_ENABLED=true
SEARXNG_URL=http://127.0.0.1:8888
IMAGE_LOOKUP_ENABLED=true         # needs WEB_SEARCH_ENABLED and a vision model
```

Verify with `pnpm tsx scripts/smoke-search.ts`. Gating lives in `src/search/groundingService.ts`,
the SearXNG client in `src/search/searxng.ts`.

---

## Per-user heat

Hostility is tracked per user, per chat as a `heat` score from 0 to 100 (collection `user_heat`). It
starts gruff (`HEAT_BASELINE`), rises when someone attacks or pushes the bot, and decays over time,
faster when the user de-escalates (apologizes, calms down). The score maps to an escalation level
(baseline, irritato, ostile, incazzato, furia) that raises the aggression dial and injects a hostility
directive aimed at that specific user. So the bot can be venomous with one person and normal with the
rest. Logic in `src/services/heat.ts`; knobs `HEAT_ENABLED`, `HEAT_BASELINE`, `HEAT_DECAY_PER_MINUTE`.

---

## Knowledge base

A curated `knowledge` collection (anime, manga, otaku and Asian pop culture, gaming, IT and dev,
crypto, sci-fi and TV) is recalled only when relevant: a keyword match against the message surfaces
the top `KNOWLEDGE_MAX_ITEMS` entries as a short, clearly optional context block. Most turns match
nothing, so it adds no prompt weight and never makes the character monothematic. Seeded on boot from
`src/knowledge/seed.ts` (`KNOWLEDGE_SEED_ON_BOOT`, idempotent); retrieval in
`src/knowledge/knowledgeRetriever.ts`. Extend the seed freely.

---

## Images and autonomous posting

Sending images, free and without an image-generation model: the bot occasionally posts a waifu or
anime image that fits its taste. The image is fetched online through SearXNG image search, then
downloaded and looked at by the vision model before it is ever sent; off-theme, unsafe or real-person
results are rejected. In replies it attaches one at `IMAGE_SEND_PROBABILITY` when the topic is anime
or waifu. See `src/media/imageFinder.ts` (needs SearXNG and a vision model).

Autonomous posting: every `AUTOPOST_INTERVAL_MINUTES`, with `AUTOPOST_PROBABILITY` per eligible chat,
the bot drops an unprompted line. It is either a styled take on a current event pulled from RSS
(`RSS_FEEDS`) with the source link, or a commented waifu image, split by `AUTOPOST_IMAGE_RATIO`. It is
opt-in per chat (`/autopost`, default off) and can be forced on demand with `/news` (alias `/nuovo`).
Composer in `src/services/autonomousPoster.ts`, feeds in `src/news/newsService.ts`.

---

## Brain and memory

GoonerBot does not dump facts into every prompt. Each reply runs a small pipeline so it behaves like a
real group member rather than a deterministic bot:

```text
message -> Scene Analyzer -> Memory Retriever (+ grounding, knowledge, heat in parallel) ->
           Reply Planner -> Style Engine -> Response Generator -> Ranker -> Repetition Guard ->
           reply  +  (background) Memory Mining and Feedback Learning
```

- Scene Analyzer reads topic, energy, intent and whether the bot is being roasted (LLM with a
  deterministic fallback).
- Memory Retriever pulls only the few memories relevant to this turn (scored by handle, keyword,
  topic and salience), skips recently-used ones, and returns nothing when the chat is roasting the bot
  for repetition.
- Reply Planner and Style Engine pick intent, tone, length and one of ten voice variants. A dynamic
  banned-phrases list, built from recent replies, kills repeated openings and catchphrase tics.
- The Generator produces one candidate by default (configurable). The Ranker and Repetition Guard
  drop assistant-tone, repeated or verbatim-memory replies and regenerate if needed.
- The reply always addresses the current speaker, and attached media carries who posted it so the
  roast target is unambiguous.
- Memory lives in `memory_items` (mined lore with confidence, salience and toxicity), not raw text.
  Background jobs mine lore while the bot is silent (in `/autofact` chats) and learn from feedback.
- Admins use `/brain` and `/debuglast` to see exactly why the bot answered the way it did.

Internal pipeline instructions are written in English (the model follows them best) while the bot is
told to reply in the chat language. The legacy `facts` collection is auto-migrated into `memory_items`
on first boot.

---

## Configuration

Validated with zod at startup; the bot fails fast on a missing or invalid required var. Optional
capabilities never block startup. Copy `.env.example` to `.env` (gitignored; never commit secrets).
The tables below list the common vars; see `.env.example` for the full set with comments.

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | Token from @BotFather. |
| `BOT_USERNAME` | `GoonerBot` | Hint only; the real username is resolved at boot. |
| `ALLOWED_HANDLES` | `*` | Comma `@handles` allowed to use the bot. Empty or `*` means everyone. |
| `ADMIN_HANDLES` | none | Comma `@handles` that are bot admins. |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/goonerbot` | Connection string. |
| `MONGO_DB` | `goonerbot` | Database name. |
| `NODE_ENV` | `development` | `production` gives JSON logs. |
| `LOG_LEVEL` | `info` | pino level. |

### LLM and media

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_PROVIDER` | `ollama` | `solclawn`, `openai`, `deepseek`, `ollama`, `custom_openai_compatible`. |
| `LLM_BASE_URL` | per-provider | OpenAI-compatible base URL. |
| `LLM_API_KEY` | none | Bearer token. |
| `LLM_MODEL` | none | Chat model (required for text replies). |
| `LLM_VISION_MODEL` | none | Enables image and video-frame understanding. |
| `LLM_VISION_BASE_URL` / `LLM_VISION_API_KEY` | none | Separate vision endpoint; empty reuses the main one. |
| `LLM_TRANSCRIPTION_MODEL` | none | Remote STT fallback; local whisper covers this otherwise. |
| `LLM_TTS_MODEL` / `LLM_IMAGE_MODEL` | none | Enable remote TTS / image generation if your backend has them. |
| `LLM_FALLBACK_BASE_URL` / `LLM_FALLBACK_MODEL` / `LLM_FALLBACK_API_KEY` | none | Fallback chat endpoint when the primary throws. |
| `LLM_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout. |

### Voice, grounding, images, autopost

| Variable | Default | Description |
| --- | --- | --- |
| `TTS_ENABLED` / `TTS_BASE_URL` / `TTS_VOICE` / `TTS_FORMAT` | off | Kokoro TTS. `opus` offloads encoding to the server. |
| `STT_ENABLED` / `WHISPER_MODEL` / `FFMPEG_BIN` | off | Local whisper.cpp STT (vendor/ defaults). |
| `WEB_SEARCH_ENABLED` / `SEARXNG_URL` | off | Web grounding via SearXNG. |
| `IMAGE_LOOKUP_ENABLED` | off | Reverse-image grounding (needs web search and vision). |
| `IMAGE_SEND_ENABLED` / `IMAGE_SEND_PROBABILITY` | on / `0.15` | Attach a verified waifu image on anime topics. |
| `IMAGE_QUERY_POOL` | defaults | Comma-separated image query seeds. |
| `AUTOPOST_ENABLED` / `AUTOPOST_DEFAULT_ENABLED` | on / off | Scheduler switch / per-chat default (opt-in). |
| `AUTOPOST_INTERVAL_MINUTES` / `AUTOPOST_PROBABILITY` | `10` / `0.05` | Tick interval / chance per eligible chat. |
| `AUTOPOST_IMAGE_RATIO` | `0.4` | Share of autoposts that are an image vs a news take. |
| `RSS_FEEDS` | BBC, CNN, ANSA, Verge | Comma-separated feed URLs. |

### NSFW, heat, knowledge, brain

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_NSFW_MODEL` | none | Uncensored model. Empty disables NSFW routing. |
| `LLM_NSFW_DEFAULT_MODE` | `smart` | Initial per-chat mode: `off`, `base`, `smart`. |
| `LLM_REFUSAL_FALLBACK` | `true` | Retry on the NSFW model if the default refuses. |
| `HEAT_ENABLED` / `HEAT_BASELINE` / `HEAT_DECAY_PER_MINUTE` | on / `12` / `1` | Per-user hostility escalation. |
| `KNOWLEDGE_ENABLED` / `KNOWLEDGE_MAX_ITEMS` / `KNOWLEDGE_SEED_ON_BOOT` | on / `2` / on | On-demand knowledge recall. |
| `REPLY_TEMPERATURE` / `REPLY_CANDIDATE_COUNT` | `0.95` / `1` | Generation temperature / candidates per reply. |
| `MAX_REPLY_LINES` / `MAX_REPLY_CHARS` | `3` / `420` | Reply length caps. |
| `MEMORY_MINING_ENABLED` / `FEEDBACK_LEARNING_ENABLED` | on / on | Background lore mining and feedback learning. |

### Behaviour and limits

| Variable | Default | Description |
| --- | --- | --- |
| `DEFAULT_LANGUAGE` | `italian` | `italian`, `english`, `russian`, `spanish`; per chat via `/language`. |
| `AUTOENGAGE_DEFAULT_ENABLED` / `CONVERSATION_TRACKER_DEFAULT_ENABLED` | on / on | Initial toggles for new chats. |
| `MAX_REPLIES_PER_CHAT_PER_HOUR` | `15` | Hard cap on bot replies per chat per hour. |
| `AUTOENGAGE_MIN_COOLDOWN_SECONDS` / `AUTOENGAGE_USER_COOLDOWN_SECONDS` | `45` / `20` | Passive-reply cooldowns. |
| `MESSAGE_HISTORY_RETENTION_DAYS` / `MAX_CONTEXT_MESSAGES` | `30` / `25` | Message TTL / context window. |
| `COMMAND_RATE_LIMIT_SECONDS` | `1` | Min seconds between accepted commands per user. |

---

## Security

GoonerBot is built for an authorized, self-hosted deployment.

| Area | Posture |
| --- | --- |
| Secrets | Only in `.env` (gitignored). No hardcoded tokens or keys in source. The LLM key is sent as a Bearer header and never logged. |
| Logging | Structured (pino). The bot token, LLM key and Mongo URI are never logged. |
| Auth | Centralized permission service. Control commands require group admin or bot admin; `/ban` requires bot admin. Callback queries are permission-checked. |
| Bans | Gated on commands and in the message handler; timed bans auto-expire. |
| NoSQL injection | Mongo queries use fixed field names with user input only as scalar values; no `$where` or `eval`; ids guarded by `ObjectId.isValid`. |
| Rate limiting | Per-user command cooldown, autoengage cooldowns and hourly cap, usage limits, media download size cap (20 MB). |
| Media and SSRF | Inbound files come only from Telegram's file API. Outbound hosts are operator-configured, not user input. Fetched images are size-capped and vision-checked. |
| MongoDB | Run it bound to `127.0.0.1` with `--auth` and a least-privilege app user (`scripts/mongo-local.sh` does this). |
| Content safety | NSFW is opt-in per chat with non-negotiable hard limits in the system prompt. |

Prompt-injection and jailbreak attempts in user messages are mitigated by system-prompt guardrails
but not eliminated; treat model output as untrusted. Keep `ADMIN_HANDLES` tight and Mongo off the
public network. To report a vulnerability, open a private security advisory on the repository.

---

## Development and testing

```bash
pnpm typecheck      # strict TS
pnpm lint           # eslint
pnpm format:check   # prettier
pnpm test           # vitest (unit tests use fakes, no live Mongo needed)
```

Optional integration and smoke harnesses live in `scripts/` and need a real Mongo or the matching
backend:

```bash
pnpm tsx scripts/smoke-integration.ts   # storage, LLM, reply and routing, end to end
pnpm tsx scripts/smoke-telegram.ts      # synthetic Telegram updates through the real bot
pnpm tsx scripts/smoke-voice.ts         # TTS to OGG/Opus to whisper round-trip
pnpm tsx scripts/smoke-search.ts        # SearXNG query and grounding gating
```

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `/start` says you cannot do that here | You are not a group admin and not in `ADMIN_HANDLES`. Add your `@handle`. |
| Bot ignores normal messages | Privacy Mode is ON. Disable it in @BotFather (then re-add the bot) or make the bot a group admin. |
| Replies in the wrong language | Existing chats keep their stored language; run `/language`. New chats use `DEFAULT_LANGUAGE`. |
| A capability is unavailable | The relevant `LLM_*_MODEL` is not set (vision, image, transcription). Set it or ignore. |
| Web search or images do nothing | SearXNG is not running or `SEARXNG_URL` is wrong. Start it with `scripts/searxng.sh start`. |
| Bot will not start | Read the fail-fast error, usually a missing `TELEGRAM_BOT_TOKEN` or unreachable `MONGO_URI`. |

---

## License

MIT. See [LICENSE](./LICENSE).
