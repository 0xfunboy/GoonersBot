# Companion rework baseline

Captured on 2026-09-19 from branch `companion-rework/phase-1-ingress`. This inventory is the
comparison point for R00–R14; runtime manifests and generated command documentation supersede it
when they disagree.

## Ingress and execution path

`Telegram getUpdates → durable update_inbox admission → conversation executor → grammY context →
access/terms gate → message adapter → Scene + Cortex/evaluator → providers/agent runtime → reply
transport`.

The R00 implementation makes the first three boundaries explicit: Telegram's offset advances only
after admission, every recovered/live item enters the same ordered pump, and bot/topic order is
serialized under a global concurrency bound. Legacy handlers remain one-turn executions; generic
task checkpoints and outbox receipts belong to R04–R05.

## Capability and decision inventory

- 54 static Telegram commands, generated in `docs/COMMANDS.md`.
- 17 built-in executable manifests in `companion/capabilities/catalog.ts`.
- Cortex remains the primary semantic selector when enabled; deterministic fallback and the legacy
  evaluator remain compatible degradations.
- Planner/executor path: `MultiActionPlanner → validateActionPlan → ToolOrchestrator →
  FinalAnswerComposer`, hosted by `AgentRuntime`.
- Context-only observations: group/social memory, curated knowledge, anime metadata, ambient recall
  and current news.
- Terminal/artefact work: public-page audit, web/image lookup, anime archive, link/media/music,
  image/video generation, translation/TTS, documents and Capability Forge.
- Persistent specialist workers already present before generic tasks: anime archive and local
  development. Their states and receipts remain authoritative until R04–R05 adapters replace them.

The executable manifest records operations separately. In particular, anime lookup/follow/unfollow
and archive search/availability/rehost/series-rehost have different effects and retry rules.

## Provider/readiness boundaries

| Family | Runtime authority | Important distinction |
| --- | --- | --- |
| Web/current facts | SearXNG + bounded page fetch/audit | Public client-side evidence is not server-side source code or a pentest. |
| News | Configured RSS/Atom feeds | Current observations carry source links and freshness; news is now executable inside composite agent plans. |
| Anime metadata | AniList/Jikan catalog | Metadata does not prove archive availability. |
| Anime archive | AnimeUnity/HentaiSaturn registry | Only supported no-gateway archive sources may drive availability/rehost. A trailer is not an episode. |
| Documents | Telegram extraction + DocumentProcessor | Analysis is limited to extracted content and reports unreadable parts. |
| Generated media | configured image/video/TTS providers | A generated artefact is distinct from locating/rehosting existing media. |
| Acquired research | Capability Forge manifests | Installed recipes are selectable through Cortex without requiring their slash command. |
| Code work | local-development workspace/jobs | Proposed, generated, applied and deployed are distinct states. |

## Baseline incompatibilities and disposition

| Observation | Baseline state | Rework disposition |
| --- | --- | --- |
| Executor permit was incremented after `await` | Reproduced: concurrency 1 reached 8 | Fixed and burst-tested in R00. |
| grammY advanced its internal polling cursor before durable middleware succeeded | Reproduced | Built-in polling replaced by persist-before-offset polling in R00. |
| Replay called `handleUpdate` before grammY initialization | Code inspection | Explicit `bot.init()` before recovery in R00. |
| Expired lease could be claimed twice and stale owner could complete it | Reproduced | Owner/fence/heartbeat plus conservative `outcome_unknown` quarantine in R00. |
| `page_scan` occurred twice in the planner enum | Code inspection | IDs generated once from the R01 catalog. |
| Cortex advertised `news` but AgentRuntime had no news definition/handler | Code inspection | News definition and executable handler connected in R01. |
| Terminal routing used another hardcoded tool set | Code inspection | Derived from capability manifests in R01. |
| `/capabilities` listed only Forge recipes | Code inspection | Now reports built-in runtime readiness and recipes. |

## Verification levels

- Deterministic local tests prove contracts, routing and simulated fault behavior.
- Mongo-specific tests in the current suite use repository doubles; an isolated real-Mongo
  migration/recovery rehearsal is still required before production activation.
- No deployment, service restart, production migration or real-model semantic evaluation is part
  of this baseline capture.

The canonical seed corpus lives in `tests/fixtures/companion-conversation-corpus.json`. Cases are
kept outside Cortex few-shots where possible; R02–R14 add paraphrases and hidden eval variants
without changing the expected behavioral contract.
