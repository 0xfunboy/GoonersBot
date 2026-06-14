# MIGRATION_AUDIT.md — GoonerBot

> Full inventory of the original **Flagro/TelegramRPBot** (Python) and the migration checklist
> to **GoonerBot** (TypeScript / Node 22+ / grammY / MongoDB).
>
> Source studied: `https://github.com/Flagro/TelegramRPBot` (cloned to `_tg_rp_bot_source/`, commit at clone time).
> Use the checkboxes to track parity during the rewrite. Nothing in the "Original features"
> list may be silently dropped — anything not portable is logged in **§9 Not-Ported / Deviations**.

Legend: `[ ]` todo · `[~]` partial / adapted · `[x]` done · 🔁 rebrand required · ⚠️ behaviour change documented in §9

---

## 0. High-level summary of the original

| Aspect | Original | GoonerBot target |
|---|---|---|
| Language | Python 3.10–3.11 | TypeScript (strict), Node 22+, ESM |
| Telegram lib | `python-telegram-bot==20.1` (+ rate-limiter) | grammY |
| LLM stack | `omnimodkit==0.0.9` (OpenAI-only, hardcoded) | Custom `LLMProvider` abstraction (solclawn/openai/deepseek/ollama/custom) |
| DB | MongoDB via `motor` (async) | MongoDB via official `mongodb` driver, with indexes |
| Config | YAML files + `python-decouple` env | `zod`-validated env + TS config modules + JSON/TS defaults |
| Packaging | Poetry, Dockerfile, docker-compose | pnpm, Dockerfile, docker-compose |
| Entry | `main.py` | `src/main.ts` |
| Architecture | Abstract `BaseBot`/`BaseHandler` + platform adapter (`bot/telegram`) | Same clean-layer split: telegram adapter → services → repositories → providers |

Design intent of the original (preserved): the bot core is **platform-agnostic**. Handlers
return abstract `CommandResponse` objects, localized then rendered by a thin Telegram adapter.
Three handler families: **commands**, **callbacks** (inline keyboard), **messages** (free text/media).

---

## 1. Repository structure inventory (original)

```
main.py                         entrypoint; loads YAML config, builds DB URI, wires RPBot + TelegramBot
pyproject.toml / poetry.lock    deps
Dockerfile                      python:3.11 + poetry install
docker-compose.yaml             bot + mongo:8.0 (auth, init script)
docker-compose.dev.yaml         mongo only (local dev)
init/01-init-app-user.js        Mongo init: create app user with readWrite on DB
.env.example                    env template
.github/workflows/              lint.yaml, publish.yaml (ghcr), release.yaml
config/
  ai_config.yaml                omnimodkit model defs + pricing (text/image/audio/vision/moderation)
  bot_config.yaml               default_language, last_n_messages_to_remember/store, default_usage_limit
  default_chat_modes.yaml       built-in modes: assistant, motivator, light
  localizer_translations.yaml   all UI strings in english/russian/spanish
  tg_config.yaml                streaming, pagination, rate-limiter, dialog timeout
bot/
  models/                       platform-agnostic core models
    base_bot.py                 BaseBot ABC (commands/callbacks/messages props)
    base_handlers.py            BaseHandler/BaseCommandHandler/BaseCallbackHandler/BaseMessageHandler, CommandPriority
    base_auth.py                BasePermission ABC
    handlers_input.py           Person, Context, Message, BotInput, TranscribedMessage (pydantic)
    handlers_response.py        CommandResponse, LocalizedCommandResponse, KeyboardResponse
    config/                     YAML config pydantic models + loaders
  rp_bot/                       concrete RP bot implementation
    bot.py                      get_rp_bot() factory + RPBot(BaseBot)
    rp_bot_handlers.py          RPBot*Handler mixins (inject db/toolkit/localizer/etc.)
    auth.py                     Auth + permission classes (GroupAdmin/AllowedUser/BotAdmin/NotBanned/HasAcceptedTerms)
    db.py                       DB facade aggregating all db_models
    localizer.py                Localizer (per-chat language string lookup)
    prompt_manager.py           PromptManager (system + context prompt composition)
    commands/                   18 command handlers (auto-discovered)
    callbacks/                  6 callback handlers (auto-discovered)
    messages/                   message_handler.py (passive/autoengage/AI reply)
    db_models/                  7 Mongo models (users, user_usage, chats, user_facts, user_introductions, chat_modes, dialogs)
    ai_agent/agent_tools/       AIAgent (output-type router: text/image/audio + autofact)
  telegram/                     Telegram adapter (bot.py, utils.py, keyboards.py)
```

