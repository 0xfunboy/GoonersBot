# GoonerBot 🤖

A **group-native entertainment, roleplay, meme, banter and memory** AI bot for the **Gooners**
Telegram community.

GoonerBot is **not** a personal assistant and **not** a corporate productivity agent. It's a chat
character that knows the group culture: it listens to the conversation, remembers group and user
lore, jumps in when it's funny or useful, runs roleplay/chat modes, and keeps the group alive
without being a spammy menace.

> GoonerBot is a full TypeScript reimplementation and rebrand of the open-source
> [Flagro/TelegramRPBot](https://github.com/Flagro/TelegramRPBot) (Python). See
> [MIGRATION_AUDIT.md](./MIGRATION_AUDIT.md) and [FEATURE_PARITY.md](./FEATURE_PARITY.md) for the
> complete mapping — every original feature was ported.

---

## Features

- **Group chat character** — reads the room, replies in context, stays short and punchy.
- **Chat-bounded modes** — per-chat personalities you can add / select / delete at runtime.
- **Built-in Gooners modes** — `default`, `roast`, `hype`, `lorekeeper`, `chaos`, `market_degen`, `meme_recorder`.
- **Memory** — manual + automatic facts about users and the group, self-introductions, group lore.
- **Auto-engage** — an `AutoEngageScorer` decides when to intervene (cooldowns, hourly caps, confidence, risk — never chain-spams).
- **Conversation tracking** — optional passive listening with configurable retention.
- **Media** — image input (vision), voice input (transcription), text output, image output, optional TTS — all capability-gated and degrade gracefully.
- **Usage tracking & limits** — per user / chat / provider, token + call + cost accounting.
- **Permissions, bans, terms of use, multi-language** (English / Russian / Spanish).
- **Pluggable LLM backends** — solclawn, OpenAI, DeepSeek, Ollama, or any OpenAI-compatible host.

## Commands

| Command | Who | What |
|---|---|---|
| `/start` | admin | wake GoonerBot in this chat |
| `/stop` | admin | put GoonerBot to sleep |
| `/reset` | admin | wipe conversation memory |
| `/mode` | admin | pick a mode |
| `/addmode <description>` | admin/allowed | add a custom mode |
| `/deletemode` | admin | delete a mode |
| `/introduce <text>` | anyone* | tell GoonerBot who you are |
| `/fact @handle <fact>` | anyone* | save a fact about a Gooner |
| `/facts [@handle]` | anyone | show stored facts |
| `/clearfacts [@handle]` | self / admin | clear facts (self anytime; others = admin) |
| `/usage` | anyone | your usage & limits |
| `/language` | admin | set chat language |
| `/terms` | anyone | terms of use + acceptance |
| `/conversationtracker` | admin | toggle passive tracking |
| `/autofact` | admin | toggle automatic fact extraction |
| `/autoengage` | admin | toggle auto-engage |
| `/ban @handle [seconds]` | bot admin | ban a Gooner (reply-aware; duration optional) |
| `/unban @handle` | bot admin | unban a Gooner |
| `/help` | anyone | help |

\* requires accepting `/terms` first.

---

## Requirements

- **Node.js 23.3** (preferred — see `.nvmrc`) or the latest LTS (Node 22/24+). No Python, no Docker.
- **pnpm** (`npm i -g pnpm`).
- A running **MongoDB** instance (local is fine).

## Quick start (local, no Docker)

```bash
# 1. Node version
nvm use            # picks up .nvmrc (23.3.0); or `nvm install 23.3.0`

# 2. Install deps
pnpm install

# 3. MongoDB — run a local instance (any one of these)
#    a) system service:        sudo systemctl start mongod
#    b) standalone, no auth:    mongod --dbpath ./.mongo-data
#    (set MONGO_URI accordingly; default is mongodb://127.0.0.1:27017/goonerbot)

# 4. Configure
cp .env.example .env
# edit .env: set TELEGRAM_BOT_TOKEN and your LLM provider settings

# 5. Run
pnpm dev           # watch mode (tsx)
# or for production:
pnpm build && pnpm start
```

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | run with hot reload (tsx) |
| `pnpm build` | compile TypeScript to `dist/` |
| `pnpm start` | run the compiled bot (`node dist/main.js`) |
| `pnpm typecheck` | strict type check, no emit |
| `pnpm lint` / `pnpm lint:fix` | eslint |
| `pnpm format` / `pnpm format:check` | prettier |
| `pnpm test` / `pnpm test:watch` | vitest |

---

## Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. Add the bot to your group.

### Privacy Mode (important for groups)

By default, Telegram bots run with **Privacy Mode ON**, which means the bot only receives:
messages that start with a `/command`, replies to its own messages, and messages that
`@mention` it. It does **not** see ordinary group chatter.

GoonerBot's passive features — **conversation tracking** and **auto-engage** — need to see all
group messages. To enable them you must do one of:

- **Disable Privacy Mode** in @BotFather: `/setprivacy` → select your bot → **Disable**.
  *(Then remove and re-add the bot to the group for it to take effect.)*, **or**
- Make the bot a **group admin** (admins always receive all messages).

If Privacy Mode stays ON and the bot is not an admin, GoonerBot still works fully for commands,
@mentions and replies — it just can't passively track the conversation or auto-engage.
GoonerBot never hardcodes a group ID; it works in any chat it's added to.

---

## LLM provider configuration

Pick a provider with `LLM_PROVIDER`. The base URL and model are configurable — nothing is
hardcoded in the business logic. Media capabilities (vision/image/transcription/TTS) activate
only when you set the corresponding model env var; if unset, that capability is disabled and the
bot degrades gracefully (a clean message, never a crash).

### solclawn (default OpenAI-compatible LeakRouter surface)

```env
LLM_PROVIDER=solclawn
LLM_BASE_URL=https://llm.solclawn.com/v1
LLM_API_KEY=<your LeakRouter client bearer token>
LLM_MODEL=<an Ollama model name exposed by the router, e.g. gpt-oss:20b>
# optional:
LLM_VISION_MODEL=
LLM_IMAGE_MODEL=
LLM_TRANSCRIPTION_MODEL=
```

`solclawn` uses the generic OpenAI-compatible adapter against `LLM_BASE_URL` with
`Authorization: Bearer ${LLM_API_KEY}` — matching the LeakRouter OpenAI surface
(`/v1/chat/completions`, model = Ollama model name).

### DeepSeek

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=<your deepseek key>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

### Ollama (local), OpenAI, or any custom OpenAI-compatible host

See [.env.example](./.env.example) options C/D/E.

---

## How it works (high level)

```
Telegram (grammY) → adapter/handlers → domain services → repositories (MongoDB)
                                     ↘ LLM provider (OpenAI-compatible / DeepSeek)
                                     ↘ prompt builders
                                     ↘ jobs (retention cleanup)
```

Handlers parse input, run permission + terms gates, call services, and return abstract responses
that are localized and rendered. Business logic lives in services, never in handlers. See
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Documentation

- [MIGRATION_AUDIT.md](./MIGRATION_AUDIT.md) — full inventory of the original + migration checklist.
- [FEATURE_PARITY.md](./FEATURE_PARITY.md) — original feature → TypeScript implementation table.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — layers, data flow, key decisions.
- [ENVIRONMENT.md](./ENVIRONMENT.md) — every env var explained.

## License

MIT (inherited from the original project). See [LICENSE](./LICENSE).
