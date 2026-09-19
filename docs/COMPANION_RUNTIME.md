# Companion runtime: implementation and operation

Checkpoint: 2026-09-19, branch `companion-rework/phase-1-ingress`. This describes the integrated
runtime. The later [live branch trial](COMPANION_LIVE_TEST.md) identifies the actual deployed revision,
backup and rollback boundaries separately. See the
[package ledger](COMPANION_REWORK_STATUS.md) and [acceptance / handoff](COMPANION_HANDOFF.md).
Implementation, local verification and production verification are separate states.

## Natural conversation remains the control plane

Cortex and the alternate evaluator select executable operations from ordinary messages. Commands
remain shortcuts, not prerequisites. The shared catalog supplies descriptions, schemas, effects,
handler identity, limits and readiness. Typed OperationRequests preserve deliverables and bind actual
verified outputs to downstream actions. Informational providers and actions share the expression
policy; invalid/unavailable operations remain explicit rather than silently disappearing.

The context-sensitive personality stays intact. Progress requires real work receipts; tool failures
are not an excuse for invented refusal or fictional exhaustion. Gratitude, banter and quoted requests
do not automatically create jobs. A request for a serious tone changes presentation without changing
the goal, authorizing effects or restarting work. Pure delegated URL shares retain auto-rehosting;
URL-plus-prose and pending clarifications pass intent selection first, including no-download requests.

## Work ownership, continuation and delivery

Long-running work enters `companion_tasks` and releases the conversational lane. Natural status,
cancel, pause, resume and amend use immutable actor/chat/topic scope, reply correlation and versions.
Ambiguous references prompt a clarification. Missing inputs persist; an answer resumes that request.
Reports can be reopened from actual scoped artifacts, never from their completion captions.

Anime archive and local development retain their specialized execution owners. The shared control
adapter routes to those owners instead of cloning jobs. Archive narrowing preserves episode receipts
and refuses uncertain sends. Local code work supports only its worker's actual controls, not arbitrary
mid-verification mutation. Generic link-media work uses the companion delivery bridge; resolving a
provider URL is not itself proof of delivery to Telegram.

A generic task keeps contract, revision, budget, events, checkpoints and effect receipts in one Mongo
document. Owner/fence/version/live-lease checks protect new effects. Ordered artifacts are private,
scoped, hash-checked files, not buffers in Mongo. Every text/file delivery has a receipt. Unknown
generation/send outcomes are quarantined: this is not a claim of exactly-once Telegram delivery.

Successful reads survive downstream failure. A transient read gets one short local retry, then
persists its attempt count and next eligible time before releasing the lane as `retry_scheduled`.
The worker resumes automatically after `resumeAt`, including after restart, with at most three read
attempts total. Scheduling respects the remaining task budget/deadline and emits no false terminal
failure notice for a legitimate retry. A per-action timeout can retry only after the read handler
acknowledges cancellation; uncertain effects or lost authority never authorize another attempt.
Parallel peers are drained before retry releases the task lease. Bounded continuation
can revise failed search queries without adding effects or changing the requested object. Unchanged
public web/page/news/knowledge reads survive safe amendments; context-dependent work and effects
remain revision-scoped. This is selective reuse for known-safe reads, not an unrestricted semantic
invalidation engine. Composer failure never redispatches successful tools. Partial, blocked and
delivery-unknown outcomes remain distinguishable.

The initial plan is persisted before providers run. A typed `NextStepDecision` preserves the goal,
request feedback, satisfied/missing deliverable IDs, verified evidence/artifact references and actual
progress deltas. It distinguishes complete/revise/partial/blocked/budget/cancelled/access/uncertain.
At most two semantic revisions are allowed. A revision can improve a failed read query or select a
same-origin page URL actually observed in its dependency evidence; it cannot invent URLs, change
providers/privileges, drop deliverables, alter acceptance criteria or replay successful effects.
This bounded continuation is intentional, not unrestricted provider orchestration. Live/model
recovery checks remain separate acceptance gates. Progress means declared host acceptance passed,
not independent proof that every generated answer is semantically correct.

