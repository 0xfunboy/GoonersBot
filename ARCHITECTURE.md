# ARCHITECTURE.md — GoonerBot

GoonerBot keeps the original project's deliberately **platform-agnostic core** and layers it
cleanly so business logic never leaks into the Telegram adapter.

## Layers

```
src/
  main.ts                 composition root: config → storage → llm → services → bot → scheduler
  config/                 zod env validation, app config, default modes, i18n (Localizer)
  domain/                 platform-agnostic types (Person, ChatContext, IncomingMessage, …) + entity shapes
  storage/                MongoDB connection + repositories (one per collection) + index setup
  providers/
    llm/                  LLMProvider abstraction + OpenAI-compatible/DeepSeek adapters + factory
    media/                MediaProcessor: routes vision/transcription/image-gen through the LLM provider
  prompts/                composable prompt builders (identity, mode, context, facts, autoengage, extraction, safety, style)
  services/               domain logic: permissions, terms, bans, modes, facts, usage, conversation, autoengage, reply
  telegram/               grammY adapter: context builders, keyboards, render, dispatch, handlers
  jobs/                   in-process scheduler + retention cleanup
  utils/                  logger (pino), handle/arg parsing, cooldown/rate-limit primitives
tests/                    vitest unit tests (no live Mongo required)
```

### Dependency direction

```
telegram ─▶ services ─▶ storage (repositories) ─▶ MongoDB
   │           │
   │           ├─▶ providers/llm   (chat, vision, transcription, image, extractFacts, scoreAutoEngage)
   │           ├─▶ providers/media (capability-gated routing over the LLM provider)
   │           └─▶ prompts         (pure string builders)
   └─▶ domain (types only)         config + utils are leaf modules used everywhere
```

Handlers **parse input → call services → return an abstract `CommandResponse`**. The response is
localized (translation key → chat language) and rendered to Telegram. This mirrors the original
`BaseHandler`/`CommandResponse`/`LocalizedCommandResponse` split, so the core could drive a
non-Telegram front-end with a new adapter.

## Request flow (commands & callbacks)

1. grammY receives an update → `telegram/dispatch.ts`.
2. Build `Person` + `ChatContext` + `IncomingMessage` from the update (`telegram/context.ts`).
3. `services.initializeContext()` — idempotent bootstrap (create chat, seed modes, upsert user, ensure usage).
4. **Permission gate** — `PermissionService.checkAll([...])` (AND-composition). Fail → `not_authenticated`.
5. **Terms gate** — if the handler needs terms: declined → skip; not accepted → show terms keyboard.
6. Run the handler → `CommandResponse | null`.
7. Localize → render (audio > image > text priority, HTML parse mode, reply-to, inline keyboards).

## Message flow (free text / media)

`telegram/handlers/message.ts` ports `messages/message_handler.py`:

1. Permission gate (`allowed_user`, `not_banned`).
2. Chat must be **started**; if conversation-tracking is OFF and the bot isn't addressed → ignore.
3. Terms gate (prompt only when addressed).
4. **AutoEngageScorer.decide()**:
   - directly addressed (mention/reply) → reply almost always (still bounded by the hourly cap);
   - passive → LLM scores `{shouldReply, confidence, reason, suggestedTone, risk}`, gated by per-chat
     and per-user cooldowns, the hourly reply cap, a confidence threshold, and risk.
5. Not engaging but tracking → store the message as context, return.
6. Engaging → usage pre-check → **stream** the reply (throttled message edits) → send optional
   generated image → persist user + bot messages → record usage → inline auto-fact extraction (if `/autofact`).

## LLM provider abstraction

`LLMProvider` (providers/llm/types.ts) exposes `capabilities` and methods: `chatCompletion`,
`streamChatCompletion`, optional `visionCompletion`/`transcribeAudio`/`generateImage`,
plus `extractFacts` and `scoreAutoEngage`. The OpenAI-compatible adapter powers
`solclawn`/`openai`/`ollama`/`custom_openai_compatible`; `DeepSeekProvider` subclasses it.
Capability methods are present **only** when the corresponding model is configured, so callers
feature-detect (`typeof provider.generateImage === 'function'`) and degrade gracefully — a missing
media capability logs and returns a clean message instead of crashing.

The provider host (e.g. `llm.solclawn.com`) is supplied via `LLMConfig.baseUrl` from env and is
never hardcoded in business logic.

### NSFW model routing (`ModelRouter` + buffered backstop)

`ModelRouter` (services/modelRouter.ts) picks the model for each turn **before** generation, so the
common path adds no extra LLM call. Hybrid priority: mode flagged `[nsfw]` → NSFW model; chat
`base` → NSFW model for everything; chat `smart` → an instant lexicon decides, else the default
model with the refusal backstop armed; `off` (or no `LLM_NSFW_MODEL`) → default, never upgraded.
The decision (`model`, `nsfw`, `allowRefusalFallback`) flows into `ReplyService.streamReply`, which
swaps in the NSFW-aware system prompt for NSFW turns. The **buffered backstop**: when armed,
`streamReply` withholds the first ~`LLM_REFUSAL_BUFFER_CHARS` of the default model's stream; if
`isRefusal()` matches, it discards and silently restarts on the NSFW model — the user never sees a
refusal, and only the buffered prefix costs latency. NSFW is gated per-chat by an admin (`/nsfw`).

## Storage

One repository per collection (`chats`, `users`, `chat_members`, `modes`, `facts`, `messages`,
`usage` + `usage_events`, `bans`, `terms_acceptance`, `media`, `jobs`). `Storage.ensureIndexes()`
is idempotent and run on boot. Indexes cover `chatId`, `handle`, `createdAt`, `chatId+userHandle`,
provider/model analytics, a unique fact dedupe, and a TTL on `messages.createdAt` for raw history
retention.

Notable corrections vs the original (see MIGRATION_AUDIT §19): bans honour `bannedUntil` expiry;
usage resets by UTC month explicitly; facts are one-doc-per-fact with a `manual|auto|introduction`
source; all collections are indexed.

## Key decisions

- **grammY** over Telegraf — modern, typed, good long-polling and filter ergonomics.
- **Native `fetch`** for LLM calls (Node 22+/23) — no SDK lock-in, trivial OpenAI-compatibility.
- **No Docker / no Python** — Node + a local MongoDB, per project requirement.
- **Explicit handler registry** instead of the original's filesystem auto-discovery — tree-shakeable, testable.
- **In-memory cooldowns** for short-lived autoengage pacing (reset on restart is correct); durable
  caps derive from persisted state.
- **Inline auto-fact extraction** on engaged replies (ported behaviour) + an hourly retention job;
  no blind token-spending batch sweep over all chats.
