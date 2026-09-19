# Companion rework — implementation status

This is the execution ledger for `/home/funboy/GOONERSBOT_COMPANION_REWORK_PLAN.md`.
It records verified behavior, not intent. A package is `done` only after its acceptance tests and
the repository-wide quality gates pass.

## Baseline

- Branch: `companion-rework/phase-1-ingress`
- Pre-rework baseline: `c1807d0`
- Durable-ingress starting commits: `9f74ed9`, `383e804`
- Production activation: not performed by this implementation work

## Package ledger

| Package | State | Verified delivery |
| --- | --- | --- |
| R00 | in progress | Correct atomic semaphore; custom persist-before-offset polling; one ordered recovery path; bot-scoped receipts; count/byte backpressure; owner/fence/heartbeat leases; expired legacy effects quarantined; terminal payload redaction; privacy erasure integration; intake-first bot shutdown. Repository-wide verification pending. |
| R01 | pending | Executable capability catalog. |
| R02 | pending | Natural turn understanding and request contract. |
| R03 | pending | Unified provider/action dispatch. |
| R04 | pending | Persistent tasks and concurrent task control dialogue. |
| R05 | pending | Multi-artifact outbox and verified delivery. |
| R06 | pending | Bounded continuation, correction and progress evaluation. |
| R07 | pending | Common expression policy and naturalness evals. |
| R08 | pending | Operational, personal and project memory scopes. |
| R09 | pending | Shared resource governor and workload containment. |
| R10 | pending | Web/document/data/code/media capability families. |
| R11 | pending | Connected accounts and reusable delegations. |
| R12 | pending | Reminders, monitors and relevant initiative. |
| R13 | pending | Versioned workflow learning and capability discovery. |
| R14 | pending | Parity migration, final recovery/load evals and release handoff. |

## R00 evidence

Automated cases currently present:

- 20-conversation burst proves the executor never exceeds its configured concurrency.
- A durable admission failure proves the next Telegram poll does not acknowledge past the failed
  update; the same update is retried at the preserved offset.
- Fenced completion proves bot id, owner id and claim generation are all required.
- Expired running work is classified `outcome_unknown`, not blindly executed a second time.
- Terms decline redacts active inbox payloads through immutable Telegram actor id.

Remaining R00 checks before changing the state to `done`:

- repository-wide unit suite, typecheck, lint and build;
- integration fault cases for recovery/live ordering, queue byte/count saturation and SIGTERM;
- migration smoke test against a copy of the current Mongo index/receipt shape;
- metrics/baseline inventory required by phase 0.

## Compatibility rules held throughout the rework

- Cortex, evaluators and semantic provider/action selection remain the natural-language control
  plane. Slash commands may expose the same protocol but may not become required to start work.
- Long-running work must not impersonate conversational completion: acknowledgement, progress,
  artifacts and delivery receipts are distinct states.
- Existing archive identity, source-file behavior, security boundaries and social/personality
  behavior stay covered until a replacement has demonstrated parity.
- No production restart, migration or feature activation is implied by a development package.
