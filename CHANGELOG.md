# Changelog

All notable changes to GoonersBot are documented here.

## [Unreleased]

### Fixed

- Added a conservative rolling token budget to the dedicated Gemma miner, alongside its existing
  serial 3-RPM gate. Oversized calls are rejected before reaching GemRouter.
- Replaced the 300-item episodic memory dump with deterministic relevance selection over the full
  retained set, bounded social context, byte-packed transcript windows and compact mining schemas.
- Token-constrained Gemma replies now generate one candidate instead of three identical parallel
  calls. GemRouter receives the correct group-plan header and the client records the actual backend
  model returned in response metadata.
- Removed redundant same-GemRouter fallback amplification from the production configuration.

## [2.0.0] - 2026-07-28

### Breaking changes

- Removed `/fact`, `/autofact` and the per-chat auto-fact toggle. Automatic learning now runs
  continuously; `/facts` (`/memory`, `/memoria`), `/clearfacts`, `/forget`, `/introduce` and admin
  `/setfact` remain as inspection, erasure, self-declaration and correction controls.
- Replaced the old activity-threshold fact miner with cursor-based lore and social projections.
  `MEMORY_MINING_EVERY_MESSAGES`, `MEMORY_MINING_MIN_ACTIVE_MESSAGES`,
  `FACT_EXTRACTION_CONTEXT_MESSAGES`, `FACT_REPLY_CONTEXT_BEFORE`, `FACT_REPLY_CONTEXT_AFTER`,
  `MEMORY_MODEL`, `MEMORY_MANUAL_MIN_CONFIDENCE` and `AUTOFACT_DEFAULT_ENABLED` are no longer read.
- Capability acquisition no longer implies generated-code execution. Only declarative, read-only
  research recipes can be installed automatically; credentialed integrations, host automation,
  package installation and external writes are saved as operator proposals.

### Behaviour changes

- Added a living social graph for member aliases, interests, preferences, roles, habits,
  relationships, group norms and evolving running jokes, with provenance, confidence,
  contradiction handling, lifecycle decay, cooldown and fatigue.
- Split durable memory into social profiles/relationships and episodic `memory_items` such as group
  lore, quotes and memes. Relevant slices are retrieved per turn instead of dumping the database
  into every prompt.
- Added a versioned, checkpointed history backfill and continuous mining of every unseen human
  message. Telegram message IDs are the primary cursor, so same-second bursts are not skipped.
- Pinned social/lore extraction to its own `MINING_LLM_*` provider. The production GemRouter lane is
  FIFO and serial, starts at most three requests per rolling minute, spaces starts by at least 20
  seconds, and counts JSON fallback/repair attempts in the same budget.
- Mining failures retain the exact cursor/checkpoint and resume later. The 180-second mining timeout
  no longer changes or blocks the interactive chat timeout. Transient provider failures enter a
  60-second cooldown before another slot can be consumed.
- Reworked reply acceptance: only high-confidence clones, banned/canned phrases, unauthorized
  verbatim-memory reuse, internal deflection messages and social-floor failures hard-block a
  candidate. Reused joke premises/strategies are ranking penalties. One bounded regeneration is
  allowed, after which the best substantive, socially safe candidate is returned instead of an
  evasive “rephrase” response. Last-resort recovery never restores unauthorized memory,
  social-floor violations or internal deflection text.
- Added current-message and replied-message document perception for PDF, DOCX, text/Markdown,
  source code, JSON, CSV, XML and HTML. Long documents use chunk notes plus synthesis; scanned or
  unsupported inputs are acknowledged accurately rather than reported as missing.
- Added validated multi-action planning, partial-result composition and delivery of every successful
  artifact from a turn.
- Added Capability Forge persistence for safe research commands and explicit setup proposals for
  capabilities requiring credentials or code execution.
- Image and video requests now receive conversation/social context and provider-specific prompt
  compilation rather than a single context-free generation instruction.

### Privacy and integrity

- Automatic claims require eligible human-message provenance. Older look-behind context cannot be
  reused as fresh evidence, and malformed structured output cannot advance a learning cursor.
- Memory deduplication is subject-aware, so identical text about different members does not merge
  their identities.
- Running jokes require distinct supporting observations before activation and cool down when
  overused.
- Declining the terms removes the member's durable memories and social projections; `/facts` and
  `/forget` enforce self/admin ownership boundaries.

### Migration and configuration

- Set the dedicated background route:

  ```env
  MINING_LLM_BASE_URL=http://192.168.178.27:4024
  MINING_LLM_MODEL=gemma-4-31b-it
  MINING_LLM_REQUEST_TIMEOUT_MS=180000
  MINING_LLM_MAX_REQUESTS_PER_MINUTE=3
  ```

- Keep `LLM_REQUEST_TIMEOUT_MS` at the normal interactive budget; the 180-second value is only for
  background mining.
- Replace the removed activity settings with
  `MEMORY_MINING_BATCH_MESSAGES=20`, `MEMORY_MINING_CONTEXT_MESSAGES=30` and
  `MEMORY_MINING_INTERVAL_SECONDS=60`.
- The default `REPLY_MAX_REGENERATIONS` is now `1`.
- Existing legacy facts are migrated into `memory_items` on startup. New subject-aware indexes and
  social collections are created by the normal storage initialization.
- Review `DOCUMENTS_*` and `CAPABILITY_*` before deployment. Capability manifests and proposals are
  persisted under `CAPABILITY_STORE_PATH` (default `data/capabilities`).
