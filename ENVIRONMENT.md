# ENVIRONMENT.md — GoonerBot

All configuration is via environment variables, validated with **zod** at startup
(`src/config/env.ts`). The bot **fails fast** if a required variable is missing or invalid.
Optional capabilities (media models, provider keys) never block startup — they just stay disabled.

Copy [.env.example](./.env.example) to `.env` and fill it in. `.env` is gitignored — never commit secrets.

## Runtime

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development` enables pretty logs; `production` uses JSON logs. |
| `LOG_LEVEL` | `info` | pino level: `fatal\|error\|warn\|info\|debug\|trace\|silent`. |

## Telegram

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Token from @BotFather. |
| `BOT_USERNAME` | `GoonerBot` | Default/hint only; the real username is resolved from Telegram at boot (used for mention detection). |
| `ALLOWED_HANDLES` | unrestricted | Comma-separated `@handles` allowed to use the bot. Empty or `*` => everyone. |
| `ADMIN_HANDLES` | none | Comma-separated `@handles` that are bot admins (can `/ban`, `/unban`). |

> Handles are normalized to `@handle`. See README → Privacy Mode for what the bot can see in groups.

## MongoDB

| Variable | Default | Description |
|---|---|---|
| `MONGO_URI` | `mongodb://127.0.0.1:27017/goonerbot` | Connection string. |
| `MONGO_DB` | `goonerbot` | Database name. |

## LLM provider

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `solclawn\|openai\|deepseek\|ollama\|custom_openai_compatible`. |
| `LLM_BASE_URL` | per-provider | OpenAI-compatible base URL (e.g. `https://llm.solclawn.com/v1`). Trailing slash trimmed. |
| `LLM_API_KEY` | — | Bearer token for the provider (e.g. LeakRouter client token for solclawn). |
| `LLM_MODEL` | — | Chat model name. **Required for text replies** (warns if unset). |
| `LLM_VISION_MODEL` | — | Enables image input (vision). Unset => vision disabled. |
| `LLM_IMAGE_MODEL` | — | Enables image output (generation). Unset => disabled. |
| `LLM_TRANSCRIPTION_MODEL` | — | Enables voice input (transcription). Unset => disabled. |
| `LLM_TTS_MODEL` | — | Enables TTS output. Unset => disabled. |
| `LLM_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout (ms). |

### NSFW model routing

| Variable | Default | Description |
|---|---|---|
| `LLM_NSFW_MODEL` | — | Uncensored model for adult/NSFW text. Empty => NSFW routing disabled. |
| `LLM_NSFW_DEFAULT_MODE` | `base` | Initial per-chat NSFW mode for new chats: `off` \| `base` \| `smart`. `base` is inert unless `LLM_NSFW_MODEL` is set. |
| `LLM_NSFW_LEXICON` | — | Extra comma-separated trigger terms appended to the built-in lexicon (smart mode). |
| `LLM_REFUSAL_FALLBACK` | `true` | Buffered backstop: if the default model refuses, silently retry with the NSFW model. |
| `LLM_REFUSAL_BUFFER_CHARS` | `160` | Leading chars buffered before deciding a reply is a refusal. |

Routing is **hybrid and per-chat gated** (admin `/nsfw off\|base\|smart`): a mode flagged `[nsfw]`
always uses the NSFW model; `base` routes the whole chat to it; `smart` decides per message via the
lexicon and arms the refusal backstop for the rest. `off` (or no `LLM_NSFW_MODEL`) never routes to,
nor upgrades to, the NSFW model. The decision is made **before** generation, so there's no
extra-LLM-call latency in the common path.

### DeepSeek (when `LLM_PROVIDER=deepseek`)

| Variable | Default | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key (falls back to `LLM_API_KEY`). |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | `/v1` is appended automatically. |
| `DEEPSEEK_MODEL` | — | e.g. `deepseek-chat` (falls back to `LLM_MODEL`). |

## Behaviour defaults

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_LANGUAGE` | `italian` | Default chat language (`italian\|english\|russian\|spanish`); changeable per chat with `/language`. |
| `AUTOENGAGE_DEFAULT_ENABLED` | `true` | Initial `/autoengage` state for a new chat. |
| `CONVERSATION_TRACKER_DEFAULT_ENABLED` | `true` | Initial `/conversationtracker` state. |
| `AUTOFACT_DEFAULT_ENABLED` | `false` | Initial `/autofact` state. |

## Autoengage pacing / anti-spam

| Variable | Default | Description |
|---|---|---|
| `MAX_REPLIES_PER_CHAT_PER_HOUR` | `15` | Hard cap on bot replies per chat per hour (applies to mentions too). |
| `AUTOENGAGE_MIN_COOLDOWN_SECONDS` | `45` | Min seconds between passive auto-engage replies per chat. |
| `AUTOENGAGE_USER_COOLDOWN_SECONDS` | `20` | Min seconds between passive replies triggered by the same user. |
| `AUTOENGAGE_MIN_CONFIDENCE` | `0.6` | Minimum scorer confidence (0–1) to passively engage. |

## Conversation memory / retention

| Variable | Default | Description |
|---|---|---|
| `MESSAGE_HISTORY_RETENTION_DAYS` | `30` | TTL for raw stored messages (0 disables TTL). |
| `MAX_CONTEXT_MESSAGES` | `25` | How many recent messages feed the prompt. |
| `MAX_STORED_MESSAGES_PER_CHAT` | `500` | Hard cap on stored messages per chat (oldest trimmed). |

## Usage & moderation

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_USAGE_LIMIT` | `1000000000` | Usage points per user per month (large => effectively unlimited). |
| `DEFAULT_BAN_SECONDS` | `0` | Default `/ban` duration when none given. `0` => permanent. |
| `COMMAND_RATE_LIMIT_SECONDS` | `1` | Min seconds between accepted command invocations per user. |

## Streaming UX

| Variable | Default | Description |
|---|---|---|
| `ENABLE_MESSAGE_STREAMING` | `true` | Stream replies by editing one message progressively. |
| `STREAM_EDIT_INTERVAL_MS` | `1200` | Min ms between streaming edits (avoids Telegram rate limits). |
