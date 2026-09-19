# Companion rework handoff and acceptance matrix

Date: 2026-09-19. Branch: `companion-rework/phase-1-ingress`. Previous integrated checkpoint:
`8ec700c`; completion changes are identified by the final handoff commit. Read with
[runtime](COMPANION_RUNTIME.md), [R00–R14 status](COMPANION_REWORK_STATUS.md), and
`/home/funboy/GOONERSBOT_COMPANION_REWORK_PLAN.md`.

This is a development-code handoff with local evidence, **not a claim that all mandatory live,
model/human acceptance or production rollout gates have passed**. No production service was restarted.

## Final local evidence

- Global typecheck, ESLint, formatting and `git diff --check` passed.
- Final serial repository suite: **140 files / 1,420 tests passed**, 42.37 seconds; started
  2026-09-19 14:53:21 UTC. Includes completed R06 decision/progress/backoff regressions.
- Real isolated Mongo verification: **26 check groups passed**, zero external effects and no
  production database access. This supersedes the earlier 14-group result; added checks cover memory
  CAS, actor/topic isolation, erasure replay prevention and idempotent topic-aware index migration.
  Two final additions verify no claim before scheduled retry time and due-time recovery by a new
  worker with preserved attempts/checkpoints and a new fence.
- The isolated Mongo wrapper starts an existing binary on a temporary private port/dbpath, then
  shuts it down and removes only its own test database/directory.
- Local Unicode PDF/DOCX conversion was verified at the earlier checkpoint. OCR and renderer
  readiness/fail-closed behavior is tested; actual Tesseract/Chromium execution is not verified because
  those binaries are absent. Their availability is reflected in per-turn runtime readiness.
- Final isolated TypeScript build passed in `/tmp/goonerbot-companion-final-build-WsovhL`; live `dist/` was not
  touched. See [COMPANION_LOCAL_VERIFICATION.md](COMPANION_LOCAL_VERIFICATION.md) for the execution record.
- The final suite supersedes the earlier 139-file/1,411-test run and intermediate targeted runs.
  It covers durable retry time/attempts, acknowledged read-timeout cancellation, draining peers before
  release, authority/deadline/budget rejection and safe read-cache reuse across amendments.

## Definition of Done: all 17 obligations

`Local` means the named automated/component check, not full real-model or production proof.

| # | Obligation | Implemented evidence | Remaining acceptance |
| --- | --- | --- | --- |
| 1 | One executable capability catalog | Catalog/natural-routing/dispatch tests; real reader readiness | Real-model readiness and paraphrase selection |
| 2 | Natural/command contracts agree | TurnContext, dispatch, worker and specialized control adapters | Complete command/natural transcript parity |
| 3 | Work survives turns/restarts | Task/step tests and real-Mongo checkpoints/fences | Whole-bot process crash rehearsal |
| 4 | Clarify, delegate, revise, stop | Work/integration/progress tests; bounded failed-query revision | Real-model recovery and consent dialogue |
| 5 | Deliver all artifacts or report incomplete | Artifact store, ordered delivery and effect receipts | Real Telegram multi-file and ambiguous-send reconciliation |
| 6 | Scoped erasable social/project memory | Memory/privacy/social tests; real-Mongo tombstones and CAS | Actual ingress/mining/restore privacy rehearsal |
| 7 | Reliable revocable routines | Reminder/monitor/DST/quiet/consent regressions | Live downtime, removed-bot and notification tests |
| 8 | Extensible integrations | Adapter/delegation interfaces and configured Telegram connector | Consented actual read/draft/send proof |
| 9 | Host resources governed | Resource governor/host budget/process tests; retained Firefox guards | Sustained mixed-workload measurements |
| 10 | Regressions for reported failures | Dispatch/no-rehost, archive identity/control, progress/delivery and attribution tests | Complete real-model end-to-end incident transcripts |
| 11 | Contextual persona without abandoning work | Expression/social floor and presentation-only updates | Human before/after persona evaluation |
| 12 | Docs/runtime/rollout agree | Runtime/ledger/runbook and explicit limits | Actual activation/recovery record |
| 13 | Natural public controls | Catalog-derived schemas, semantic recipes and legacy adapters | Held-out real-model coverage |
| 14 | Shared expression for providers/actions | Observation/result contracts and composer/reply guards | Human banter/micro-turn assessment |
| 15 | Goal/budget/progress survive failure | Persisted initial plan, typed decisions, verified progress deltas, scheduled backoff and two safe semantic revisions; final local suite passed | Whole-process/model semantic recovery remains to prove |
| 16 | Control/chat continue during work | Separate worker lane, responsive controls, stale-result fences | Measured suspended-provider end-to-end latency |
| 17 | R00–R14 proved on delivered revision | Final local gates and this explicit acceptance ledger | **Open**: required live/model/human/soak gates are not yet satisfied |