## Concrete capability boundaries

| Family | Implemented behavior | Boundary |
| --- | --- | --- |
| Research/comparison | Up to 3 query passes, 4 pages/pass and 12 claims; inspected-text hashes, dates, citations and numeric disagreements | Snippets stay unverified; source agreement is not independent proof; no invented prices/bookings |
| Public audit | HTML, up to 3 same-origin CSS/JS assets and 2 linked HTML pages under shared budgets | Passive observations, not server-source access, access-control bypass or confirmed exploits |
| Rendered pages | Offline snapshot plus up to 3 same-origin script/style assets; DOM and PNG | Opt-in temporary Chromium in network-isolated bubblewrap; no account browser or dynamic API traffic |
| Documents | PDF/DOCX/text extraction; Markdown/TXT/CSV/JSON and temporary-profile LibreOffice PDF/DOCX output | Generated PDF requires Poppler `pdftotext`; DOCX reopens through Mammoth; text coverage is checked before verification |
| OCR | Local opt-in image/PDF OCR with executable and language-data readiness checks | Input/page/time limits; recognition and coverage warnings; disabled by default |
| Data | Exact decimal CSV/flat-JSON aggregations, grouping, CSV and SVG export | No arbitrary eval; missing cells, rounding and truncation explicit |
| Code | Public GitHub source review pinned to a commit, with apply-checked patch; local proposal/status/diff/cancel through isolated worktree | Public review never runs repository code/tests; actual local checks require configured repository and authorized admin DM; patch/apply/deploy distinct |
| Media/anime | Existing acquisition/generation and ordered multiple artifacts | AnimeUnity/HentaiSaturn source identity and original-file policy preserved; no episode/trailer substitution |
| Memory/community | Scoped personal/project/operational memory and existing social/history providers | No cross-owner/topic disclosure or conversion of bot output into human biography |
| Connected service | Actual configured Telegram bot: metadata read, draft, send and receipt | Not a personal account; natural adapter covers current conversation/topic only |
| Learned recipes | Revision-bound installed research recipes, semantic reuse, disable/retire lifecycle | Proposals are not installed capabilities; recipes cannot gain privileges |

Up to five image actions fit a request, subject to quotas and budgets; heavy actions remain serial.
Public GitHub review reads bounded sources at a fixed commit and checks patch applicability without
running remote code. Actual repository execution/checks use only the configured local workspace.
Research/travel comparisons are informational work, not reservation or purchase automation.

Generated prose documents reject empty structural placeholders (`[]`, `{}`, `null`), with at most
one extra generation attempt before an explicit failure without an attachment. Valid JSON exports
may still contain those values; CSV retains its row-schema validation. PDF generation requires
`libreoffice` and `pdftotext` on PATH (Poppler); DOCX requires LibreOffice and the bundled Mammoth
reader, not `pdftotext`. Markdown/TXT/JSON/CSV need neither binary. Conversion uses a private temporary
profile with a 30-second bound; PDF text reopening has a 10-second bound, 1 MiB output cap and 256 MiB
process-tree RSS budget. The document action has a 180-second default deadline, including bounded
generation recovery, and remains subject to the overall task deadline and cancellation.

Before a converted PDF/DOCX is marked verified, its reopened text must retain at least 98% of the
input's normalized word occurrences. DOCX line breaks are preserved during inert HTML extraction;
Unicode ligatures and converter-inserted line hyphenation are normalized. Missing readers, unreadable
or materially incomplete output fail closed. This is an output-integrity check, not independent
verification of generated factual claims. The final answer receives an excerpt of the actual
verified document content instead of only a filename.

## Persistent routines

The `workflow` capability creates/lists/updates/cancels reminders, content-change monitors and
scheduled source digests. Owner/destination come from the host. Weekly schedules preserve local time
across DST; downtime coalesces missed slots instead of sending bursts. Baseline, last-observed and
last-notified hashes are distinct. Quiet hours, daily notifications, total checks/deliveries and
expiration are persisted. Default monitors check every 30 minutes, expire after 30 days and seed
silently. Reports contain freshly read bounded source snapshots, not arbitrary scheduled reasoning.

