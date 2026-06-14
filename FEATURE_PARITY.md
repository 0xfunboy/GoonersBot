# FEATURE_PARITY.md — GoonerBot

Mapping every feature of the original **Flagro/TelegramRPBot** (Python) to its **GoonerBot**
(TypeScript) implementation. Status: ✅ ported · 🔁 ported + rebranded · 🔧 ported + adapted/fixed.

## Commands

| Original feature | Original file/function | GoonerBot implementation | Status | Notes |
|---|---|---|---|---|
| `/start` | `commands/start_handler.py` | `telegram/handlers/commands/lifecycle.ts` `startCommand` → `chats.startChat` | 🔁 | rebranded copy |
| `/stop` | `commands/stop_handler.py` | `lifecycle.ts` `stopCommand` → `chats.stopChat` | 🔁 | |
| `/reset` | `commands/reset_handler.py` | `lifecycle.ts` `resetCommand` → `conversation.reset` | 🔁 | |
| `/mode` | `commands/mode_handler.py` | `commands/modes.ts` `modeCommand` + `set_chat_mode` callback | ✅ | |
| `/addmode` | `commands/addmode_handler.py` | `modes.ts` `addmodeCommand` → `ModeService.add` (first-sentence name) | ✅ | |
| `/deletemode` | `commands/deletemode_handler.py` | `modes.ts` `deletemodeCommand` + `delete_chat_mode` callback | ✅ | |
| `/introduce` | `commands/introduce_handler.py` | `commands/facts.ts` `introduceCommand` → `facts.setIntroduction` | ✅ | needs terms |
| `/fact` | `commands/fact_handler.py` | `facts.ts` `factCommand` → `facts.addManualFact` | ✅ | needs terms |
| `/facts` | `commands/facts_handler.py` | `facts.ts` `factsCommand` | ✅ | undocumented in original README; preserved |
| `/clearfacts` | `commands/clearfacts_handler.py` | `facts.ts` `clearfactsCommand` | 🔧 | self-clear anyone; others require admin |
| `/usage` | `commands/usage_handler.py` | `commands/misc.ts` `usageCommand` → `usage.getReport` | 🔁 | now shows usage/limit |
| `/language` | `commands/language_handler.py` | `misc.ts` `languageCommand` + `set_chat_language` callback | ✅ | |
| `/terms` | `commands/terms_handler.py` | `misc.ts` `termsCommand` + `terms_response` callback | 🔁 | rebranded terms text |
| `/conversationtracker` | `commands/conversationtracker_handler.py` | `commands/toggles.ts` `conversationtrackerCommand` | ✅ | |
| `/autofact` | `commands/autofact_handler.py` | `toggles.ts` `autofactCommand` | ✅ | |
| `/autoengage` | `commands/autoengage_handler.py` | `toggles.ts` `autoengageCommand` | ✅ | |
| `/ban` | `commands/ban_handler.py` | `commands/moderation.ts` `banCommand` → `BanService.ban` | 🔧 | duration optional (no crash); reply-aware; expiry honoured |
| `/unban` | `commands/unban_handler.py` | `moderation.ts` `unbanCommand` → `BanService.unban` | ✅ | reply-aware too |
| `/help` | `commands/help_handler.py` | `misc.ts` `helpCommand` | 🔁 | full GoonerBot rebrand |

## Callbacks (inline keyboards)

| Original | Original file | GoonerBot | Status |
|---|---|---|---|
| `set_chat_mode` | `callbacks/set_chat_mode_handler.py` | `handlers/callbacks/index.ts` `setChatMode` | ✅ |
| `delete_chat_mode` | `callbacks/delete_chat_mode_handler.py` | `callbacks/index.ts` `deleteChatMode` | ✅ |
| `set_chat_language` | `callbacks/set_chat_language_handler.py` | `callbacks/index.ts` `setChatLanguage` | ✅ |
| `show_chat_modes` | `callbacks/show_chat_modes_handler.py` | `callbacks/index.ts` `showChatModes` | ✅ |
| `show_chat_languages` | `callbacks/show_chat_languages_handler.py` | `callbacks/index.ts` `showChatLanguages` | ✅ |
| `terms_response` | `callbacks/terms_response_handler.py` | `callbacks/index.ts` `termsResponse` | ✅ |
| paginated keyboard | `telegram/keyboards.py` | `telegram/keyboards.ts` `buildInlineKeyboard` + `parseCallbackData` | ✅ |

## Conversational engine

