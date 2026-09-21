# Companion branch: live trial, 19 September 2026

The owner explicitly authorized live testing in **Gooners Esodati Cerbero Podcast**, Telegram
supergroup `-1002837751448` (the supplied `2837751448` was resolved with `getChat`). No merge into
`main` was made. The existing bot identity, approved chats, permissions and `.env` were retained.
The service is live for its existing approved chats; this is not a separate staging bot.
Operator-generated test messages are restricted to the chosen group.

**Currently active code: `cd491cb`**, started **15:38:24 UTC**, release: `/home/funboy/.local/share/goonerbot/releases/cd491cb-live-DBC6Gr`.
The systemd user override `90-companion-live.conf` selects this immutable release with `COMPANION_TASKS_ENABLED=true`
and concurrency 1. Live status: active (running).
SearXNG local search endpoint at `http://127.0.0.1:8888` has been verified operational with live results and grounding (`smoke-search.ts`).

## Activation and recovery material

- Branch: `companion-rework/phase-1-ingress`; main remains `c1807d0`.
- Initial tested revision: `0c5d880`; original process stopped cleanly at **15:07:01 UTC**.
- Initial branch process started **15:07:16 UTC**, durable polling ready **15:07:18 UTC**.
- Immutable release: `/home/funboy/.local/share/goonerbot/releases/0c5d880-live-BtBPyh`.
  It contains archived source, compiled output and its own dependency copy. The original shared
  `/home/funboy/goonerbot/dist` was not rebuilt or overwritten.
- Service override: `/home/funboy/.config/systemd/user/goonerbot.service.d/90-companion-live.conf`.
  It selects the release's `dist/main.js`, enables companion tasks at concurrency **1**, and allows
  120 seconds for graceful shutdown. WorkingDirectory stays `/home/funboy/goonerbot` for existing
  configuration, assets and private persistent files.
- Private backup: `/home/funboy/.local/state/goonerbot/live-backup-20260919-hiiefQ`, mode 0700.
  Includes old dist, original unit/config, learned capabilities and local-development state.
  Credentials remain private and must never be copied into Git or support transcripts.
- Stopped-service Mongo backup: `mongo-NFbaLA` within that directory; 36 collections, raw BSON,
  collection options/index metadata, checksums and completion manifest. Manifest SHA256:
  `88f39d05036debb07dc248c1917819a4c4c211fffa7db0d9f85fbfd3330a7935`.
  `scripts/backup-live-mongo.ts` requires an empty private directory and a stopped bot, verifies
  stream framing/counts/hashes, and writes the manifest last. This is not a transactional snapshot
  against unrelated database writers or TTL expiry, and restoration has not been rehearsed.
- The X/Firefox service was already failed and was **not restarted**. No new account-browser
  session was created. The initial bot process used about 144 MiB of service-accounted memory,
  with zero restarts and no swap pressure during the short observation window; this is not a soak.

## What the actual group tests established

| Test | Observed result | Interpretation |
| --- | --- | --- |
| Configured primary model | Actual small request succeeded; Cortex selected `document_create` for natural PDF request | Live model connectivity and one routing example, not broad semantic acceptance |
| PDF, user message 192729 | Durable task, acknowledgement and text/file receipts 192732/192733; reopening the delivered artifact showed only `[]` | Transport succeeded, **content acceptance failed**; do not count as a good PDF |
| Feedback about PDF | Bot promised to remake it without creating a task | False promise; no retry actually started |
| Passive quality audit | Requested page plus 4 public linked sources read successfully; generic auto-injected search failed and contaminated overall task status | Actual audit acquisition succeeded, orchestration/presentation failed |
| Conversation during work | A greeting was answered while the audit was in progress | Conversational lane remained available; latency was still model-dependent |
| Search / learned recipe | Local SearXNG responded HTTP 200, but upstream engines returned CAPTCHA/rate limits and no usable results | External search degradation, not a demonstrated bot/network timeout or exhausted user quota |
| Followed anime request | Generic schedule recipe chosen instead of chat subscription reader | Routing correction required; general airing lists do not establish chat follows |

First trial produced one task marked completed and four marked failed. The completed task was the
invalid PDF above: stored completion is not independent semantic proof. Existing receipts and
failed-task evidence are preserved; they must not be rewritten to make the trial look successful.

## Corrections from the trial

- Reject empty prose placeholders, allow only one regeneration, reopen converted PDF/DOCX and
  verify normalized word coverage before treating the artifact as usable. The composer receives
  the actual verified content. PDF requires installed Poppler `pdftotext`; JSON/CSV keep their
  legitimate structured-data semantics.
- Respect catalog-declared evidence readers when grounding is already selected. Do not inject a
  redundant web search over a page audit or installed research reader. Explicit complementary
  searches remain; social context or write operations alone do not satisfy factual grounding.
- Keep raw audit evidence for the model, but supply a concise factual fallback instead of a source
  dump. Header deficiencies are indicators, not proof of exploitable vulnerabilities.
- Ordinary conversation receives explicit host state when no new work was started; a conservative
  expression-only guard removes unsupported regeneration/redelivery promises. It never dispatches
  tools. Serious feedback calls for accountability, not blaming the user or their URL.
- Follow questions select the actual chat subscription reader. Last-notification state must not be
  described as a fresh release check. The generic schedule recipe cannot know private chat follows.
