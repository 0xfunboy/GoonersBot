<p align="center">
  <img src="assets/banner.svg" alt="GoonerBot — the group gremlin" width="100%">
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
  <b>A group-native entertainment, roleplay, meme, banter & memory AI bot for the <i>Gooners</i> Telegram community.</b><br>
  Not an assistant. Not ChatGPT dropped into a chat. A chat <i>character</i> that knows the group culture —
  it listens, remembers group & user lore, jumps in when it's funny or useful, runs roleplay/chat modes,
  and keeps the group alive without being a spammy menace.
</p>

---

## Table of contents

- [Highlights](#highlights)
- [Quick start (no Docker)](#quick-start-no-docker)
- [Telegram setup & Privacy Mode](#telegram-setup--privacy-mode)
- [LLM providers](#llm-providers)
- [NSFW / adult content routing](#nsfw--adult-content-routing)
- [Commands](#commands)
- [Built-in modes](#built-in-modes)
- [How it works](#how-it-works)
- [Configuration (all env vars)](#configuration-all-env-vars)
- [Memory & data model](#memory--data-model)
- [Security](#security)
- [Development & testing](#development--testing)
- [Troubleshooting](#troubleshooting)
- [Origins](#origins)
- [License](#license)

---

## Highlights

- 🗣️ **Group chat character** — reads the room, replies in context, short & punchy.
- 🎭 **Chat-bounded modes** — per-chat personalities you add / select / delete at runtime.
- 🔥 **Built-in Gooners modes** — `default`, `roast`, `hype`, `lorekeeper`, `chaos`, `market_degen`, `meme_recorder`.
- 🧠 **Memory** — manual + automatic facts about users and the group, self-introductions, lore.
- ⚡ **Auto-engage** — an `AutoEngageScorer` decides *when* to intervene (cooldowns, hourly caps, confidence, risk; never chain-spams).
- 👂 **Conversation tracking** — optional passive listening with configurable retention (TTL).
- 🖼️ **Media** — image input (vision), voice input (transcription), text output, image output, optional TTS — all capability-gated and degrade gracefully.
- 🔞 **NSFW routing** — route adult turns to a separate uncensored model, decided *before* generation (low latency) + a buffered refusal backstop.
- 📊 **Usage tracking & limits** — per user / chat / provider, token + call + cost accounting.
- 🛡️ **Permissions, bans (with expiry), terms of use**, multi-language (🇮🇹 default · 🇬🇧 · 🇷🇺 · 🇪🇸).
- 🔌 **Pluggable LLM backends** — solclawn, OpenAI, DeepSeek, Ollama, or any OpenAI-compatible host.
- 🧰 **No Docker, no Python** — Node + a local MongoDB. Strict TypeScript, ESM, eslint/prettier, vitest.

---

## Quick start (no Docker)

> Requirements: **Node.js 23.3** (preferred — see `.nvmrc`) or latest LTS (Node 22/24+), **pnpm**, and a running **MongoDB**.

```bash
# 1. Node
nvm use                      # picks up .nvmrc (23.3.0); or `nvm install 23.3.0`

# 2. Install
pnpm install

# 3. MongoDB (any local instance). A helper script for a user-local, auth-enabled mongod is included:
#    (downloads nothing — expects a mongod binary; see scripts/mongo-local.sh)
scripts/mongo-local.sh start         # or: sudo systemctl start mongod  / mongod --dbpath ./.mongo-data

# 4. Configure
cp .env.example .env
#   edit .env: set TELEGRAM_BOT_TOKEN, MONGO_URI, and your LLM provider

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

## Telegram setup & Privacy Mode

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token into `TELEGRAM_BOT_TOKEN`.
2. Add the bot to your group.
3. Set who controls it: put the deployer's `@handle` in **`ADMIN_HANDLES`** so they can run control
   commands anywhere (even without being a group admin). `ALLOWED_HANDLES=*` lets everyone chat.

### ⚠️ Privacy Mode (required for passive features)

By default Telegram bots run with **Privacy Mode ON** — the bot only receives: `/commands`, replies
to its own messages, and messages that `@mention` it. It does **not** see ordinary group chatter.

**Conversation tracking** and **auto-engage** need to see all messages. Enable them with either:

- **Disable Privacy Mode** in @BotFather: `/setprivacy` → your bot → **Disable**, then **remove &
  re-add** the bot to the group, **or**
- Make the bot a **group admin** (admins receive all messages).

With Privacy Mode ON and the bot not an admin, GoonerBot still fully works for commands, @mentions and
replies — it just can't passively track or auto-engage. No group ID is ever hardcoded.

---

## LLM providers

Pick a provider with `LLM_PROVIDER`. The base URL and model are configurable — nothing is hardcoded in
business logic. Media capabilities activate only when you set the corresponding model var; if unset,
that capability is disabled and the bot degrades gracefully (a clean message, never a crash).

<details>
<summary><b>solclawn</b> — OpenAI-compatible router (default)</summary>

```env
LLM_PROVIDER=solclawn
LLM_BASE_URL=https://llm.solclawn.com/v1
LLM_API_KEY=<router client bearer token>
LLM_MODEL=<a model exposed by the router, e.g. gpt-oss:latest>
# optional media models:
LLM_VISION_MODEL=
LLM_IMAGE_MODEL=
LLM_TRANSCRIPTION_MODEL=
```
Uses the OpenAI-compatible adapter against `LLM_BASE_URL` with `Authorization: Bearer ${LLM_API_KEY}`
(`/v1/chat/completions`, model = the router's model name).
</details>

<details>
<summary><b>DeepSeek</b></summary>

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=<key>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```
</details>

<details>
<summary><b>Ollama / OpenAI / custom OpenAI-compatible</b></summary>

```env
# Ollama (local)
LLM_PROVIDER=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=llama3.1

# OpenAI
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# anything OpenAI-compatible
LLM_PROVIDER=custom_openai_compatible
LLM_BASE_URL=https://your-host/v1
LLM_API_KEY=...
LLM_MODEL=...
```
</details>

The provider exposes **capabilities** (`chat`, `vision`, `transcription`, `imageGeneration`, `tts`).
A missing capability logs once and is skipped — one missing media feature never crashes the bot.

---

## NSFW / adult content routing

GoonerBot can route adult/NSFW turns to a separate **uncensored** model while keeping a normal model
for everyday banter. Set `LLM_NSFW_MODEL` (an uncensored model exposed by your backend). Routing is
decided **before** generation (no extra-LLM-call latency) and gated **per-chat** by an admin.

| `/nsfw <mode>` | behaviour |
| --- | --- |
| `base` (or `on`) | the whole chat uses the uncensored model. |
| `off` | never use the uncensored model. |
| `smart` | **Default.** Per-message: an instant lexicon picks the uncensored model for NSFW-looking turns; for the rest, the default model runs with a **buffered refusal backstop** — if it starts to refuse, GoonerBot silently switches and never shows the refusal. |

- A custom mode created with a leading `[nsfw]` tag (e.g. `/addmode [nsfw] Filth. very explicit`)
  always routes to the uncensored model in NSFW-enabled chats.
- **Hard limits always apply** regardless of model/mode: nothing involving minors, no real-world
  non-consent, no sexual content about real named people without consent, nothing illegal, no doxxing.
- NSFW is opt-in per chat and intended for **private, consenting adult** communities. If
  `LLM_NSFW_MODEL` is empty, all routing is inert and the default model is always used.

---

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/start` | admin¹ | wake GoonerBot in this chat |
| `/stop` | admin¹ | put it to sleep |
| `/reset` | admin¹ | wipe conversation memory |
| `/mode` | admin¹ | pick a mode |
| `/addmode <description>` | admin¹ | add a custom mode (`[nsfw]` prefix flags it adult) |
| `/deletemode` | admin¹ | delete a mode |
| `/introduce <text>` | anyone² | tell GoonerBot who you are (saved as lore) |
| `/fact` | anyone² | **mine** durable lore from recent chat (or the replied-to window) — no more arbitrary poisoning |
| `/setfact @handle <text>` | admin | manually insert lore |
| `/facts [@handle]` | anyone | show stored lore (reads `memory_items`) |
| `/clearfacts [@handle]` | self / admin | expire stored lore (self anytime; others = admin) |
| `/lore` | anyone | top group lore (max 5) |
| `/forget` | reply / admin | reply to a message to forget lore mined from it; admin `/forget <id>` |
| `/usage` | anyone | your usage & limits |
| `/voice` | anyone | turn the last message (or the replied one) into a voice note |
| `/language` | admin¹ | set chat language (it / en / ru / es) |
| `/terms` | anyone | terms of use + acceptance |
| `/conversationtracker` | admin¹ | toggle passive tracking |
| `/autofact` | admin¹ | toggle automatic fact extraction |
| `/autoengage` | admin¹ | toggle auto-engage |
| `/nsfw [off\|base\|smart]` | admin¹ | NSFW model routing |
| `/ban @handle [seconds]` | bot admin³ | ban a Gooner (reply-aware; duration optional, 0 = permanent) |
| `/unban @handle` | bot admin³ | unban a Gooner |
| `/help` | anyone | help |

¹ **admin** = group admin **OR** bot admin (`ADMIN_HANDLES`). · ² requires accepting `/terms` first. ·
³ **bot admin** = listed in `ADMIN_HANDLES`.

---

## Built-in modes

| Mode | Vibe |
| --- | --- |
| 😎 `default` | natural group participant — funny, short, contextual |
| 🔥 `roast` | light roast & banter, never hateful, no protected categories |
| 🚀 `hype` | hypes the group: raids, announcements, wins, updates |
| 📜 `lorekeeper` | tracks recurring jokes, group/user facts, lore, callbacks |
| 🌀 `chaos` | unpredictable but rate-limited and safe |
| 📈 `market_degen` | crypto/degen vibes — jokes & vibes, **never** financial advice as certainty |
| 🎞️ `meme_recorder` | turns funny moments into quote/meme candidates and remembers them |

Add your own: `/addmode <description>` (the mode name is the first sentence). Prefix with `[nsfw]` to
make it adult.

---

## How it works

```text
Telegram (grammY) → adapter/handlers → domain services → repositories (MongoDB)
                                     ↘ LLM providers (OpenAI-compatible / DeepSeek)
                                     ↘ ModelRouter (SFW vs NSFW, pre-generation)
                                     ↘ prompt builders
                                     ↘ jobs (retention cleanup)
```

Clean layers, platform-agnostic core (the Telegram adapter is thin; business logic lives in services):

- **`src/config`** — zod env validation, app config, default modes, i18n.
- **`src/domain`** — platform-agnostic types + Mongo entity shapes.
- **`src/storage`** — Mongo connection + one repository per collection + index setup.
- **`src/providers/llm`** — `LLMProvider` abstraction + OpenAI-compatible/DeepSeek adapters + factory.
- **`src/providers/media`** — capability-gated vision/transcription/image routing.
- **`src/prompts`** — composable prompt builders (identity, mode, facts, safety, autoengage, extraction).
- **`src/services`** — permissions, terms, bans, modes, facts, usage, conversation, autoengage, reply, model-router.
- **`src/telegram`** — context builders, keyboards, render, dispatch, command/callback/message handlers.
- **`src/jobs`** — in-process scheduler + retention cleanup.

**Message flow:** permission gate → chat-started + tracking/mention gate → terms gate → `AutoEngageScorer`
decides (mention/reply ⇒ almost always; passive ⇒ LLM-scored + cooldowns + hourly cap) → not engaging
but tracking ⇒ store as context → engaging ⇒ usage check → `ModelRouter` picks the model → **streamed**
reply (throttled edits) + optional generated image → persist user/bot messages → record usage → inline
auto-fact extraction (if `/autofact`).

---

## Voice (TTS + STT)

GoonerBot can listen to and send voice notes — both fully local-ish and cheap.

- **STT (speech-to-text):** a local **whisper.cpp** build transcribes incoming **voice notes,
  audio files, videos and round video-notes** to text so the brain "reads" them (and stores them as
  context). ffmpeg extracts the audio track from video containers — no cloud, modest CPU.
- **TTS (text-to-speech):** an OpenAI-compatible `/v1/audio/speech` server (e.g.
  [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), the one airi-stack uses) synthesizes
  replies; ffmpeg transcodes to Telegram-ready OGG/Opus.
- The bot **replies with a voice note** when you sent it a voice note (`TTS_REPLY_TO_VOICE`), or
  occasionally on its own (`TTS_AUTO_VOICE_PROBABILITY`).
- **`/voice`** turns the last chat message into a voice note — or, used as a *reply* to a message,
  voices **that** message.
- **Multilingual:** the TTS voice and whisper language follow the chat's `/language`
  (🇮🇹 `im_nicola` · 🇬🇧 `am_michael` · 🇪🇸 `em_alex`; no Russian voice → falls back to the default).
- **Offloaded encoding:** with `TTS_FORMAT=opus` the Kokoro server returns Telegram-ready OGG/Opus,
  so the bot host needs **no local ffmpeg for TTS** (only STT still decodes incoming voice locally).

### Setup

```bash
# 1. Provision the local toolchain into vendor/ (gitignored): static ffmpeg + whisper.cpp + model
scripts/setup-voice.sh           # or: scripts/setup-voice.sh small   (better Italian, more CPU)

# 2. Enable in .env
TTS_ENABLED=true
TTS_BASE_URL=http://<your-kokoro-host>:8880
TTS_VOICE=im_nicola              # Italian male; im/if_* = Italian, af/am_* = English, ...
STT_ENABLED=true                 # paths default to the vendor/ build
```

Verify the round-trip (TTS → OGG/Opus → whisper) with `pnpm tsx scripts/smoke-voice.ts`.
The default whisper model is `base` (multilingual, ~142 MB, fast); switch to `small` via
`WHISPER_MODEL` for better Italian at a bit more CPU. No GPU required.

## Vision (image understanding)

The bot can look at photos and react to them. Vision is capability-gated by `LLM_VISION_MODEL`.
Because some chat backends (e.g. solclawn) have **no vision**, vision can target a **separate**
OpenAI-compatible endpoint — ideally an Ollama on a box with a GPU:

```bash
# on the GPU host (e.g. the same machine that runs Kokoro):
ollama pull llama3.2-vision        # or: gemma3 (multimodal) · llava · moondream (tiny) · qwen2.5vl (OCR)
# make sure Ollama listens on the LAN: OLLAMA_HOST=0.0.0.0:11434

# in .env:
LLM_VISION_MODEL=llama3.2-vision
LLM_VISION_BASE_URL=http://<gpu-host>:11434/v1   # empty => reuse LLM_BASE_URL/LLM_API_KEY
LLM_VISION_API_KEY=                              # Ollama needs none
```

When a photo arrives (and the bot is addressed), it is described via this endpoint and the
description feeds the brain. If the endpoint is down, vision degrades gracefully (logged, skipped).

## Web & image grounding (free, no API keys)

The bot stays *cultured* without losing its voice: when a turn needs facts it can't know, a
**grounding** layer fetches them and injects a context block — the persona model still writes the
reply. Two heuristic-gated triggers run in parallel with memory retrieval:

- **Web search** — recency/factual questions ("chi ha vinto ieri", "quanto costa la 5090",
  "latest news on X") are answered with fresh results from a self-hosted **SearXNG**.
- **Image lookup** (Lens-equivalent) — reply to a photo with "chi è questo personaggio / che
  prodotto è / dove lo compro" and the **vision model identifies** the subject, then that
  identification is searched on SearXNG for confirmation + product links. (Real Google Lens is now
  client-rendered and needs a headless browser + a public image URL; this free path avoids both.)

Everything degrades to null on failure, and the model is told never to say it "searched the web".

### Setup (free, no Docker, no keys)

```bash
# 1. One-time: clone SearXNG + venv + deps + settings + install a systemd --user service
scripts/searxng.sh setup
# 2. Run it (127.0.0.1:8888). Uses the systemd --user service (auto-restart, survives reboot
#    via lingering); falls back to a nohup process where systemd --user is unavailable.
scripts/searxng.sh start          # stop | restart | status

# 3. Enable in .env
WEB_SEARCH_ENABLED=true
SEARXNG_URL=http://127.0.0.1:8888
IMAGE_LOOKUP_ENABLED=true         # needs WEB_SEARCH_ENABLED + LLM_VISION_MODEL
```

Verify with `pnpm tsx scripts/smoke-search.ts` (live query + gating). Gating keywords live in
`src/search/groundingService.ts`; the SearXNG client is `src/search/searxng.ts`.

## Per-user heat (escalation)

Hostility is tracked **per user, per chat** as a `heat` score (0–100, collection `user_heat`). It
starts gruff (`HEAT_BASELINE`), rises when someone attacks/pushes the bot (insults, criticism), and
**decays over time** — faster when the user de-escalates (apologizes, calms down). The current heat
maps to an escalation level (`baseline → irritato → ostile → incazzato → furia`) that raises the
aggression dial and injects a hostility directive aimed at *that* user. Knobs: `HEAT_ENABLED`,
`HEAT_BASELINE`, `HEAT_DECAY_PER_MINUTE`. Logic in `src/services/heat.ts`.

## Knowledge base (on-demand RAG)

A curated `knowledge` collection (anime/manga/otaku, Asian pop culture, gaming, IT/dev, crypto,
sci-fi/TV) is recalled **only when relevant**: a keyword/alias match against the message surfaces the
top `KNOWLEDGE_MAX_ITEMS` entries as a short, clearly-optional context block — most turns match
nothing, so it adds **zero prompt weight** and never makes the character monothematic. Seeded on boot
from `src/knowledge/seed.ts` (`KNOWLEDGE_SEED_ON_BOOT`, idempotent upsert); retrieval in
`src/knowledge/knowledgeRetriever.ts`. Extend the seed freely.

## Images & autonomous posting

**Sending images (free, no image-gen model):** the bot occasionally drops a waifu/anime image that
fits its taste. It is fetched online via SearXNG image search, then **vision-verified** (downloaded
and looked at by the vision model) before it's ever sent — off-theme / unsafe / real-person hits are
rejected. In replies it attaches one at `IMAGE_SEND_PROBABILITY` when the topic is anime/waifu.
(`ImageFinder`, `src/media/imageFinder.ts`. Needs SearXNG + a vision model.)

**Autonomous posting:** every `AUTOPOST_INTERVAL_MINUTES`, with `AUTOPOST_PROBABILITY` per eligible
chat, the bot drops an unprompted line — a styled take on a **current event** (pulled from RSS,
`RSS_FEEDS`) with the source link, or a commented waifu image (`AUTOPOST_IMAGE_RATIO` split). It is
**opt-in per chat** (`/autopost`, default off) and also triggerable on demand with **`/news`** (alias
**`/nuovo`**). Composer in `src/services/autonomousPoster.ts`, feeds in `src/news/newsService.ts`.

## Brain & memory

GoonerBot doesn't dump facts into every prompt. Each reply runs a small **brain pipeline** so it
behaves like a real group member, not a deterministic bot:

```text
message → Scene Analyzer → Memory Retriever → Reply Planner → Style Engine →
          Response Generator (1+ candidates) → Ranker → Repetition Guard (regenerate) →
          reply  +  (background) Memory Mining & Feedback Learning
```

- **Scene Analyzer** reads what's happening (topic, energy, intent, is-the-bot-being-roasted) — LLM with a deterministic fallback.
- **Memory Retriever** pulls **only** the few memories relevant to this turn (scored by handle/keyword/topic/salience), excludes recently-used ones (cooldowns), and returns **nothing** when the chat is roasting the bot for repetition.
- **Reply Planner + Style Engine** pick intent, tone, length and one of 10 voice variants; a dynamic banned-openings list kills repeated tics.
- **Generator** produces one candidate by default for speed (configurable); the **Ranker** + **Repetition Guard** drop assistant-tone, repeated, or verbatim-memory replies and **regenerate** if needed.
- **Memory** lives in `memory_items` (mined lore with confidence/salience/toxicity), not raw text. Use it via `/fact`, `/setfact`, `/facts`, `/lore`, `/forget`. Background jobs **mine lore while the bot is silent** (`/autofact` chats) and **learn from feedback** (reactions/criticism adjust memory salience and make autoengage more conservative after bad turns).
- **Debug:** admins use `/brain` (readable last-turn summary) and `/debuglast` (JSON) to see exactly why the bot answered the way it did.

The legacy `facts` collection is auto-migrated into `memory_items` on first boot.

> **Multilingual:** all internal brain instructions (scene/plan/generator/memory prompts) are written
> in **English** — the model follows them best — while the bot is explicitly told to **reply in the
> chat's language** (`/language`). STT and the TTS voice follow the chat language too.

## Configuration (all env vars)

Validated with **zod** at startup; the bot **fails fast** on a missing/invalid required var. Optional
capabilities never block startup. Copy `.env.example` → `.env` (gitignored; never commit secrets).

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Token from @BotFather. |
| `BOT_USERNAME` | `GoonerBot` | Default/hint; real username resolved from Telegram at boot. |
| `ALLOWED_HANDLES` | unrestricted | Comma `@handles` allowed to use the bot. Empty or `*` ⇒ everyone. |
| `ADMIN_HANDLES` | none | Comma `@handles` that are bot admins (control commands anywhere, `/ban`). |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/goonerbot` | Connection string. |
| `MONGO_DB` | `goonerbot` | Database name. |
| `NODE_ENV` | `development` | `production` ⇒ JSON logs. |
| `LOG_LEVEL` | `info` | pino level. |

### LLM

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_PROVIDER` | `ollama` | `solclawn\|openai\|deepseek\|ollama\|custom_openai_compatible`. |
| `LLM_BASE_URL` | per-provider | OpenAI-compatible base URL. |
| `LLM_API_KEY` | — | Bearer token. |
| `LLM_MODEL` | — | Chat model (required for text replies). |
| `LLM_VISION_MODEL` | — | Enables image input. Unset ⇒ disabled. |
| `LLM_VISION_BASE_URL` | — | Separate vision endpoint (e.g. an Ollama). Empty ⇒ reuse `LLM_BASE_URL`. |
| `LLM_VISION_API_KEY` | — | Bearer for the vision endpoint (Ollama needs none). |
| `LLM_IMAGE_MODEL` | — | Enables image output. Unset ⇒ disabled. |
| `LLM_TRANSCRIPTION_MODEL` | — | Enables voice input. Unset ⇒ disabled. |
| `LLM_TTS_MODEL` | — | Enables TTS output. Unset ⇒ disabled. |
| `LLM_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout. |
| `LLM_FALLBACK_BASE_URL` / `LLM_FALLBACK_MODEL` / `LLM_FALLBACK_API_KEY` | — | Fallback chat endpoint used when the primary throws (e.g. local Ollama gpt-oss). Active when base URL + model are set. |
| `WEB_SEARCH_ENABLED` | `false` | Ground recency/factual questions via SearXNG. |
| `SEARXNG_URL` | — | SearXNG base URL (e.g. `http://127.0.0.1:8888`). |
| `WEB_SEARCH_MAX_RESULTS` | `5` | Max results injected per grounded reply. |
| `WEB_SEARCH_TIMEOUT_MS` | `8000` | SearXNG request timeout. |
| `IMAGE_LOOKUP_ENABLED` | `false` | Reverse-image grounding (needs web search + vision). |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | — / `https://api.deepseek.com` / — | DeepSeek block. |

### NSFW routing

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_NSFW_MODEL` | — | Uncensored model. Empty ⇒ NSFW routing disabled. |
| `LLM_NSFW_DEFAULT_MODE` | `smart` | Initial per-chat mode for new chats: `off\|base\|smart` (inert without an NSFW model). |
| `LLM_NSFW_LEXICON` | — | Extra comma-separated trigger terms (smart mode). |
| `LLM_REFUSAL_FALLBACK` | `true` | Buffered backstop: retry on the NSFW model if the default refuses. |
| `LLM_REFUSAL_BUFFER_CHARS` | `160` | Leading chars buffered before deciding a refusal. |

### Brain pipeline

| Variable | Default | Description |
| --- | --- | --- |
| `SCENE_MODEL` / `PLANNER_MODEL` / `REPLY_MODEL` / `RANKER_MODEL` / `MEMORY_MODEL` | `LLM_MODEL` | Per-stage model overrides; empty ⇒ fall back to `LLM_MODEL`. |
| `REPLY_TEMPERATURE` | `0.95` | Generation temperature (higher = less robotic). |
| `REPLY_TOP_P` / `REPLY_FREQUENCY_PENALTY` / `REPLY_PRESENCE_PENALTY` | `0.95` / `0.6` / `0.4` | Sampling/anti-repetition penalties. |
| `REPLY_CANDIDATE_COUNT` | `1` | Candidates generated per reply (ranked). Keep at `1` for fast chat; raise only if you want extra sampling. |
| `REPLY_MAX_REGENERATIONS` | `2` | Regenerations when the repetition guard blocks. |
| `MAX_REPLY_LINES` / `MAX_REPLY_CHARS` | `3` / `420` | Reply length caps. |
| `REPETITION_SIMILARITY_THRESHOLD` | `0.72` | Block a reply too similar to recent ones. |
| `MEMORY_*` | see `.env.example` | Mining confidence/salience, per-reply caps, cooldowns, context window. |
| `MEMORY_MINING_ENABLED` / `MEMORY_MINING_INTERVAL_SECONDS` | `true` / `300` | Background lore mining for `/autofact` chats. |
| `FEEDBACK_LEARNING_ENABLED` / `FEEDBACK_LOOKAHEAD_MESSAGES` | `true` / `10` | Learn from reactions/criticism. |
| `BRAIN_DEBUG_ENABLED` / `BRAIN_DEBUG_TTL_DAYS` | `true` / `7` | `/brain` + `/debuglast` storage. |

### Behaviour, limits & memory

| Variable | Default | Description |
| --- | --- | --- |
| `DEFAULT_LANGUAGE` | `italian` | `italian\|english\|russian\|spanish`; per-chat via `/language`. |
| `AUTOENGAGE_DEFAULT_ENABLED` | `true` | Initial `/autoengage` for new chats. |
| `CONVERSATION_TRACKER_DEFAULT_ENABLED` | `true` | Initial `/conversationtracker`. |
| `AUTOFACT_DEFAULT_ENABLED` | `false` | Initial `/autofact`. |
| `MAX_REPLIES_PER_CHAT_PER_HOUR` | `15` | Hard cap on bot replies/chat/hour (mentions included). |
| `AUTOENGAGE_MIN_COOLDOWN_SECONDS` | `45` | Min seconds between passive replies per chat. |
| `AUTOENGAGE_USER_COOLDOWN_SECONDS` | `20` | Min seconds between passive replies per user. |
| `AUTOENGAGE_MIN_CONFIDENCE` | `0.6` | Min scorer confidence (0–1) to passively engage. |
| `MESSAGE_HISTORY_RETENTION_DAYS` | `30` | TTL for raw stored messages (0 disables). |
| `MAX_CONTEXT_MESSAGES` | `25` | Recent messages fed to the prompt. |
| `MAX_STORED_MESSAGES_PER_CHAT` | `500` | Hard cap per chat (oldest trimmed). |
| `DEFAULT_USAGE_LIMIT` | `1000000000` | Usage points/user/month. |
| `DEFAULT_BAN_SECONDS` | `0` | Default `/ban` duration; `0` ⇒ permanent. |
| `COMMAND_RATE_LIMIT_SECONDS` | `1` | Min seconds between accepted commands per user (anti-spam). |
| `ENABLE_MESSAGE_STREAMING` | `true` | Stream replies via progressive edits. |
| `STREAM_EDIT_INTERVAL_MS` | `1200` | Min ms between streaming edits. |

---

## Memory & data model

MongoDB collections (all indexed): `chats`, `users`, `chat_members`, `modes`, `facts`, `messages`,
`usage` (+ `usage_events`), `bans`, `terms_acceptance`, `media`, `jobs`.

- **Facts** are one-doc-per-fact with a `manual | auto | introduction` source and a dedupe unique index.
- **Messages** carry a TTL index on `createdAt` (retention) plus a per-chat cap.
- **Bans** honour `bannedUntil` (timed bans auto-expire).
- **Usage** resets per UTC month and tracks tokens / image / vision / transcription calls per
  provider+model.
- Indexes cover `chatId`, `handle`, `createdAt`, `chatId+userHandle`, and analytics keys.

**Fact safety:** a built-in filter rejects obviously sensitive facts (passwords, addresses, etc.); the
automatic extractor is told to keep only durable, useful, non-sensitive group/user facts.

---

## Security

GoonerBot is built for an authorized, self-hosted deployment. Summary of the security posture
(audited): see the table below.

| Area | Posture |
| --- | --- |
| **Secrets** | Only in `.env` (gitignored). No hardcoded tokens/keys in source or git history. The LLM API key is sent as a Bearer header and never logged. |
| **Logging** | Structured (pino). The bot token, LLM key and Mongo URI are never logged. |
| **Auth / permissions** | Centralized `PermissionService` (AND-composition). Control commands require group-admin **or** bot-admin; `/ban` requires bot-admin. Callback queries are permission-checked too. |
| **Banned users** | Gated by `not_banned` on commands and in the message handler; bans honour expiry. |
| **NoSQL injection** | All Mongo queries use fixed field names with user input only as scalar **values** (never as keys/operators); no `$where`/`eval`; `ObjectId.isValid` guards ids. |
| **Rate limiting / DoS** | Per-user command cooldown (`COMMAND_RATE_LIMIT_SECONDS`); autoengage per-chat/per-user cooldowns + hourly cap; usage limits; media download size cap (20 MB). |
| **Media / SSRF** | Inbound files fetched only from Telegram's own file API using bot-provided `file_path` (not user URLs). Outbound base URLs are operator-configured, not user input. |
| **MongoDB** | Run it bound to `127.0.0.1` with `--auth` and a least-privilege app user (the included `scripts/mongo-local.sh` + README do exactly this). |
| **Content safety** | NSFW is opt-in per chat with non-negotiable hard limits in the system prompt (no minors, no non-consent, no real-person, nothing illegal, no doxxing). |
| **Dependencies** | `pnpm audit` clean at release; minimal dependency surface; native `fetch` (no LLM SDK lock-in). |

**Known residual risks (inherent to LLM bots):** prompt-injection / jailbreak attempts in user
messages are mitigated by system-prompt guardrails but not eliminated; treat model output as
untrusted. Keep `ADMIN_HANDLES` tight and your Mongo not exposed to the network.

To report a vulnerability, open a private security advisory on the repository.

---

## Development & testing

```bash
pnpm typecheck      # strict TS
pnpm lint           # eslint
pnpm format:check   # prettier
pnpm test           # vitest (no live Mongo needed — unit tests use fakes)
```

Two optional integration harnesses (need a real Mongo + a configured LLM) live in `scripts/`:

```bash
pnpm tsx scripts/smoke-integration.ts   # storage + LLM + reply + routing, end-to-end
pnpm tsx scripts/smoke-telegram.ts       # drives synthetic Telegram updates through the real bot
```

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `/start` → "you can't do that here" | You're not a group admin and not in `ADMIN_HANDLES`. Add your `@handle` to `ADMIN_HANDLES`. |
| Bot ignores normal messages | Privacy Mode is ON. Disable it in @BotFather (then re-add the bot) or make the bot a group admin. |
| Replies in the wrong language | Existing chats keep their stored language; run `/language`. New chats use `DEFAULT_LANGUAGE`. |
| "capability not available" message | The relevant `LLM_*_MODEL` isn't set (vision/image/transcription). Set it or ignore. |
| Bot won't start | Check the fail-fast error — usually a missing `TELEGRAM_BOT_TOKEN` or unreachable `MONGO_URI`. |
| Toggles seem off in an existing chat | Defaults apply to **new** chats; toggle once with the relevant command. |

---

## License

MIT (inherited from the original project). See [LICENSE](./LICENSE).
