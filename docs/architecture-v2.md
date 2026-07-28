# GoonerBot assistant runtime v2

## Runtime contract

The bot separates six concerns that were previously entangled:

1. **Perception** converts Telegram updates into platform-neutral text, images, audio, video and
   document attachments. Current-message and replied-to media are first-class inputs.
2. **Social cognition** resolves the speaker, relevant members, relationships, current group norms,
   running jokes and joke fatigue. Claims retain provenance, confidence and lifecycle state.
3. **Cortex** decides the human goal and selects only capabilities that are actually available.
4. **Action planning** can produce a bounded dependency graph instead of assuming that one request
   equals one tool. Independent actions run in parallel; dependent actions receive verified outputs.
5. **Execution** runs allowlisted tools with call budgets, timeouts and acceptance checks. The reply
   layer cannot invent a tool run or deny an attachment that perception supplied.
6. **Expression** turns verified results into the group's voice. Gratitude, distress, serious help,
   factual work and banter have different aggression envelopes; style cannot replace task completion.

The normal turn therefore looks like:

```text
Telegram update
  -> perception + speaker/thread resolution
  -> scene analysis + social context + relevant memory
  -> Cortex
  -> dependency-aware action plan
  -> tool execution + verification + artifacts
  -> social/style calibration + semantic anti-repetition
  -> text and every produced media artifact
  -> asynchronous social/memory learning
```

## Living social model

Social memory is separate from raw history and from generic lore:

- each known member has aliases, presence, interests, preferences, aversions, skills, roles, goals,
  habits and communication style;
- facts can be reinforced, revised, disputed, retracted, superseded or made stale instead of
  accumulating contradictions forever;
- relationships track familiarity, trust, warmth, support, affinity, rivalry and banter affinity;
- running jokes have variants, vitality, cooldown and fatigue, so a callback can evolve or retire;
- group norms and shared themes are learned from recent conversation;
- Telegram reactions and explicit/implicit feedback affect style selection and callback reuse;
- maintenance decays weak inferences and overused material while preserving well-supported facts.

At startup, a versioned, per-window backfill covers the complete configured retained history. Each
successful window is checkpointed. A malformed/provider-failed extraction cannot advance either
cursor or masquerade as an empty result. Scheduled mining then drains every unseen human message in
bounded batches, using Telegram `message_id` rather than timestamps so bursts and equal-second
messages are not lost. Older messages can provide look-behind context but cannot be reused as fresh
provenance. Bootstrap and scheduled learning share one serialized, low-priority lane.

The learning lane uses an independent OpenAI-compatible provider. Its configured model is pinned,
the conversation-plan header and model overrides are suppressed, and its usage never debits chat
quota. An unmetered model allocation removes economic preselection, not upstream rate limits: the
provider has one in-flight request, FIFO admission, a configured maximum of three actual request
starts in any rolling 60 seconds and a minimum 20-second start gap. Native JSON calls, prompt-only
JSON fallbacks and repair attempts all pass through that same pacer.

The pacer also reserves a conservative rolling token envelope before dispatch. Lore considers the
complete retained set locally but sends only the twenty most relevant items within 2.8 KB; social
context is focused on current participants and capped at 2.8 KB; transcript windows are packed
chronologically within 12 KB without dropping eligible message ids. The compact mining schema hints
replace redundant generated schemas while strict Zod validation and repair remain active.

Only this background provider has a 180-second request timeout. A transient provider failure opens a
60-second cooldown; the failed cursor/checkpoint remains unchanged and is resumed on a later
watchdog or backfill attempt. Live mining and historical backfill cannot overlap or bypass the
pacer. None of these waits block Telegram polling or extend the interactive chat timeout.

On Gemma Free routes the reply generator makes one candidate call rather than three parallel copies
of the same prompt. GemRouter receives `X-GemRouter-Group-Plan` plus the legacy compatibility header,
and response metadata identifies the backend model that actually served the request. Client
fallback models must not point back to the same intelligent router.

Processing every message removes economic relevance gates, not the deterministic filters for
provenance, consent, sensitive data, confidence, salience and deduplication.

The prompt receives only a compact, relevant slice of this model. Sensitive internal scores are not
exposed by public commands.

## Multi-action orchestration

The planner receives an exact registry of available tools and may combine web research, document
reading, translation, speech, image generation, video generation and media delivery in one turn.
Plans are schema-validated before execution:

- every dependency must exist and the graph must be acyclic;
- unavailable or over-budget tools invalidate the plan;
- dependent actions are skipped when their prerequisites fail;
- tool outputs carry evidence, confidence, verification state and zero or more artifacts;
- the composer reports partial completion honestly and Telegram sends all successful artifacts,
  rather than silently dropping everything after the first one.

An empty or structurally invalid model response is treated as provider failure and advances through
the fallback chain.

## Response acceptance and recovery

The anti-repeat layer separates hard blocks from ranking signals. A high-confidence lexical or
semantic clone, an explicitly banned/canned phrase, an unauthorized verbatim-memory callback, an
internal deflection message or a social-floor violation can block a candidate. Semantic blocking
uses a stricter high-confidence threshold than lexical similarity. Reused openings, premises and
comedy strategies only lower the score. The best acceptable candidate is therefore used immediately
instead of being discarded for imperfect novelty.

The model ranker has a deterministic local fallback that preserves candidate order. Only when every
candidate is hard-blocked does the generator make one bounded regeneration attempt. If that attempt
still leaves only duplicate but socially safe, substantive text, the runtime returns the best usable
candidate instead of an evasive request to reformulate. Task completion and factual/tool
consistency outrank stylistic novelty; a weak joke must never erase the useful answer beneath it.
This last resort relaxes only repetition or canned-style blocks. It never restores unauthorized
memory, a social-floor violation or an internal deflection. If no safe candidate remains, a concise
scene-calibrated fallback provides support or names the exact missing evidence/context without
exposing internal ranking or generation.

## Documents

`DocumentProcessor` treats every upload as untrusted, inert data:

- PDF uses selectable-text extraction.
- DOCX uses raw semantic text extraction, without macros or external-file access.
- Text, Markdown, code, JSON, CSV, XML and configuration files are decoded directly.
- HTML has script/style/noscript/SVG content removed before visible text is extracted.
- Unsupported and scanned formats are acknowledged with an exact limitation; the assistant must
  not claim that the file is absent.
- Per-file and per-turn limits bound prompt size. Long-form summary and technical plans receive a
  larger response budget than ordinary group banter.
- Long extracted documents use chunk-level factual notes followed by a constrained synthesis, so a
  summary is not based only on the first page; the deterministic fallback keeps the document before
  dependent translation and speech actions.

## Capability Forge

The Forge deliberately distinguishes "more autonomous" from "arbitrary remote code execution."

An LLM may create and persist a schema-validated `research_recipe`. A recipe contains a stable slash
command, a search-query template and a synthesis instruction. On execution it runs grounded,
read-only search and answers from the returned sources. The manifest is atomically written under
`data/capabilities/` and loaded again on restart.

Anything that needs credentials, writes to an external account, controls the local machine, installs
packages or compiles code is stored under `data/capabilities/proposals/`. It is never reported as
executed. This prevents a random group message or prompt injection inside a PDF from becoming shell
access while still preserving the proposed capability and its required configuration.

Only a configured bot admin can auto-install a global recipe. Other users can trigger a proposal but
cannot mutate the global capability registry.

This is the permanent extension boundary: the bot can acquire useful read-only commands during a
conversation, while arbitrary package installation, compilation, shell execution and credentialed
writes remain explicit operator work. That boundary prevents messages, websites and documents from
turning prompt injection into host access.

## Media prompt compilation

Image and video requests are compiled before generation. The compiler keeps the user's intent, then
adds relevant conversation and social context, subject continuity, composition, lighting, camera,
motion, temporal coherence and provider-specific quality constraints. Negative prompts are passed to
local Stable Diffusion instead of being discarded. Video prompts describe a shot over time rather
than treating video as a static image with the word "moving" appended.

## Provider resilience

Text/reasoning providers form an ordered chain:

1. primary provider;
2. operator-configured `LLM_FALLBACK_*`;
3. alternative models on the same gateway (`LLM_ROUTER_FALLBACK_MODELS`);
4. configured Groq free tier;
5. configured Gemini free tier;
6. OpenRouter free-model router;
7. Cloudflare Workers AI free allocation.

Every layer is optional. A circuit breaker temporarily removes a failing/exhausted upstream from the
hot path, then retries it automatically after cooldown. Circuits are isolated by operation, so one
bad structured response does not demote a provider for ordinary conversation. JSON tasks use native
`json_object` mode where available, include a generated JSON Schema in the prompt, validate every
balanced candidate, and run one error-guided repair before changing route. Public provider fallbacks
do not receive the router-specific group-plan header. Provider quotas and model availability remain
external facts and must be checked in their official documentation.