---

## 2. Commands inventory & parity checklist

All command handlers live in `bot/rp_bot/commands/*_handler.py`, auto-discovered by `commands/__init__.py`
(any file ending `handler.py` exposing `CommandHandler`). Telegram registers them sorted by
`(list_priority_order, command)` and sets the BotFather command list via `post_init`.

| # | Command | Original handler | Permissions (original) | Behaviour | GoonerBot status | Rebrand notes |
|---|---|---|---|---|---|---|
| 1 | `/start` | start_handler | GroupAdmin, AllowedUser, NotBanned · prio FIRST | `chats.start_chat` → `is_started=true` | `[ ]` | copy 🔁 |
| 2 | `/stop` | stop_handler | GroupAdmin, AllowedUser, NotBanned · prio FIRST | `chats.stop_chat` → `is_started=false` | `[ ]` | copy 🔁 |
| 3 | `/reset` | reset_handler | GroupAdmin, AllowedUser, NotBanned | `dialogs.reset` (delete all chat msgs) | `[ ]` | copy 🔁 |
| 4 | `/mode [mode]` | mode_handler | = set_chat_mode callback perms (GroupAdmin, AllowedUser, NotBanned) | shows inline keyboard of modes → callback sets active | `[ ]` | — |
| 5 | `/addmode [mode] [desc]` | addmode_handler | AllowedUser, GroupAdmin, NotBanned | mode_name = first sentence of desc; `chat_modes.add_chat_mode`; ValueError→inappropriate | `[ ]` | — |
| 6 | `/deletemode [mode]` | deletemode_handler | = delete_chat_mode callback perms | shows keyboard → callback deletes by id | `[ ]` | — |
| 7 | `/introduce [text]` | introduce_handler | AllowedUser, NotBanned · **needs_terms_accepted** | `user_introductions.add_introduction` | `[ ]` | — |
| 8 | `/fact [@handle] [fact]` | fact_handler | AllowedUser, NotBanned · **needs_terms_accepted** | validates ≥2 args, normalizes `@`; `user_facts.add_fact` | `[ ]` | — |
| 9 | `/clearfacts [@handle]` | clearfacts_handler | GroupAdmin, AllowedUser, NotBanned | `user_facts.clear_facts(args[0])` ⚠️ no self/admin distinction in code | `[ ]` | see §9 |
| 10 | `/usage` | usage_handler | AllowedUser, NotBanned · prio LAST | `user_usage.get_user_usage_report` → this_month_usage | `[ ]` | copy 🔁 |
| 11 | `/language` | language_handler | = set_chat_language callback perms | inline keyboard of supported languages → callback sets | `[ ]` | — |
| 12 | `/terms` | terms_handler | AllowedUser, NotBanned | shows terms text + accept/decline keyboard | `[ ]` | copy 🔁 |
| 13 | `/conversationtracker` | conversationtracker_handler | GroupAdmin, AllowedUser, NotBanned | `chats.switch_conversation_tracker` (toggle) | `[ ]` | — |
| 14 | `/autofact` | autofact_handler | GroupAdmin, AllowedUser, NotBanned | `chats.switch_auto_fact` (toggle) | `[ ]` | — |
| 15 | `/autoengage` | autoengage_handler | GroupAdmin, AllowedUser, NotBanned | `chats.switch_autoengage` (toggle) | `[ ]` | — |
| 16 | `/ban [@handle] [secs]` | ban_handler | BotAdmin, AllowedUser · prio ADMIN | reply-aware; `users.ban_user(handle, seconds)` ⚠️ requires seconds arg | `[ ]` | see §9 |
| 17 | `/unban [@handle]` | unban_handler | BotAdmin, AllowedUser · prio ADMIN | `users.unban_user` | `[ ]` | — |
| 18 | `/help` | help_handler | none (public) · prio LAST | static `help_text` | `[ ]` | copy 🔁 (full rebrand) |
| + | `/facts [@handle]` | facts_handler | AllowedUser, NotBanned | **EXTRA undocumented command** — shows stored facts for a handle (self if none) | `[ ]` | preserve; document in §9 |

**Note:** README lists 17 commands; the codebase has **19** (`/facts` is undocumented; `/ban` takes a
duration-in-seconds second arg not shown in README). Both preserved. See §9.

### Command parity checkboxes
- [ ] /start  · [ ] /stop · [ ] /reset · [ ] /mode · [ ] /addmode · [ ] /deletemode
- [ ] /introduce · [ ] /fact · [ ] /facts · [ ] /clearfacts · [ ] /usage · [ ] /language
- [ ] /terms · [ ] /conversationtracker · [ ] /autofact · [ ] /autoengage · [ ] /ban · [ ] /unban · [ ] /help

