# Companion rework — implementation status

This is the execution ledger for `/home/funboy/GOONERSBOT_COMPANION_REWORK_PLAN.md`.
It records verified behavior, not intent. States are `planned`, `in_progress`, `implemented`,
`verified` and `blocked_external`; `verified` requires the package-specific acceptance evidence.

## Baseline

- Branch: `companion-rework/phase-1-ingress`
- Pre-rework baseline: `c1807d0`
- Durable-ingress starting commits: `9f74ed9`, `383e804`
- Production activation: not performed by this implementation work

## Package ledger

| Package | State | Commit | Runtime path | Evidence (UTC) | Missing gate / next activity |
| --- | --- | --- | --- | --- | --- |
| R00 | implemented | `8616047` | `companion/ingress/*`, `telegram/bot`, `updateInbox` | 113 files / 1,311 tests, typecheck, lint, build; simulated fault tests; 2026-09-19 | Isolated real-Mongo legacy-index migration and process-level SIGTERM rehearsal before `verified`. |
| R01 | implemented | `056af95` | `companion/capabilities/catalog`, Cortex, AgentRuntime, SelfKnowledge | 116 files / 1,323 tests, typecheck, lint, build and format; natural installed-recipe execution; 2026-09-19 | Real-model semantic corpus and context-specific authorization/readiness remain release gates; R02 consumes the catalog contract. |
| R02 | implemented | this commit | `companion/context`, Cortex/TurnEvaluator adapters, ReplyService | 117 files / 1,332 tests, typecheck, lint, build and format; multi-intent, provenance, control and degraded-routing cases; 2026-09-19 | Real-model multilingual corpus plus persistent clarification/control are joint R02+R04 release gates. |
| R03 | planned | — | — | — | Unified provider/action dispatch. |
| R04 | planned | — | — | — | Persistent tasks and concurrent task control dialogue. |
| R05 | planned | — | — | — | Multi-artifact outbox and verified delivery. |
| R06 | planned | — | — | — | Bounded continuation, correction and progress evaluation. |
| R07 | planned | — | — | — | Common expression policy and naturalness evals. |
| R08 | planned | — | — | — | Operational, personal and project memory scopes. |
| R09 | planned | — | — | — | Shared resource governor and workload containment. |
| R10 | planned | — | — | — | Web/document/data/code/media capability families. |
| R11 | planned | — | — | — | Connected accounts and reusable delegations. |
| R12 | planned | — | — | — | Reminders, monitors and relevant initiative. |
| R13 | planned | — | — | — | Versioned workflow learning and capability discovery. |
| R14 | planned | — | — | — | Parity migration, final recovery/load evals and release handoff. |

## R00 evidence

Automated cases currently present:

- 20-conversation burst proves the executor never exceeds its configured concurrency.
- A durable admission failure proves the next Telegram poll does not acknowledge past the failed
  update; the same update is retried at the preserved offset.
- Fenced completion proves bot id, owner id and claim generation are all required.
- Expired running work is classified `outcome_unknown`, not blindly executed a second time.
- Terms decline redacts active inbox payloads through immutable Telegram actor id.

Remaining R00 checks before changing the state to `verified`:

- migration smoke test against a copy of the current Mongo index/receipt shape;
- process-level SIGTERM rehearsal with a real long-poll request and Mongo test instance.

Repository-wide unit tests, typecheck, lint, build, simulated recovery/live ordering, lease overrun,
count/byte saturation, two-owner fencing and intake abort have passed. These do not masquerade as a
real Mongo/process rehearsal. The architecture/provider inventory and seed corpus are versioned in
`docs/COMPANION_BASELINE.md` and `tests/fixtures/companion-conversation-corpus.json`.

## R01 evidence

- One versioned runtime catalog owns capability identity, operation schemas, effects, retry and
  idempotency policy, requirements, resource class, limits and legacy provider mapping.
- Cortex schemas/prompts, planner definitions, handler validation, terminal routing, self-knowledge,
  `/capabilities` and generated command documentation derive from that catalog or its per-turn
  readiness snapshot.
- Bootstrap tests reject a capability advertised without an executable handler; invocation and
  output validation run at the execution boundary.
- `news` and `document_read` are both executable through the agent runtime. A composite integration
  test proves their verified results and news evidence reach one final answer.
- An installed Forge recipe is exposed to Cortex and executes from a natural semantic selection via
  `args.command`; no slash command or duplicate enum entry is required.
- The repository-wide suite passes serially (116 files / 1,323 tests). A parallel-only collision in
  the pre-existing local-development Git tests was reproduced and disappears under isolated file
  execution; it is recorded as test-harness isolation debt rather than hidden as a runtime failure.

## R02 evidence

- `TurnContext` and `TurnUnderstanding` are strict versioned schemas used by the real reply path,
  not detached interfaces. They preserve immutable actor/chat/topic scope, authored text versus STT,
  exact reply and attachment provenance, per-turn capability readiness and visible work.
- Cortex, its degraded fallback and the alternate TurnEvaluator converge through adapters without
  adding another LLM round trip. Multiple operations and speech acts survive together; a stray
  `stay_quiet` cannot erase requested work.
- Existing anime-archive and local-development work is exposed through a read-only scope-filtered
  adapter. Model-selected task references do not grant authority.
- Quoted reply contents are context rather than commands in the degraded path. Explicit
  no-download negation suppresses automatic link rehost selection.
- Missing material inputs produce one bounded clarification contract and skip provider execution;
  commands remain optional shortcuts rather than prerequisites.
- Brain debug traces retain the normalized understanding. The final expression path sees visible
  work as untrusted facts, so status answers need not invent job state.
- Persistence/resumption of pending clarification and execution of generic task controls remain the
  explicit joint R02+R04 gate; this package does not claim those future transitions are complete.

## Compatibility rules held throughout the rework

- Cortex, evaluators and semantic provider/action selection remain the natural-language control
  plane. Slash commands may expose the same protocol but may not become required to start work.
- Long-running work must not impersonate conversational completion: acknowledgement, progress,
  artifacts and delivery receipts are distinct states.
- Existing archive identity, source-file behavior, security boundaries and social/personality
  behavior stay covered until a replacement has demonstrated parity.
- No production restart, migration or feature activation is implied by a development package.
