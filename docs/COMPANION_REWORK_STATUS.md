# Companion rework — implementation status

Execution ledger for `/home/funboy/GOONERSBOT_COMPANION_REWORK_PLAN.md`, updated 2026-09-19.
Read with [runtime](COMPANION_RUNTIME.md) and [acceptance / handoff](COMPANION_HANDOFF.md).

- `implemented`: executable code integrated; not certification of every acceptance scenario.
- `verified_local`: named local checks passed, limited to that evidence.
- `blocked_external`: a specific proof requires consented live access, installed prerequisites or
  an authorized real-model/human evaluation session.
- `in_progress`: implementation or final acceptance remains. A green corpus inventory/unit suite
  does not mean the complete plan passed.

## Revision and rollout baseline

- Branch: `companion-rework/phase-1-ingress`; pre-rework `c1807d0`.
- Ingress starting commits: `9f74ed9`, `383e804`; R00/R01/R02: `8616047`, `056af95`, `3fd3d32`.
- Prior integrated checkpoint: `8ec700c`; this ledger additionally covers current completion changes.
  Final integrated local gates are recorded below; the delivery commit identifies this working tree.
- Production activation: **not performed**. Shared `dist/` is not a validation-build target.

## Package ledger

| Package | Implementation | Local evidence / integrated behavior | Remaining acceptance gate |
| --- | --- | --- | --- |
| R00 ingress | implemented; verified_local | Ordered bounded ingress, durable offset/admission, fencing; ingress tests and real-Mongo legacy-index/dedup/lease checks | Whole-bot SIGTERM/long-poll rehearsal; no rollout proof |
| R01 catalog | implemented; verified_local | Manifest-backed schemas/handlers/readiness and semantic recipe descriptors; catalog/natural-routing tests | Real-model paraphrase and readiness evaluation |
| R02 turn contract | implemented; verified_local | Scope/provenance, Cortex/evaluator adapters, persisted clarification and visible work | Full multilingual model corpus |
| R03 dispatch | implemented; verified_local | Typed bindings, unmet deliverables, provider observations, no composer-triggered reexecution | Real-model multi-intent acceptance |
| R04 durable work | implemented with specialized-owner adapters; verified_local | Generic worker, responsive scoped controls, archive pause/resume/narrowing/cancel, local-code controls, CAS/fences | Whole-process/real-transport recovery and latency rehearsal; legacy workers intentionally keep one owner |
| R05 delivery | implemented; verified_local | Ordered scoped artifacts, per-effect receipts, private file reuse, link-media delivery bridge | Real Telegram multi-file/ambiguous-send/reconciliation in consenting chat |
| R06 continuation | implemented; verified_local | Typed NextStepDecision, persisted initial plan and verified progress deltas; two bounded semantic revisions, observed same-origin alternatives, safe step reuse, three read attempts and durable resumeAt | Whole-process/model recovery acceptance; no arbitrary provider/privilege/URL/acceptance changes |
| R07 expression | implemented; verified_local guards | Shared policy, real-receipt promises, social floor, serious-tone updates | Human before/after naturalness/persona evaluation |
| R08 memory | implemented; verified_local | Six-kind scoped memory/project references, natural export/correct/forget, provenance/CAS, tombstones and legacy adapters | Real ingress/mining/restart privacy rehearsal |
| R09 resources | implemented; verified_local | Interactive reserve, cross-process locks, pressure gates, RSS/CPU/file/output bounds; retained Firefox guards | Sustained mixed-workload soak; watchdog is not instantaneous kernel memory containment |
| R10 families | implemented for documented scope; verified_local available paths | Research/audit/documents/data/community/media; commit-pinned public GitHub review/apply-checked patch and configured local code worker; isolated renderer/OCR readiness | blocked_external: missing Tesseract/Chromium/live proof; public review does not execute remote repository tests |
| R11 connections | implemented with real Telegram bot adapter; verified_local contracts | Immutable owner, credential references, exact delegated read/draft/send, receipt/revocation | blocked_external: consented actual Telegram send rehearsal; no personal-account/email/calendar integration claimed |
| R12 routines | implemented; verified_local | Reminders/monitors/fresh digests, DST/quiet/budgets/expiry, observed/notified state, durable legacy tick adapter | Real downtime/restart/notification/revocation rehearsal |
| R13 learning | implemented for verified research recipes; verified_local lifecycle/Forge tests | Revision-bound semantic descriptors, disable/retire, fixed handler, proposal/install distinction | Held-out real-model reuse; arbitrary executable workflows are not auto-installed |
| R14 release | in_progress; final local gates verified_local | Acceptance mapping, 144-variant inventory, 140-file/1,420-test suite, typecheck/lint/format/isolated build, real Mongo26 and staged runbook | Real-model/human corpus, whole-process/transport rehearsal, soak and production activation |

## Evidence already obtained

- Checkpoint `8ec700c`: 170 targeted tests, global typecheck/lint/format, isolated build and real local
  Unicode PDF/DOCX conversion. This historical count is not the final revision-wide test count.
- Current workflow/research/document area: 41 distinct targeted tests passed, typecheck and scoped
  lint. Other package regressions are mapped in the handoff.
- Final global local gate: **140 files / 1,420 tests passed**, 42.37 seconds, starting 2026-09-19
  14:53:21 UTC; typecheck, ESLint, formatting and diff checks passed. Final isolated build passed at
  `/tmp/goonerbot-companion-final-build-WsovhL`, live `dist/` untouched. This supersedes the earlier
  139-file/1,411-test and intermediate targeted runs. See [COMPANION_LOCAL_VERIFICATION.md](COMPANION_LOCAL_VERIFICATION.md).
- Extended isolated real Mongo: **26 check groups passed**, zero external effects, production
  untouched. This supersedes the initial 14-group result and covers ingress migration/dedup,
  competing claims, checkpoints, receipt reuse, stale-owner/scope rejection, uncertain effects,
  memory CAS/erasure and topic-aware legacy index migration. Two added checks prove durable retry
  due-time gating across worker replacement and due recovery with preserved attempts/checkpoints/fence.
- `scripts/verify-companion-isolated.ts` launches an already-installed Mongo binary with private
  temporary dbpath/port, runs checks, stops it and removes only its own directory.
- `companionCorpusIntegrity` validates 24 families × 6 variants and negative-case inventory.
  **It does not invoke a model or measure semantic accuracy/naturalness.**

## Gates that must remain visible

1. Real Telegram delivery/uncertain outcomes need an authorized test destination. Mocked API calls
   and Mongo receipts are not live-send evidence.
2. OCR/renderer remain disabled until binaries, language data and namespace isolation are ready.
   The persistent X/Firefox account session is not a substitute for the isolated renderer.
3. Whole-process recovery, prolonged resource soak, real-model N01–N24 and human style evaluation
   are not replaced by unit tests or fixture strings.
4. Final local gates cover the delivered working tree. R14 and Definition-of-Done item 17 remain
   open because of the separate live/model/human/soak obligations, not a missing local suite/build.
5. No deployment, production migration or external effect is implied by development handoff.
6. R06 now includes typed decisions, verified progress, observed-source alternatives and durable
   backoff. The policy remains bounded to compatible reads and at most two semantic revisions;
   arbitrary provider/privilege changes are not advertised. Final integrated local gates passed;
   separate live/model acceptance must not be inferred from them.