---

## 3. Callbacks (inline keyboard) inventory

`bot/rp_bot/callbacks/*` — auto-discovered, registered with pattern `^<callback_action>`.
Callback data format: `button_action|value` for selection, `callback|button_action|page_index` for pagination
(`telegram/keyboards.py::get_paginated_list_keyboard`, 5 per page default / 10 configured).

| Callback action | Handler | Perms | Behaviour | Status |
|---|---|---|---|---|
| `set_chat_mode` | set_chat_mode_handler | GroupAdmin, AllowedUser, NotBanned | `chat_modes.set_chat_mode(mode_id)` (clears others' active flag) | `[ ]` |
| `delete_chat_mode` | delete_chat_mode_handler | GroupAdmin, AllowedUser, NotBanned | `chat_modes.delete_chat_mode(mode_id)` | `[ ]` |
| `set_chat_language` | set_chat_language_handler | GroupAdmin, AllowedUser, NotBanned | `chats.set_language(lang)` | `[ ]` |
| `show_chat_modes` | show_chat_modes_handler (+ mixin) | AllowedUser, NotBanned | pagination/repaint of modes keyboard | `[ ]` |
| `show_chat_languages` | show_chat_languages_handler (+ mixin) | AllowedUser, NotBanned | pagination/repaint of languages keyboard | `[ ]` |
| `terms_response` | terms_response_handler | AllowedUser, NotBanned | `accept`→accept_terms; `decline`→clear_user_data + decline_terms | `[ ]` |

- [ ] Inline keyboard builder + pagination (`get_paginated_list_keyboard`)
- [ ] Callback data parsing (`split("|")[1:]`, `query.answer()`)

---

## 4. Message handler (passive tracking / autoengage / AI reply)

`bot/rp_bot/messages/message_handler.py` — the core conversational logic. Streamable.
Permissions: AllowedUser, NotBanned · **needs_terms_accepted=True**.
Telegram filter: `(TEXT | VOICE | PHOTO) & ~COMMAND`.

Decision flow (preserve exactly):
1. If chat **not started** → ignore. ✅ migrate
2. If **conversation_tracker OFF** *and* bot **not mentioned/replied** → ignore. ✅
3. If **autoengage ON** → ask LLM yes/no "is engagement needed?" via `compose_engage_needed_prompt`. ✅
4. `should_engage = engage_needed OR bot_mentioned`.
5. If not engaging but tracking → **save raw message to dialog** (no transcription, cheap) and return. ✅
6. If engaging → usage-limit check (`estimate_price` vs user limit) → over-limit response. ✅
7. Run `AIAgent.astream()` → stream text chunks; persist user msg, bot msg, usage points, generated facts. ✅

- [ ] Chat-started gate
- [ ] Conversation-tracker + mention/reply gate
- [ ] Autoengage yes/no scoring (→ becomes `AutoEngageScorer`, richer output per spec)
- [ ] Passive store-without-reply path
- [ ] Usage pre-check + over-limit response
- [ ] Streaming AI reply + persistence (user msg, bot msg, usage, autofacts)
- [ ] Image/voice transcription routing (only when bot mentioned — see §6)

**Bot-mention detection** (`telegram/utils.py::bot_mentioned`): true if private chat, OR reply to bot,
OR text contains `@<bot_username>`. ✅ migrate.

---

## 5. Data models / MongoDB collections inventory

Original collections (all keyed by `chat_id` except `users`/`user_usage` which are global by `handle`).
DB facade `db.py` runs `create_if_not_exists` + `update_if_needed` for every model on each request
(`initialize_context`). ⚠️ **No indexes are created in the original** — GoonerBot must add them.

| Collection | Original model | Key fields | Notes / parity |
|---|---|---|---|
| `users` | users.py | `handle` (unique), telegram_id, first_name, last_name, `banned`, `banned_until`, `accepted_terms`, `declined_terms` | global. ⚠️ ban check ignores `banned_until` expiry (see §9) |
| `user_usage` | user_usage.py | `handle`, usage(int points), limit, last_reset | monthly-ish reset (actually daily-date compare bug, §9) |
| `chats` | chats.py | `chat_id`, language, `is_started`, `conversation_tracker`, `auto_fact`, `autoengage` | per-chat toggles |
| `user_facts` | user_facts.py | `chat_id`+`user_handle`, `facts: string[]` | push/array. per-chat |
| `user_introductions` | user_introductions.py | `chat_id`+`user_handle`, `introduction` | per-chat |
| `chat_modes` | chat_modes.py | `chat_id`, mode_name, mode_description, `active_mode` bool, added_by_handle | default modes seeded per chat |
| `dialogs` | dialogs.py | `chat_id`, user_handle, is_bot, message_text, image_description, voice_description, timestamp | capped to `last_n_messages_to_store`; read last `last_n_messages_to_remember` |

### GoonerBot target collections (per spec — superset)
Spec asks for: `chats, users, chat_members, modes, facts, messages, usage, bans, terms_acceptance, media, jobs`.
Mapping plan:

| Spec collection | Source | Plan |
|---|---|---|
| `chats` | chats | direct, + autoengage/tracker/autofact defaults from env |
| `users` | users | split global identity here |
| `chat_members` | (new) | per-chat membership/role cache (new — supports per-chat user data cleanly) |
| `modes` | chat_modes | rename, add `is_builtin`, `created_by` |
| `facts` | user_facts + autofacts | one doc per fact (not array) for indexing + TTL-free durability; manual vs auto flag |
| `messages` | dialogs | + TTL index (retention days), per-chat cap |
| `usage` | user_usage | richer: tokens in/out, image/vision/transcription counts, cost, per provider/model |
| `bans` | users.banned* | split out (spec + original TODO wanted this) |
| `terms_acceptance` | users.accepted/declined_terms | split out (spec + original TODO wanted this) |
| `media` | (new) | record downloaded/generated media refs |
| `jobs` | (new) | scheduler/job bookkeeping (autofact batch, cleanup) |

### Index checklist (spec)
- [ ] `chatId`
- [ ] `userId` / `handle`
- [ ] `createdAt`
- [ ] `chatId + userId`
- [ ] `chatId + command` (usage analytics)
- [ ] TTL on raw `messages` (configurable `MESSAGE_HISTORY_RETENTION_DAYS`)
- [ ] unique `users.handle`, unique `modes (chatId, name)`

---

## 6. Media support inventory

| Capability | Original | Mechanism | GoonerBot |
|---|---|---|---|
| Image **input** (vision) | ✅ yes | `telegram/utils.get_message` downloads `photo[-1]` to BytesIO **only if bot mentioned**; AIAgent `vision_model.arun_default` → image_description | `[ ]` `visionCompletion()` |
| Voice **input** (transcription) | ✅ yes | downloads `voice` to BytesIO **only if bot mentioned**; `audio_recognition_model.arun_default` → voice_description | `[ ]` `transcribeAudio()` |
| Text **output** | ✅ yes | always | `[ ]` `chatCompletion()` |
| Image **output** (generation) | ✅ yes | AIAgent picks `TextWithImageStreamingResponse` output type → `image_generation_model.arun_default` → image_url; sent via `send_photo` | `[ ]` `generateImage()` |
| Audio **output** (TTS) | ✅ yes (bonus) | AIAgent `AudioResponse` output type → `audio_generation_model` → audio_bytes; `send_audio` | `[ ]` preserve as optional capability |
| Moderation | ✅ omnimodkit `ModerationError` → `message_moderation_failed` | OpenAI omni-moderation | `[~]` adapt to provider capability; basic safety |

**Output-type routing** (original `AIAgent`): the text model is first asked to pick one structured
output type among {Text, Audio, TextWithImage} (filtered by provider capabilities), then the chosen
modality is generated. GoonerBot keeps this *capability-gated* routing; **if a provider lacks a
capability, fail gracefully** (log + drop that output type / clean message), never crash.

- [ ] Telegram media download (grammY `getFile` + fetch to Buffer)
- [ ] Vision routing (gated by `LLM_VISION_MODEL` presence + provider capability)
- [ ] Transcription routing (gated by `LLM_TRANSCRIPTION_MODEL`)
- [ ] Image-gen routing (gated by `LLM_IMAGE_MODEL`)
- [ ] TTS output (optional)
- [ ] Capability-missing → clean localized message, no crash

---

## 7. LLM / AI inventory (omnimodkit → LLMProvider abstraction)

Original uses `omnimodkit==0.0.9` `ModelsToolkit` configured from `config/ai_config.yaml`,
**OpenAI key only** (`OPENAI_API_KEY`). Model types used: `text_model`, `vision_model`,
`audio_recognition_model`, `audio_generation_model`, `image_generation_model`, plus `moderation`.
Capabilities: text, vision, audio_recognition, audio_generation, image_generation, moderation.
Methods used: `arun` (structured/pydantic), `astream_default` (streaming text), `arun_default`,
`async_ask_yes_no_question`, `estimate_price`, `get_price`, `can_use_model`.

### GoonerBot `LLMProvider` interface (target)
```ts
interface LLMProvider {
  readonly name: string;
  capabilities: { chat; vision; transcription; imageGeneration; tts };
  chatCompletion(req): Promise<ChatResult>;        // + streaming variant
  visionCompletion?(req): Promise<ChatResult>;
  transcribeAudio?(req): Promise<string>;
  generateImage?(req): Promise<ImageResult>;
  extractFacts(req): Promise<Fact[]>;
  scoreAutoEngage(req): Promise<AutoEngageScore>;
}
```
Adapters & selection by `LLM_PROVIDER`:
- [ ] `solclawn` → OpenAI-compatible adapter @ `LLM_BASE_URL` (default `https://llm.solclawn.com/v1`), bearer `LLM_API_KEY`. **leakrouter convention**: OpenAI surface `/v1/chat/completions`, model = Ollama model name, `Authorization: Bearer <LEAKROUTER bootstrap key>`. Host never hardcoded in business logic — only as a default in config/env.
- [ ] `openai` → official OpenAI base URL
- [ ] `deepseek` → `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`), `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`
- [ ] `ollama` → local `http://localhost:11434/v1` OpenAI-compat
- [ ] `custom_openai_compatible` → arbitrary base URL + key + model
- [ ] Capability exposure + graceful degradation + clear logging when capability missing
- [ ] `extractFacts` (replaces `inject_autofact` / `ResponseFactsGeneration`)
- [ ] `scoreAutoEngage` (replaces yes/no `compose_engage_needed_prompt`, richer output)

