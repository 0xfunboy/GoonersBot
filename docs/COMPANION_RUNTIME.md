# Companion runtime: implementation and operation

Implementation checkpoint: 2026-09-19. This describes the runtime delivered on the current
development branch. The package-by-package ledger remains `COMPANION_REWORK_STATUS.md`; the full
rework plan is not represented as completely finished.

## Natural conversation and work

Cortex and the alternate evaluator still select capabilities from ordinary messages. Commands are
optional. Their proposals compile into versioned OperationRequests; dependencies bind real verified
outputs to inputs. The ordinary memory/news/catalog providers also produce ObservationBundles.
Unavailable, invalid or over-budget requests remain explicitly unmet.

Pure delegated URL shares retain auto-rehosting. Text accompanying a URL goes through semantic
intent selection first, including audit questions and explicit no-download instructions. A pending
clarification also prevents a bare answer URL from being consumed by the rehost interceptor.

Approved long-running operations enter `companion_tasks`, then release the conversational lane.
The acknowledgment references an actual durable task. Natural status, cancel, pause, resume and
amend operations use immutable actor/chat/topic scope plus expected version. Exact Telegram replies
identify work before conversational fallback; ambiguous matches prompt for the intended request.
Short gratitude does not create a fresh document task merely because it replies to a report.

Requests for missing inputs persist as waiting tasks. A semantic clarification answer resumes that
request. Completed reports can be reopened from scoped artifact references for subsequent reading,
translation and speech. A completion caption is never treated as the report's actual contents.

Anime archive, generic link-media transport and Forge retain their existing execution ownership.
They are not silently taken over by the generic worker. Their broad control/ownership migration is
still an explicit release item in the ledger.

## Execution and delivery

Tasks use a single Mongo document for the contract, revision, bounded events, checkpoints and effect
intents/receipts. This avoids requiring replica-set transactions. Claims require owner, fence,
revision and live lease. Every new side effect rechecks authority; stale results cannot start a new
delivery after cancellation or amendment.

Read/compute success is checkpointed. A clearly transient read failure can retry once, with the
attempt counter persisted. Generation and write operations have intent/receipt records and reuse
confirmed outputs after interruption. A provider or composer failure does not dispatch the legacy
handler again. The final completed result has its own checkpoint; a partial result may continue
from successful steps on a later resume.

Artifacts are ordered references, not singleton buffers in Mongo. Every text chunk and file delivery
has its own effect receipt. Unknown delivery or generation effects are quarantined rather than
blindly repeated. This is deliberately not a claim of end-to-end exactly-once Telegram delivery.
The user receives a short failure notice when authority and transport still allow it.

Amendment currently invalidates the accepted revision conservatively. Selective reuse across
changed revisions and semantic strategy changes after an irrelevant result need further work.

## Concrete capabilities added

- Public-page audit: main HTML, up to three same-origin CSS/JS assets and two linked HTML pages,
  bounded by one time/byte budget. The report includes URLs, hashes, excerpts, omissions and
  timestamp. Static patterns are observations, not proof of a vulnerability. No JavaScript is run.
- Documents: Markdown, text, CSV and JSON directly; PDF and DOCX through a separate temporary
  LibreOffice profile with bounded subprocess execution. Real Unicode PDF/DOCX generation was
  verified locally. LibreOffice must remain installed for those two formats.
- Data: bounded CSV/flat JSON parsing, exact decimal sum/min/max, explicitly rounded means,
  grouping, missing/invalid counts, canonical CSV and static SVG charts. No arbitrary code/eval.
- Reminders: create/list/edit/cancel and recurring messages through the `workflow` capability.
  Host scope determines the owner and destination. Absolute schedules require a timezone; relative
  delays use elapsed time. Weekly schedules handle DST. Downtime coalesces missed recurring slots;
  an uncertain send is not repeated. These are scheduled messages, not dynamic report-generation
  or page-change monitors.
- Multiple generated files: all verified images/documents/audio survive collection and delivery.
  Up to five image actions fit a request, subject to existing group quotas and time budgets. Heavy
  actions inside a request execute serially to contain resource use.

## Limits and privacy

Defaults:

| Setting | Default |
| --- | --- |
| `COMPANION_TASKS_ENABLED` | `true` |
| `COMPANION_TASK_CONCURRENCY` | `2` (1–4 allowed) |
| `COMPANION_ARTIFACTS_PATH` | `data/companion-artifacts` |
| Active generic queue | 100 tasks per process admission lane |
| Artifact storage | 1 GiB total, 100 MiB/file, 2,000 files, 512 MiB disk reserve |
| Artifact retention | 7 days |
| Terminal task/reminder retention | 30 days |
| Generic task budget | 15 minutes execution, 3 claims, 2 amendments |
| Resource admission | 8 total slots, 2 reserved for interactive work, bounded queue |
| Subprocesses | 2 simultaneously; bounded stdout/stderr/total output |

Artifact files have private permissions, immutable owner/scope, hash, size and expiration checks.
Terms revocation fences/redacts tasks, cancels/removes reminder text and removes the owner's files,
including orphaned files without a successful DB receipt. Existing broader memory deletion remains
in place. Full project memory and deletion tombstones for every legacy derived store are not yet
implemented by this package.

The governor is process-local admission control, not an OS memory limit. Existing Firefox autoplay
blocking, real process-tree/Snap watchdog, orphan cleanup and recycling are preserved. No sysctl,
systemd, browser-profile or production-service change was applied during this implementation.

## Validation and activation

The affected conversation, dispatch, task, delivery, privacy, resource and audit paths passed
166 targeted tests in 24 files; the data kernel separately passed four tests. Whole-project
typechecking and ESLint passed. PDF/DOCX were additionally generated using the installed converter.
The verification build uses an isolated temporary output directory, not production `dist/`.

No production restart or deployment was performed. On an intentional activation, bootstrap creates
indexes for `companion_tasks` and `companion_reminders` without rewriting existing legacy stores.
Setting `COMPANION_TASKS_ENABLED=false` disables the new background workers; existing durable task
data remains available for a later controlled resume. Do not delete pending-effect records to make
a job retry: that discards the evidence needed to avoid duplicate effects.

Before calling the entire plan verified, complete the real-Mongo crash/recovery and real-Telegram
ambiguous-send rehearsal, the real-model conversation corpus, legacy owner cutover, broader memory
and integration work, and the sustained resource test recorded in the package ledger.