## N01–N24: actual test mappings

Names below are `tests/<name>.test.ts`. Every family also has six held-out variants in
`tests/fixtures/companion-conversation-variants.json` (144 total). `companionCorpusIntegrity` checks
only inventory and negative cases: **it does not call a model or establish semantic accuracy**.
All rows still require their real-model conversation; extra gaps are explicit.

| Family | Existing local evidence | Not established by those tests |
| --- | --- | --- |
| N01 HTML/JS audit | `pageScannerAudit`, `linkMediaRouting`, `companionDispatch` | Full natural request→delivered audit transcript |
| N02 search then read | `companionDispatch` actual dependency binding with controlled providers | Live source/model choice and judgment |
| N03 episode reply/rehost | `animeArchiveWorker`, `animeArchiveService`, `agentRuntime` | Requested episode actually delivered on Telegram |
| N04 no download | `companionTurnContext`, `linkMediaRouting`, `runtimeCapabilityNatural` | Held-out multilingual negation with real Cortex |
| N05 narrow to episode 7 | `companionLegacyControls`, archive storage/control tests | Live in-flight narrowing and user-visible residual state |
| N06 status/cancel while blocked | `companionWork`, `companionTasks`, `companionIngressProcessor` | End-to-end latency target during suspended provider |
| N07 three-product comparison + PDF | `companionResearch`, `companionDocuments`, `documents`, deliverable planner tests | Full three-product grounding/file transcript; no booking/purchase implied |
| N08 report→translation→TTS | `companionDispatch`, `agentRuntime`, `agentOrchestrator` | Real voice provider and Telegram delivery |
| N09 reject trailer, find episode | Archive identity guards, `companionProgress` strategy tests | Full wrong-result conversation; query revision is not universal provider recovery |
| N10 angry hurry request | `companionTurnContext`, `companionExpression`, durable goal contracts | Human-rated appropriate tone without abandonment |
| N11 thanks during job | `agentRuntime` gratitude floor, `companionWork` presentation/control | Real-model turn-taking with an active worker |
| N12 quoted request not authority | `companionTurnContext`, `cortex`, addressing/social tests | Held-out indirect addressing and negative cases |
| N13 503/retry/restart | `companionTaskSteps`, `companionProgress`, real Mongo recovery | Whole process restart with pending provider and transport |
| N14 follow/restart/notify/revoke | `animeFollows`, `scheduler`, reminder/monitor tests | Actual release event and Telegram notice/revocation |
| N15 inspect available tools | `runtimeCapabilityCatalog`, `runtimeCapabilityNatural`, reader readiness | Real-model precise limitation without invented refusal |
| N16 new recipe/paraphrase | `capabilityForge`, `capabilityLifecycle`, natural catalog tests | Actual held-out semantic generalization |
| N17 effect succeeds/composer fails | `companionDispatch`, step/effect receipt replay tests | Real composer failure after external acceptance |
| N18 ambiguous task | `companionWorkflowDispatch`, `companionWork`, scoped controls | Complete two-job natural clarification transcript |
| N19 serious tone mid-work | `companionWork`, `companionTasks` presentation-only changes | Human judgment of final tone |
| N20 three originals/two variants | Distinct multi-artifact/replay and `agentRuntime` image/dependency tests | Five-artifact real-provider derivation and delivery |
| N21 CSV/chart | `dataAnalysis`, `companionDocuments` deterministic numbers/artifacts | Natural ambiguous-column clarification and delivered chart |
| N22 repository patch | `companionRepositoryReview`, `localDevelopmentWorkspace`, local job/service tests | Public GitHub review is commit-pinned/read-only with apply-check; no remote repository tests run. Actual local checks require configured repo/admin DM |
| N23 private memory/forget | `companionMemory`, `termsPrivacy`, `socialIntegrity`, Mongo erasure checks | DM→group→forget→restart/backfill with actual model |
| N24 social/serious turns | `companionExpression`, `agentRuntime`, reply/social tests | Human naturalness, unwanted-tool rate and timing evaluation |