### Pricing / usage estimation
Original `ai_config.yaml` carries per-model token/pixel/audio rates → "usage points".
GoonerBot: optional pricing config; if provider returns usage use it, else estimate tokens. (see §8)

---

## 8. Usage tracking inventory

Original: single integer "usage points" per user (`user_usage`), incremented by `total_price`
from `models_toolkit.get_price(...)`. Reset compares `current_date > last_reset` (date, buggy §9).
Pre-request gate: `estimate_price(text,image,audio) + current_usage < limit`.
Default limit `1_000_000_000` (effectively unlimited).

GoonerBot target (spec — richer):
- [ ] input tokens (if provider returns)
- [ ] output tokens (if provider returns)
- [ ] estimated tokens fallback
- [ ] image-gen call count
- [ ] transcription call count
- [ ] vision call count
- [ ] total cost estimate (if pricing config exists)
- [ ] dimensions: per user, per chat, per provider/model
- [ ] keep `/usage` parity (at minimum show this-period usage vs limit)

---

## 9. Permissions / auth inventory

`bot/rp_bot/auth.py` permission classes (all `async check(person, context) -> bool`):

| Class | Logic | Used by |
|---|---|---|
| `GroupAdmin` | `context.is_group_admin` (telegram `get_chat_administrators`; private chat ⇒ always true) | start/stop/reset/mode/deletemode/language/conversationtracker/autofact/autoengage/clearfacts + callbacks |
| `AllowedUser` | `allowed_handles is None OR handle in allowed_handles` (`ALLOWED_HANDLES`, `*`/empty ⇒ all) | nearly all |
| `BotAdmin` | `admin_handles is not None AND handle in admin_handles` (`ADMIN_HANDLES`) | ban/unban |
| `NotBanned` | `not users.is_user_banned(handle)` | all except ban/unban/help |
| `HasAcceptedTerms` | `users.has_accepted_terms` (declared, used via `needs_terms_accepted` flag, not in tuple) | fact/introduce/messages |