- Private runtime artifacts are ignored by Git. No test documents or credentials are committed.
- Empty SearXNG responses now log aggregated upstream failure categories without query text,
  URLs or raw engine errors. A missing result no longer invents an exhausted quota as its cause.

Corrective code checkpoint `787a880` passed **147 targeted tests across 10 files**, global typecheck,
scoped lint/format and an isolated release build. Native PDF/DOCX conversion and reopening passed
with known content. It was activated at **15:26:45 UTC**, after a clean stop with zero active tasks.
The stopped-service post-trial backup is `mongo-after-trial-TMD51g` in the private backup directory:
44 collections, manifest SHA256
`a4a0856162260b86d29a0acfc6a46e88cbc4fcccd70549ec4ba82543d0dd017b`.

A further isolated probe of the actual document handler with the configured model rejected both
generation attempts as placeholders: **no file was delivered**. This demonstrated the new guard,
but did not pass document creation. Two small comparison requests with simple content-writing
prompts returned full three-point checklists. The upstream service reported different Gemini
versions on those responses despite the configured model alias; no global model configuration was
changed. The document prompt was narrowed to preserve the original request, omit empty evidence
blocks and distinguish ordinary writing from source-backed reporting. Two added regression tests,
34 targeted document/runtime tests, typecheck, scoped lint and a new isolated build passed.

The actual handler probe on `6cb1d44` then **passed**: two model calls (one bounded retry), PDF
**27,342 bytes**, reopened text containing the three requested phases: pre-production, recording
and post-production/publication. It invoked the real configured model and native converter, but
**did not send to Telegram or create a database task**. This is not a repeated full-ingress delivery
pass. No active tasks or new chat messages existed during the final clean restart; old receipts
were preserved and the shared production `dist` checksum was unchanged.

## Rollback safeguards

The original unit and original shared dist are retained. Before returning to it:

1. Stop admission and let `systemctl --user stop goonerbot.service` drain/checkpoint current work.
   Inspect pending tasks and any ambiguous delivery receipts; do not replay uncertain sends.
2. Take a fresh stopped-service backup if there has been new user activity. Preserve new receipts,
   scope metadata and deletion tombstones. Do **not** blindly restore the pre-trial database.
3. Check legacy memory uniqueness before starting old code: startup migrated the memory index to
   topic-aware `memory_active_subject_topic_text_unique_v3`. Newly valid cross-topic rows may
   conflict with the old release's index. Resolve explicitly or keep the newer runtime; never drop
   records or indexes automatically to force rollback.
4. With that compatibility check satisfied, move only the trial drop-in to the private backup:

   ```sh
   mv -n /home/funboy/.config/systemd/user/goonerbot.service.d/90-companion-live.conf /home/funboy/.local/state/goonerbot/live-backup-20260919-hiiefQ/90-companion-live.conf.disabled
   systemctl --user daemon-reload
   systemctl --user start goonerbot.service
   systemctl --user show goonerbot.service -p ActiveState -p ExecStart -p MainPID -p NRestarts
   ```

   Confirm the drop-in actually moved (`mv -n` will not overwrite an existing backup). The
   original service will select the preserved shared `dist/main.js`. Verify logs and Bot API
   reachability. This procedure does not restore the database or disable unrelated services.

## Remaining acceptance

### First repeated end-to-end delivery

The owner's natural request **“creami un pdf con relazione e analisi di qualità del sito troie.vip”**,
message **192764**, produced task `7dc8fd70-c4dd-4a02-a8c2-74cfc71edb0d`. The compiled plan correctly
selected **page_scan → document_create**, with an evidence dependency and no generic web search.
Acknowledgement **192765**, final text **192768/192769**, PDF **192770**; all delivery receipts
confirmed, task completed at approximately **15:34:06 UTC**.

The actual stored/delivered PDF was reopened independently: **44,287 bytes**, **4 pages**,
**4,743 extracted characters**, source URL and quality/security sections present. Artifact ID
`030125e3-63ff-4875-8b3d-b053a1481615`; SHA256
`c5a3af4c0dcb86c01116f680c13180972efcbacb864df485c302890c05b03d45`.
This passes the repeated acquisition, non-empty generation and Telegram transport path.

**It does not pass full report-quality acceptance.** The model overstated missing CSP as proof of
XSS susceptibility, viewport as guaranteed responsive behavior, and heuristic scores as general
quality grades. The deterministic chat fallback also repeated an unnecessarily long document
excerpt; Markdown layout remained basic. An explicit factual correction was sent as reply
**192771** to the PDF, without editing or deleting the historical result. The final tightening
keeps verified text in composer data rather than the public fallback and explicitly constrains
source-backed audit conclusions; that prompt change still needs real-model/human acceptance.

The apparent 30-second document timeout in the stored plan was also examined: runtime validation
actually selected the host's longer timeout, allowing the 43-second generation to complete. Align
the persisted plan with the host default, while retaining explicit shorter deadlines, rather than
misdiagnosing the successful generation as a timeout.

### Open gates

Repeat semantic accuracy and naturalness acceptance after the final tightening; acquisition and
transport evidence above does not certify every statement in a generated document.
SearXNG local service was tested with `scripts/smoke-search.ts` and verified functional with live web search results and grounding.
No provider replacement, CAPTCHA bypass or extra credentials were introduced in this trial.
Whole-process crash/uncertain-send tests, media/rehost, model corpus, human style review and prolonged
resource soak are still open. Do not infer those passes from local tests or one clean restart.