## Safe activation runbook

1. Pin the final commit and inspect effective service paths without exposing credentials. The
   historical `goonerbot.service` loads `/home/funboy/goonerbot/dist/main.js`; this shared directory
   must not be a verification output target.
2. Reproduce gates on the pinned revision if needed; the isolated build is not a complete runnable
   release package:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm format:check
   pnpm exec vitest run --no-file-parallelism
   companion_build_dir=$(mktemp -d /tmp/goonerbot-companion-build.XXXXXX)
   pnpm exec tsc -p tsconfig.json --outDir "$companion_build_dir"
   pnpm exec tsx scripts/verify-companion-isolated.ts
   ```

3. Before production bootstrap, take a recoverable private backup of the exact production Mongo
   database/indexes, artifact directory, installed recipes, development-job store and service/config.
   Record targets and restore procedure; do not put tokens in git/logs. Retain tombstones and pending
   effect receipts, which are required to prevent resurrection or duplicate effects.
4. Build an immutable versioned release outside the live checkout with pinned source, dependencies,
   package metadata and its own `dist/`. Keep private configuration and shared data paths explicit.
   Switch the service only during the planned activation; do not rebuild shared `dist/` in place.
5. Review isolated migration evidence: bot-scoped ingress indexes; task/reminder/integration/tick
   indexes; topic-aware active legacy-memory uniqueness. Idempotent index changes are still production
   changes. Preserve rows and keep one execution owner per specialized job.
6. Start with a consenting test destination and generic workers disabled if appropriate.
   `COMPANION_TASKS_ENABLED=false` is **not** a global switch for every legacy follow/autopost path;
   keep undesired autonomous schedules disabled separately. OCR/render remain off until their binary,
   language and namespace checks pass. Respect local repository/admin-DM scope for code execution.
7. Drain/checkpoint work, stop the old process and activate one new long-poll consumer for this token.
   Check startup/index logs, inbox lag, leases, receipts and actual process-tree memory. Never run two
   uncoordinated pollers for the same bot token.
8. Enable progressively. Verify natural controls during a slow task, multi-file delivery, routine
   revocation, scoped connector read/draft/send and terms erasure in the authorized test chat. Rehearse
   uncertain transport without repeating writes. Run model/human evaluation and measured mixed-load
   soak before broadening traffic. Record deployed commit, UTC activation and observed health.

## Rollback and unresolved external gates

Rollback means stopping admissions/draining or fencing workers and switching to the prior immutable
release, not deleting jobs. Keep confirmed/uncertain receipts, artifacts and privacy tombstones.
Check old-code/index compatibility across the topic-aware memory migration before switching back.
A full database restore is a separate reviewed recovery operation: old data can resurrect forgotten
content or repeat effects. Disabling workers does not undo messages already sent.

Outstanding proofs need an explicitly consenting Telegram test destination; installed Tesseract with
language data and Chromium with working bubblewrap namespaces for optional live reader acceptance;
a controlled real-model N01–N24 run and human naturalness assessment; and a whole-process recovery /
resource-soak window. No existing account/browser session substitutes for the isolated renderer.
Until the mandatory acceptance gates are resolved, full-plan Definition-of-Done completion remains
open even though the integrated local implementation and suite have been delivered.

R06 now includes durable scheduled backoff plus the integrated typed decision/progress evaluator.
The initial plan is persisted before provider calls; decisions retain goal/feedback, deliverable IDs
and verified evidence/artifact progress. Two semantic revisions may change a failed read query or a
same-origin URL actually observed in dependency evidence. Identity, required results, acceptance,
effects, providers and privileges cannot be expanded by revision. This is bounded useful recovery,
not an unrestricted provider-switching engine; real-model/live acceptance remains separately open.