Permission gate: `BaseHandler.is_authenticated` requires **ALL** permission_classes to pass (AND).
Terms gate: if `needs_terms_accepted` and declined → silently skip; if not accepted → only prompt
terms (with keyboard) when bot is mentioned, else skip.

- [ ] Centralized `PermissionService` (spec: do not scatter admin checks) — composes the same rules
- [ ] AND-composition of permissions + localized `not_authenticated`
- [ ] Terms-gating behaviour preserved
- [ ] `is_group_admin` via grammY `getChatAdministrators` (cache to avoid spam) — private ⇒ true

---

## 10. Prompt system inventory

`prompt_manager.py` composes (preserve all, move to `src/prompts/` templates):
- `get_reply_system_prompt` — identity + chat name + chat mode + language directive + facts-usage rules + conversation-window note + "natural & concise".
- `compose_prompt` — date + chat history + user input + chat facts + user facts + user introduction.
- `compose_engage_needed_prompt` — autoengage yes/no decision prompt.
- `compose_chat_facts_prompt` / `compose_user_facts_prompt` / `_compose_user_introduction_prompt`.
- `_compose_message_history_prompt` — `name (ts UTC): text [+image desc][+voice desc]`.
- Autofact prompt (in `ai_agent`): generate durable facts, avoid duplicates, use `@handle`.