Read leases can safely recover; sends begin only after durable intent. Uncertain sends are never
blindly replayed. Five consecutive read failures visibly pause the workflow for correction. Current
terms/access are rechecked before delivery. The durable tick coordinator wraps existing follow and
autopost scheduling while retaining original opt-ins, identities, quotas and delivery ownership.

## Privacy, delegations and resources

Memory uses owner/chat/topic scope, project/category references, attributable provenance, CAS and
natural export/correct/forget. Hash-only erasure tombstones guard old inbox/mining/backfill sources.
Legacy adapters and an idempotent topic-aware index migration preserve existing rows. Terms revocation
fences tasks, cancels routines, revokes connections and removes owned artifacts. Tombstones and
pending effect receipts must survive rollback or restore.

Connections contain credential references, never tokens. Delegations require exact owner,
operation/resource/recipient and have expiry/revocation. Explicit one-shot Telegram requests authorize
only the current operation/destination briefly; reusable consent needs a separate delegation request.
No live connector message was sent during implementation.

| Limit / setting | Default |
| --- | --- |
| `COMPANION_TASKS_ENABLED` / concurrency | `true` / `2` (1–4) |
| `COMPANION_ARTIFACTS_PATH` | `data/companion-artifacts` |
| Generic admission / task budget | 100 queued per process; 15 minutes, 3 claims, 2 amendments |
| Artifacts | 1 GiB total; 100 MiB/file; 2,000 files; 512 MiB disk reserve; 7 days |
| Terminal task/reminder retention | 30 days |
| Local admission | 8 slots; 2 interactive reserve; bounded fair queue |
| Same-UID Linux heavy lanes | `flock`: media 2, browser 1, generation 2, mining 1, subprocess 2 |
| Host pressure | Available memory, PSI stalls and disk reserve gate heavy admission |
| Child processes | RSS group watchdog, wall/output bounds, inherited CPU/file `prlimit`, parent-death signal where available |
| OCR | `DOCUMENT_OCR_ENABLED=false`; `DOCUMENT_TESSERACT_COMMAND`, `DOCUMENT_PDFTOPPM_COMMAND`, `DOCUMENT_OCR_LANGUAGE=eng` |
| Renderer | `COMPANION_RENDER_ENABLED=false`; `COMPANION_CHROMIUM_COMMAND`, `COMPANION_SANDBOX_COMMAND` |

These controls cover participating workers, not unrelated host programs. RSS is a watchdog, not an
instantaneous kernel cap. Firefox autoplay blocking, real Snap/process-tree monitoring, orphan cleanup
and recycling remain. A service-only `MemoryMax` does not contain an independently scoped Snap browser.
No sysctl, systemd, browser-profile or production-service change was applied.

## Verification and activation

Use the handoff for test mappings and exact evidence. Unit/contract tests, real isolated Mongo checks,
local document conversion and live Telegram/model tests are distinct. The 144 conversational variants
are an inventory, not 144 model executions or a human naturalness assessment.

The final local run passed global typecheck/lint/format/diff checks and **1,420 tests in 140 files**
(42.37 seconds; suite started 2026-09-19 14:53:21 UTC). The isolated build passed in
`/tmp/goonerbot-companion-final-build-WsovhL`; live `dist/` was unchanged. Real isolated Mongo
passed 26 check groups, including memory CAS/erasure, index migration and due-time retry recovery.
Optional reader readiness
is connected to the actual per-turn snapshot; absent OCR/renderer binaries remain explicit.

No production restart/deployment occurred. Never overwrite shared production `dist/` for validation.
`COMPANION_TASKS_ENABLED=false` disables generic background workers, not all legacy schedulers, and
does not undo indexes, deliveries or delegations. Preserve receipts, tombstones and artifacts during
the staged activation/rollback procedure in [COMPANION_HANDOFF.md](COMPANION_HANDOFF.md).