| Original feature | Original | GoonerBot | Status |
|---|---|---|---|
| Message handler (passive/engage/reply) | `messages/message_handler.py` | `telegram/handlers/message.ts` | ✅ |
| Chat-started + tracking/mention gate | message_handler | message.ts gates | ✅ |
| Bot-mention detection | `telegram/utils.py::bot_mentioned` | `telegram/context.ts::isBotAddressed` | ✅ |
| Autoengage yes/no | `prompt_manager.compose_engage_needed_prompt` + `ask_yes_no` | `services/autoengage.ts::AutoEngageScorer` | 🔧 | richer `{shouldReply,confidence,reason,suggestedTone,risk}` + cooldowns + hourly cap |
| Streaming reply | `telegram/bot.py` buffered edits | `message.ts::streamAndPersist` (throttled edits) | ✅ |
| AI agent / output-type routing | `ai_agent/agent_tools/agent.py` | `services/reply.ts::ReplyService` | 🔧 | text always; image output on explicit request + capability |
| Manual facts | `db_models/user_facts.py` | `services/facts.ts` + `storage/repositories/facts.ts` | ✅ |
| Auto facts | `ai_agent inject_autofact` | `reply.ts::extractAndStoreFacts` + `llm.extractFacts` | ✅ |
| Introductions | `db_models/user_introductions.py` | facts repo `source='introduction'` | ✅ |
| Usage estimate + record | `models_toolkit.estimate_price/get_price` | `services/usage.ts` + `usage` repo | 🔧 | tokens/calls/cost per provider/model |
| Moderation | omnimodkit `ModerationError` | provider-agnostic safety in prompts + sensitive-fact filter | 🔧 | capability-based; basic safety |

## Media

| Original | Original | GoonerBot | Status |
|---|---|---|---|
| Image input (vision) | `ai_agent vision_model` + `utils.get_message` | `providers/media MediaProcessor.describeImage` + `context.ts` download | ✅ |
| Voice input (transcription) | `ai_agent audio_recognition_model` | `MediaProcessor.transcribeVoice` | ✅ |
| Text output | text model | `ReplyService.streamReply` | ✅ |
| Image output (generation) | `ai_agent image_generation_model` | `MediaProcessor.generateImage` (capability-gated) | ✅ |
| Audio output (TTS) | `ai_agent AudioResponse` | capability flag + provider hook (gated; off unless `LLM_TTS_MODEL`) | 🔧 | preserved as optional |
| Graceful capability fallback | omnimodkit `can_use_model` | `capabilities` + own-property methods + null-returning media routing | 🔧 | no crash on missing capability |

## Data model

| Original collection | Original | GoonerBot collection / repo | Status |
|---|---|---|---|
| `users` | `db_models/users.py` | `users` (`UsersRepo`) | ✅ |
| `user_usage` | `db_models/user_usage.py` | `usage` + `usage_events` (`UsageRepo`) | 🔧 | richer counters; UTC-month reset fix |
| `chats` | `db_models/chats.py` | `chats` (`ChatsRepo`) | ✅ |
| `user_facts` | `db_models/user_facts.py` | `facts` (`FactsRepo`) | 🔧 | one-doc-per-fact + source + dedupe |
| `user_introductions` | `db_models/user_introductions.py` | `facts` (source=introduction) | ✅ |
| `chat_modes` | `db_models/chat_modes.py` | `modes` (`ModesRepo`) | ✅ |
| `dialogs` | `db_models/dialogs.py` | `messages` (`MessagesRepo`) | 🔧 | TTL + cap + indexes |
| — | (original `TODO`: split) | `bans`, `terms_acceptance` (`BansRepo`/`TermsRepo`) | 🔧 | split out + expiry |
| — | — | `chat_members`, `media`, `jobs` | 🔧 | new (per spec) |
| (no indexes) | — | `Storage.ensureIndexes()` all collections | 🔧 | added |

## Cross-cutting

| Original | Original | GoonerBot | Status |
|---|---|---|---|
| Permissions | `auth.py` permission classes | `services/permissions.ts::PermissionService` | 🔧 | centralized, AND-composed |
| Terms gating | `base_handlers.py` flow | `dispatch.ts` + `message.ts` terms gate | ✅ |
| Localization (en/ru/es) | `localizer.py` + yaml | `config/i18n.ts::Localizer` | 🔁 | rebranded copy |
| Per-chat language | `chats.get_language` | `chats` repo + Localizer | ✅ |
| Built-in modes | `default_chat_modes.yaml` (assistant/motivator/light) | `config/modes.ts` (7 Gooners modes) | 🔁 | replaced |
| Config | yaml + decouple | `config/env.ts` (zod) + config modules | 🔧 | fail-fast, typed |
| LLM (OpenAI-only) | `omnimodkit` | `providers/llm` abstraction + 5 providers | 🔧 | solclawn/openai/deepseek/ollama/custom |
| Rate limiter | `AIORateLimiter` | grammY + `utils/rateLimit` cooldowns/caps | 🔧 | |
| Deployment | Docker + compose + Poetry | Node + local Mongo + pnpm (no Docker/Python) | 🔧 | per project requirement |
| Entry | `main.py` | `src/main.ts` | ✅ |

See [MIGRATION_AUDIT.md §19](./MIGRATION_AUDIT.md) for the full list of intentional deviations and bug fixes.