GoonerBot `src/prompts/` separation (spec): system identity · mode behavior · group context ·
user facts · group facts · recent messages · safety constraints · output style · autoengage scoring · fact extraction.
- [ ] Port every prompt above into composable templates (rebranded, group-native tone)
- [ ] GoonerBot output-style rules (short, no corporate disclaimers, no assistant tone, no hidden-prompt leaks)

---

## 11. Localization / i18n inventory

`localizer_translations.yaml`: ~40 keys × {english, russian, spanish}. Lookup by per-chat language,
falling back to default. Command descriptions are `"<command>_description"` keys; missing →
`default_command_description`. ⚠️ Original copy is heavily "⚡ lightning" themed (rebrand target).

- [ ] Port i18n mechanism (per-chat language, key lookup, `{var}` interpolation, fallback)
- [ ] Keep english/russian/spanish keys (at least english fully rebranded to GoonerBot/Gooners voice) 🔁
- [ ] Supported-languages derived from translation keys (drives `/language` keyboard)
- [ ] All ⚡-lightning + "RP roleplay" + GitHub `Flagro/TelegramRPBot` links replaced 🔁

---

## 12. Config inventory (YAML → zod env + TS config)

| Original file | Keys | GoonerBot |
|---|---|---|
| `tg_config.yaml` | new_dialog_timeout=600, enable_message_streaming=true, n_chat_modes_per_page=10, stream_buffer_sleep_time=0.5, rate_limiter_max_retries=5 | config module + env overrides |
| `bot_config.yaml` | default_language=english, last_n_messages_to_remember=25, last_n_messages_to_store=50, default_usage_limit=1e9 | env: MAX_CONTEXT_MESSAGES=25, MAX_STORED_MESSAGES_PER_CHAT=50, default usage limit |
| `ai_config.yaml` | model + pricing defs | provider config + optional pricing table |
| `default_chat_modes.yaml` | assistant, motivator, light | **replaced** by Gooners modes (see §13) |

