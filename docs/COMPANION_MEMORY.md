# Companion memory and legacy-worker controls

The natural `memory` capability calls `Storage.companionMemory.execute`; the host supplies actor,
chat/topic, original message timestamp and stable update identity. Arguments cannot select another
owner or destination. `recallContext` uses the same boundary as explicit recall. DM records are
never automatically shared with groups, and forum-topic records never become main-chat records.

## Persistent memory

- Mongo `companion_memories`: one CAS-versioned aggregate per immutable Telegram user ID. No replica
  set is required. At most 300 records of 3,000 characters, 2,000 erasure hashes, and eight recall
  results/3,600 prompt characters. Concurrent writes retry at most eight times.
- Six categories: recent, social, personal/project, operational, external and procedural. Existing
  raw-history, social, task, source-cache and workflow services still own their original records;
  this is a scoped recall/annotation interface, not an unbounded duplicate of those collections.
- Records preserve message/task provenance, project/category, artifact IDs, timestamps and revision.
  Task-generated text cannot become a personal/social fact. Human declarations are declarations,
  not independent verification of their contents.
- `remember`, `list`, `recall`, `correct`, `export` (JSON), and `forget` work through the executable
  catalog. Ambiguous correction/deletion asks which record. Corrections keep the memory ID and
  increment its revision; deleted prose is not retained in a revision log.
- Username aliases come only from observed Telegram-ID mappings. Legacy lore is exposed only for
  the actor's verified aliases and compatible retained human evidence/topic. Unknown legacy topic
  provenance is never guessed. This conservative policy can omit old records instead of leaking them.

## Erasure and retention

Deletion leaves hashes and source fences, not erased text. Owner erasure retains an ID/timestamp
fence, so replay using the original source timestamp cannot restore erased content. A genuinely new
explicit user declaration remains possible after renewed authorization. Never substitute retry time
for the original source timestamp.

`memory_erasure_tombstones` additionally prevents legacy lore import, mining and social evolution
from rebuilding forgotten evidence or erased identities. It has no TTL: expiring it would permit old
backups to resurrect deleted data. Legacy automatic profiling of a fully erased identity stays
disabled; new explicit companion records remain separately authorized. Restoring backups must retain
the latest erasure ledger; the application cannot rewrite offline backups.

Terms erasure resolves historical aliases before removing source messages, fences producers, removes
personal memory and social data, and clears derived debug/reply/thread/entity snapshots in affected
chats. These derived snapshots can contain quotes; clearing the affected chat's snapshot is safer
than assuming only the final recipient was mentioned. The existing task/artifact revocation hook
remains responsible for work and generated files. No Telegram messages are deleted by this cleanup.

Raw messages retain both immutable sender ID and `telegramTopicId`, separately from semantic threads.
Legacy lore deduplication and the active unique index also include the Telegram topic. Mining writes
a `memory_retention_gap` job record when its checkpoint predates retained human history; that means a
possible missing prefix, not a fabricated count of lost messages.

## Existing workers remain the only effect owners

`ExistingVisibleWorkReader.control` resolves natural status/pause/cancel/resume against actor/chat/topic
and actual archive receipts. It calls the existing archive or local-development service; it never
creates a shadow worker or replays a whole Telegram update. Archive mutation uses scope and
`updatedAt` CAS. Pausing preserves completed receipts and quarantines interrupted uncertain delivery.

Archive episode corrections can select an episode already in the provider-verified stored snapshot.
Completed receipts and bounded selection history remain intact. An unknown episode or uncertain send
keeps the job stopped and asks for the source needed to proceed. Local-development proposals support
status, cancellation and the existing interrupted-verification recovery; changing or replaying a
patch already being verified/applied is deliberately not inferred from a conversational correction.

A tone-only change is distinct: `patchPresentation` updates only `payload.presentation.socialSignal`
and a bounded event, without changing task ownership, version, fence, goal, checkpoints or effects.
The runtime reads this presentation override when composing the result; no tool is rerun to remove a joke.

Verification: focused memory, privacy, legacy-control, migration, task and host-bridge tests; mocked
concurrency/erasure boundaries are not a claim of production deployment or Telegram delivery.
