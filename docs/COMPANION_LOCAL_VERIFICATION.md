# Local verification evidence — 2026-09-19

These results cover the rework working tree before the delivery commit. They do not assert
production activation, real Telegram delivery or full conversational-model acceptance.

## Repository delivery gates

- Global `pnpm typecheck` and `pnpm lint`: passed.
- Full serial suite: **140 files / 1,420 tests passed** in 42.37 seconds; started
  2026-09-19 14:53:21 UTC. This final run includes the completed R06 continuation/backoff tests.
- Isolated TypeScript emission: passed in `/tmp/goonerbot-companion-final-build-WsovhL`;
  the production-shared `dist/` directory was not changed.
- `pnpm format:check` and `git diff --check`: passed.
- The final suite includes reuse of an unchanged public read across task amendments and invalidation
  when the query changes. It supersedes the earlier 139-file/1,411-test run and intermediate targeted
  checks; those historical counts must not be added to this final total.

These are repository-local checks, not a deployment or transcript-quality score.

## Real MongoDB, isolated from production

Run `pnpm exec tsx scripts/verify-companion-isolated.ts`. This uses an already-installed
`mongod`, a new private temporary data directory, loopback-only ephemeral port, 256 MiB
WiredTiger cache and 20 maximum connections. It invokes
`scripts/verify-companion-mongo.ts` with a dedicated URI. No Mongo installation, production
database access, live service restart or external message is required.

Final observed result: **26 verification groups passed**, MongoDB **8.0.12**, zero external
effects, production database untouched. The test database was dropped; the exact isolated
mongod process was stopped and its temporary directory removed.

Covered real storage paths:

- Legacy single-bot ingress index adoption, bot-scoped deduplication and repeated index setup.
- Concurrent task claims: one owner, incrementing fence, old worker unable to create effects.
- Literal checkpoint preservation, confirmed-effect deduplication, safe checkpoint recovery.
- Pending external effect after worker interruption becomes `delivery_unknown`, not replay.
- A scheduled retry cannot be claimed before its persisted `resumeAt` after worker replacement.
- Once due, a new owner claims the retry with preserved attempts/checkpoints and an increased fence.
- Actor isolation and completed-task persistence.
- New and legacy archive/job/reminder/connector indexes coexist.
- Memory compare-and-swap initialization and stale-revision rejection.
- Two concurrent memory writes both survive; other owner/topic cannot recall them.
- Forgotten-memory hashes prevent old-source resurrection without retaining forgotten prose.
- Whole-owner erasure fences replay; source/text privacy tombstones block recovered evidence.
- Legacy memory uniqueness indexes migrate to topic-aware v3 without losing existing rows.
- Identical subject/text can exist in distinct topics, but duplicates within one topic fail.

The ordinary configured Mongo credential cannot create a separate test database (error 13).
The isolated runner resolves this test-environment limitation without broadening that user's
permissions or borrowing the production database. It is the recommended verification command.

## Focused deterministic and process checks

Observed passing groups during implementation:

- `companionIntegrations`, `capabilityForge`, `selfKnowledge`: 26 tests.
- `hostResourceBudget`, `resourceGovernor`, `process`: 13 tests, including actual kernel
  enforcement of a 1 KiB file-size ceiling; no RAM/swap stress workload.
- `companionCorpusIntegrity`: one inventory check over 144 held-out phrases.
- Durable scheduled-backoff work: 34 focused tests, including acknowledged read-timeout cancellation.
- Typed decision/progress coordinator: five `companionProgress` tests, preserving initial identities,
  budgets, verified result groups and safe observed-source revisions.

The connector tests exercise the actual Telegram adapter with a controlled API transport:
two immutable owners, reused authorization, changed recipient, revocation, expiration,
read/draft/send distinction, receipt replay and timeout-after-send uncertainty. They do not
prove delivery through the deployed Telegram account. Linux cross-process slots use kernel
`flock`; owner death closes the holder's pipe, avoiding stale-file deletion races.

## Conversational corpus: prepared, not falsely scored

`tests/fixtures/companion-conversation-variants.json` contains six distinct phrases for every
N01–N24 family: colloquial Italian, omissions, paraphrases, ellipsis, English and Spanish,
including negative/quoted/non-action cases. These remain outside model few-shot prompts.
The existing scenario fixture carries the scenario preconditions and required outcomes.

The integrity check establishes coverage and shape only. No score for slang understanding,
naturalness, full Telegram-adapter execution or live model generalization is claimed here.
Those require controlled end-to-end runs and transcript review. Live connector delivery,
production rollout observation and long-running soak are also separate acceptance gates.