### Env var mapping (original → GoonerBot)
| Original | GoonerBot |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` (kept) |
| `OPENAI_API_KEY` | `LLM_API_KEY` (+ provider-specific keys) |
| `ADMIN_HANDLES` | `ADMIN_HANDLES` (kept) |
| `ALLOWED_HANDLES` | `ALLOWED_HANDLES` (kept; `*`/empty ⇒ all) |
| `DB_USER/PASSWORD/HOST/PORT/NAME` + `DB_ADMIN_*` | `MONGO_URI` + `MONGO_DB` (+ docker admin/init vars) |
| — | `BOT_USERNAME=GoonerBot` |
| — | `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_VISION_MODEL`, `LLM_IMAGE_MODEL`, `LLM_TRANSCRIPTION_MODEL` |
| — | `DEEPSEEK_API_KEY/BASE_URL/MODEL` |
| — | `AUTOENGAGE_DEFAULT_ENABLED`, `CONVERSATION_TRACKER_DEFAULT_ENABLED`, `AUTOFACT_DEFAULT_ENABLED` |
| — | `MAX_REPLIES_PER_CHAT_PER_HOUR`, `AUTOENGAGE_MIN_COOLDOWN_SECONDS` |
| — | `MESSAGE_HISTORY_RETENTION_DAYS`, `MAX_CONTEXT_MESSAGES`, `MAX_STORED_MESSAGES_PER_CHAT` |
| — | `LOG_LEVEL`, `NODE_ENV` |

- [ ] zod schema, fail-fast on required, optional capabilities non-fatal
- [ ] No hardcoded secrets / group IDs / model names (defaults-only examples allowed)

---

## 13. Chat modes inventory & Gooners rebrand

Original built-in modes (per-chat seeded): **assistant** (👩🏼‍🎓 General Assistant), **motivator**
(🌟 Motivator), **light** (🤡 Light Humorist). User-defined modes are per-chat, addable/deletable,
one `active_mode` at a time, default = first if none active.

GoonerBot built-in modes (replace originals — mechanism identical, content rebranded) 🔁:
- [ ] `default` — natural group participant, funny, short, contextual
- [ ] `roast` — light roast/banter, never hateful, no protected categories
- [ ] `hype` — hypes group, raids, announcements, wins
- [ ] `lorekeeper` — tracks recurring jokes, group/user facts, lore, callbacks
- [ ] `chaos` — unpredictable but rate-limited and safe
- [ ] `market_degen` — crypto/degen vibes, **no financial advice as certainty / no profit promises**
- [ ] `meme_recorder` — turns funny moments into quote/meme candidates, remembers them

Mode behaviour parity:
- [ ] add/select/delete per chat (commands 4–6) · one active · default fallback · `added_by` cleared on user-data wipe

---

## 14. AutoEngage upgrade (spec)

Original = single LLM yes/no per message when autoengage ON. Spec requires a richer `AutoEngageScorer`:
- Inputs: recent history, current message, mode, user facts, group facts, recent bot replies, cooldown state, admin config, mentioned/replied flag, conversation energy.
- Output: `{ shouldReply, confidence, reason, suggestedTone, risk: low|medium|high }`.
- Must respect: per-chat cooldown, per-user cooldown, max replies/hour/chat, no chain-spam, never for banned trigger, almost-always when mentioned/replied (unless stopped/disabled), less often in passive tracking.

- [ ] `AutoEngageScorer` service (LLM-backed, mockable)
- [ ] Cooldown + rate-limit state (per chat / per user) — new collection or in `chats`/in-memory + persisted
- [ ] Tests with mocked LLM

---

## 15. Telegram adapter inventory

`telegram/bot.py` (python-telegram-bot): ApplicationBuilder, `concurrent_updates`, `AIORateLimiter`,
`post_init` sets BotFather commands, polling. Handlers: CommandHandler, MessageHandler
(`TEXT|VOICE|PHOTO & ~COMMAND`), CallbackQueryHandler (`^action`). Streaming: edits one message
progressively (`buffer_streaming_response` thresholds differ for group vs private), then sends media
separately (audio>image priority). `push_state` sends chat action (typing/upload_photo/upload_audio).
`send_message` priority audio>image>text, ParseMode.HTML, reply-to, inline keyboard.

- [ ] grammY bot, long-polling (document webhook option)
- [ ] Command/message/callback registration + BotFather command sync
- [ ] **Privacy Mode** documentation (must be disabled to read all group messages) — README §
- [ ] Streaming via message edits (buffered) — or document simplification ⚠️ §9
- [ ] chat actions (typing/upload) · HTML parse · reply-to · inline keyboards
- [ ] grammY rate-limiter / anti-spam (transformer or middleware)

---

## 16. Docker / deployment inventory

- `Dockerfile`: python:3.11 + poetry → `python main.py`. → **rewrite**: node:22-alpine, pnpm, build TS, `node dist/main.js`.
- `docker-compose.yaml`: `bot` + `mongo:8.0` (`--auth`, init user script), internal network, restart always.
- `docker-compose.dev.yaml`: mongo only for local dev.
- `init/01-init-app-user.js`: create app DB user (readWrite). → keep equivalent.

- [ ] Node Dockerfile (multi-stage, pnpm)
- [ ] docker-compose.yaml (bot + mongo:8.0 + init user + volume + network)
- [ ] docker-compose.dev.yaml (mongo only)
- [ ] init mongo user script
- [ ] No `shutdown` wording anywhere; use restart/reboot/service restart only

---

## 17. CI / workflows inventory

- `lint.yaml` (flake8/pylint/yamllint) → **replace** with eslint + prettier + tsc + vitest.
- `publish.yaml` (build & push image to ghcr on release) → optional port.
- `release.yaml` (semver release dispatch) → optional port.

- [ ] CI: typecheck + lint + test (vitest)
- [ ] (optional) image publish workflow

---

## 18. Tests checklist (spec)

- [ ] command parsing
- [ ] permission checks (AND-composition, admin/banned/allowed)
- [ ] mode creation / deletion / selection
- [ ] fact creation / clearing
- [ ] autoengage scorer (mocked LLM)
- [ ] provider selection (by env)
- [ ] env validation (zod) — required missing fails, optional missing OK
- [ ] banned-user behaviour
- [ ] rate-limit behaviour
- [ ] prompt builder

---

## 19. Not-Ported / Deviations / Bugs-to-fix (document everything here)

These are original behaviours that are **obsolete, buggy, or intentionally adapted**. None are
silently dropped; each has a GoonerBot decision.

1. **omnimodkit dependency** — OpenAI-only, hardcoded. *Replaced* by `LLMProvider` abstraction (spec). The structured output-type router and pricing concepts are preserved.
2. **`/facts` undocumented command** — exists in code, not in README. *Preserved & documented* in §2.
3. **`/ban` requires a seconds duration as 2nd arg** (`int(args[1])`) but README shows only `[@handle]` and will crash if missing. *Adapted*: GoonerBot makes duration optional (default permanent or env default), reply-aware, with validation — no crash.
4. **`is_user_banned` ignores `banned_until`** — a temporary ban never auto-expires in the check. *Fixed*: GoonerBot honours expiry (auto-unban when `bannedUntil < now`).
5. **`user_usage` monthly reset bug** — compares `current_date > last_reset` where `last_reset` may be a `date`; reset is effectively daily/inconsistent and `get_user_usage_report` constructs the pydantic model with positional args (likely broken). *Fixed*: GoonerBot uses an explicit period (configurable) and correct reset logic.
6. **No DB indexes** in original. *Added* per §5.
7. **`clearfacts` has no self-vs-admin distinction** (any GroupAdmin/AllowedUser can clear anyone). Spec wants "self or admin for others". *Adapted*: GoonerBot allows self-clear for anyone, others require admin.
8. **`addmode` mode-name extraction** = naive first-sentence split (TODO: NER in original). *Kept* simple; documented.
9. **Russian/Spanish translations** — kept structurally; English is the fully-rebranded source of truth. RU/ES copy ported but may retain lighter rebranding (documented). 🔁
10. **Streaming message-edit UX** — original edits a single message progressively with group/private thresholds. GoonerBot ports this; if Telegram edit-rate limits make it noisy, may fall back to single final message (will be documented if so). ⚠️
11. **Moderation via OpenAI omni-moderation** — provider-specific. *Adapted* to a capability; basic safety (no doxxing/private-data) implemented provider-agnostically.
12. **TTS audio output** — present in original (`AudioResponse`). *Preserved* as optional, capability-gated.
13. **`new_dialog_timeout` (600s)** in tg_config — defined but the "same conversation within an hour" is enforced only as a prompt hint, not code. *Kept* as prompt hint + config.
14. **Auto-discovery of handlers** via filesystem import (`__init__.py` scanning `*handler.py`). *Adapted* to an explicit handler registry (TS-friendly, tree-shakeable, testable).
15. **Python runtime** — fully removed post-migration (spec). No Python deps remain.

---

## 20. Deliverables checklist (spec)

- [x] Clone & study original
- [x] **MIGRATION_AUDIT.md** (this file)
- [ ] FEATURE_PARITY.md (table: feature · original file/fn · new TS impl · status · notes)
- [ ] ARCHITECTURE.md
- [ ] ENVIRONMENT.md
- [ ] README.md (rebranded; Privacy Mode; provider setup for solclawn & DeepSeek; run + test instructions)
- [ ] .env.example (GoonerBot, no secrets)
- [ ] src/main.ts
- [ ] src/config (zod)
- [ ] src/telegram (adapter + handlers, thin)
- [ ] src/domain (Person/Context/Message/entities)
- [ ] src/services (permission, modes, facts, usage, autoengage, conversation, terms, ban)
- [ ] src/providers/llm (+ adapters: solclawn/openai/deepseek/ollama/custom)
- [ ] src/providers/media
- [ ] src/storage (Mongo repositories + indexes)
- [ ] src/prompts
- [ ] src/jobs (autofact batch, retention cleanup, cooldown)
- [ ] src/utils
- [ ] tests (vitest, §18)
- [ ] Docker + compose (§16)
- [ ] eslint + prettier + tsconfig (strict) + pino logger
- [ ] Run: `pnpm install && pnpm build && pnpm start` · Tests: `pnpm test` · Lint: `pnpm lint`
- [ ] Final summary (ported / rebranded / Telegram setup / solclawn config / DeepSeek switch / run / test / limitations)

---

## 21. Build order (migration process, spec §1–22)

1. [x] Clone original · 2. [x] Audit · 3. [x] MIGRATION_AUDIT.md · 4. [ ] TS architecture (ARCHITECTURE.md)
5. [ ] Scaffold (pnpm, tsconfig strict, eslint/prettier, vitest, pino, zod) · 6. [ ] Mongo schema + repositories + indexes
7. [ ] Telegram handlers (thin) · 8. [ ] LLMProvider abstraction · 9. [ ] solclawn adapter
10. [ ] deepseek/openai/ollama/custom adapters · 11. [ ] prompts · 12. [ ] conversation tracking
13. [ ] facts (manual + auto) · 14. [ ] autoengage scorer · 15. [ ] media · 16. [ ] usage tracking
17. [ ] docker-compose · 18. [ ] .env.example · 19. [ ] tests · 20. [ ] README · 21. [ ] lint+typecheck+test · 22. [ ] document deviations (§19)
