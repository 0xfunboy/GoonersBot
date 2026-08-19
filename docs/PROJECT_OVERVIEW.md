# GoonersBot — nature, workflow and what this session changed

Reference written on 2026-08-19. Covers what the project is, how a message becomes a reply, and
what the 16 commits from `b60a298` to `3e4dff9` actually changed.

---

## 1. What the project is

GoonersBot is a **group-native Telegram assistant** for one private Italian community. It is not a
support bot: the design goal is a member of the group that happens to be software — it has a
personality, roasts people, remembers the group's lore, and speaks unprompted when it has something
worth saying.

Concretely that means a few things are unusual compared with a normal chatbot:

- **Adult and abrasive by design.** NSFW routing, roast budgets and profanity are first-class
  features, not accidents to be sanded off. Any change that softens the voice is a regression.
- **Deterministic code decides, the model phrases.** Permissions, quotas, URL parsing, catalog
  facts, job creation and social state are all computed in code. The LLM chooses wording and
  intent, never truth.
- **Everything degrades to null.** A dead provider, a 503 from the model endpoint or an empty
  search returns nothing rather than throwing. A broken subsystem must never cost a user a reply.
- **Free/self-hosted backends.** SearXNG for search, a local OpenAI-compatible endpoint for the
  models, yt-dlp + ffmpeg for media, MongoDB for state. No paid API is required to run it.

### Stack

| | |
| --- | --- |
| Runtime | Node 24.18.0, TypeScript 5.7 (ESM), pnpm 9.15 |
| Telegram | grammY, long-polling |
| State | MongoDB (single database, one collection per concern) |
| Models | OpenAI-compatible endpoint (Gemini/Gemma behind a local router) |
| Search | self-hosted SearXNG |
| Media | yt-dlp + ffmpeg, sandboxed with bubblewrap |
| Tests | Vitest — **1097** passing at the time of writing |
| Gates | `pnpm typecheck`, `lint`, `format:check`, `test`, `build` |

### Deployment

A `systemd --user` unit (`goonerbot.service`) runs `dist/main.js`. `dist/` is gitignored and shared
with the running service, so **building on this machine changes what the next restart loads**. The
unit is tracked at `ops/systemd/goonerbot.service` so its `PATH` (which now includes Deno, see §4)
survives a redeploy.

---

## 2. How a message becomes a reply

This is the pipeline that already existed before this session. It is worth reading before changing
anything, because most of the bugs in §4 came from bolting things onto the wrong stage of it.

```
Telegram update
   │
   ├─ dispatch ──────────── is it a /command? → command handler → done
   │
   └─ message handler
        ├─ permissions · bans · terms · approval
        ├─ addressed? (mention / reply-to-bot / private)
        ├─ if NOT addressed and autoengage is off → store as context, stop
        ├─ AutoEngageScorer  ── one focused LLM call: is intervening worth it?
        │                       gated by per-chat and per-user cooldowns + hourly cap
        └─ ReplyService.generateReply  ◀── the long path
```

### Inside `ReplyService` (`src/services/reply.ts`, ~1950 lines)

| stage | file | what it decides |
| --- | --- | --- |
| **Scene** | `brain/sceneAnalyzer.ts` | topic, energy, who is active, and a `socialSignal` (situation, support need, posture, whether humour is allowed, roast ceiling). Has a deterministic heuristic fallback so a dead model still yields a usable scene. |
| **Cortex** | `brain/cortex/` | the intent layer. Picks intents and **which tools to call** from a closed list. Has a non-LLM `fallbackCortex` for the passive fast path. |
| **Providers** | parallel `Promise.all` | group RAG (memory), grounding (SearXNG + page scan), curated knowledge, heat, and — added this session — the anime catalog, ambient recall and social standing. |
| **Plan** | `brain/replyPlanner.ts` | reply intent, roast budget (capped by the social ceiling), target handles, max lines/chars. |
| **Style** | `brain/styleEngine.ts` | samples style variants (`bar_talk`, `venomous`, `lorekeeper`, `market_degen`…) biased by the scene. This is where the voice lives. |
| **Generate** | `brain/responseGenerator.ts` | produces several candidates. |
| **Rank + guard** | `brain/responseRanker.ts`, `repetitionGuard.ts`, `socialAwareness.ts` | picks the best candidate, rejects repetition and hostility that breaches the social floor, can regenerate. |
| **Send** | `telegram/render.ts` | markdown/HTML rendering, chunking, media attachment. |

### The two reply paths (this matters)

There are **two** ways a reply gets composed, and confusing them caused three separate production
bugs this session:

1. **The normal styled path** — everything in the table above. Style engine, roast budget, length
   limits, repetition guard. This is what produces in-character replies.
2. **The agent path** (`services/agentRuntime.ts` + `agent/`) — a DAG planner/orchestrator for
   turns that need to *produce an artifact*: generate an image, download music, make a video. It
   composes with its **own** composer and **does not pass through the style engine**.

Which path runs is decided by `terminalAgentTools` in `reply.ts`: if Cortex requested any tool in
that set, the agent path takes over and returns early.

> **The rule learned the hard way:** a tool that *retrieves facts* belongs on the normal path.
> Only a tool that *produces an artifact* belongs in `terminalAgentTools`. Putting a retrieval tool
> there sends a simple question through a composer that concatenates raw tool output.

### Background jobs

`jobs/scheduler.ts` is an in-process `setInterval` scheduler (no external cron). It runs retention
cleanup, memory mining, feedback learning, autonomous posting, generated-image posting, and — added
this session — anime release polling and `/learn` completion notices.

---

## 3. Working agreements for this repo

Established during this session, worth keeping:

- **Commit straight to `main`.** The user runs production from this working tree. A feature branch
  was created early out of habit and had to be deleted; do not create one again unless asked.
- **Git identity must be forced.** The environment exports
  `GIT_AUTHOR_EMAIL=0xfunboy@users.noreply.github.com`, which overrides `.git/config`. Every commit
  needs the identity passed explicitly, and verified afterwards.
- **No Claude/Anthropic/co-author trailers** in commit messages.
- **All five gates before every deploy**, then `rm -rf dist && pnpm build` so `dist/` matches the
  commit, then restart the service, then read the logs.
- **The logs are the diagnosis.** Every production bug this session was found in `journalctl`, and
  three of them were misdiagnosed until the log was read. The journal is in **UTC**; the chat
  screenshots are in **CEST (UTC+2)**.

---

## 4. What the commits changed

16 commits, `b60a298 → 3e4dff9`, **77 files, +10102 / -58**. Tests went from 826 to **1097**.

### Groundwork

| commit | files | what |
| --- | --- | --- |
| `579b748` | 4 | Prettier on four files that already violated `format:check` on `main`, kept separate so the feature diff stayed readable. |

### Feature 1 — anime release catalog

| commit | files | what |
| --- | --- | --- |
| `b9f4bdb` | 34 | **AniList catalog + per-chat follows.** New `src/anime/` module: GraphQL provider, optional Jikan/MAL enrichment, deterministic title normalisation and fuzzy matching (bigram Dice + token coverage, no LLM), SearXNG fallback for discovery. Collections `anime_series` and `anime_follows`. A scheduler job polls followed series and announces a new episode **exactly once per chat**, using a conditional watermark claim taken *before* sending — so a restarted scheduler cannot duplicate a notice. Also added bounded `POST` support to `safeRemoteFetch` for GraphQL, which refuses to follow redirects rather than replaying a body against an unvalidated origin. |

**Declined in the same commit:** the original brief asked for AnimeUnity/HentaiSaturn scrapers to
download and rehost whole series into Telegram. That is a piracy redistribution pipeline and was
not built; the catalog answers the same questions from AniList and links to legal streaming.

### Feature 2 — ambient recall

| commit | files | what |
| --- | --- | --- |
| `607980f` | 20 | **Recall across ten topic domains.** Every other knowledge surface is *pulled* by a classified intent; this one is *pushed* — it runs on every turn and injects verified facts about whatever is being discussed. The disambiguation axis is **volatility, not subject**: `live` (anime, news) / `slow` (film, tech, gaming, music) / `stable` (science, psychology, philosophy, history). A recency marker promotes `slow`→`live` but can never promote `stable`. Classification and subject extraction are a lexicon pass, no model call. Providers re-expose sources the bot already had (AniList, Wikipedia, curated KB, RSS). Collection `ambient_cache`, with negative caching. |
| `ce986a3` | 19 | **Put recall in the loop.** Unprompted images now search for the series the group is actually discussing instead of a generic waifu. Passive engagement lowers its confidence bar when the bot genuinely knows the subject. A per-chat `topic_affinity` counter learns the group's taste and biases autonomous posting. Recalled subjects become conversation entities so a later "quando esce il prossimo?" resolves. And `/learn` stopped requiring polling: the scheduler announces finished jobs with the next command, claimed in Mongo so a restart cannot announce twice. |

### Bug fixes — the interesting half

These are worth reading as a group, because they were all the same class of mistake.

| commit | files | what went wrong |
| --- | --- | --- |
| `f0ceb8c` | 16 | Seven review findings. Worst: a slow source could **stall a reply** — the whole recall step now runs under a raced deadline, so a provider ignoring its abort signal loses its results rather than holding up the turn. Also: the apostrophe was treated as a quote delimiter, so Italian elision produced garbage subjects; `stale` was announced as a terminal `/learn` state though it is runnable; re-mentions wiped `threadIds` and broke referent resolution; the autoengage rebate ignored its own config; facts were labelled with the message's domain rather than one their provider covers. |
| `29344bf` | 1 | A recall deadline was logged at `warn` as if it were a fault. It is the mechanism working. |
| `b4c1c42` | 8 | **Two features had shipped dead.** `listTerminal(50)` bound 50 to `withinMs`, so the `/learn` notifier asked for jobs finished in the last 50 *milliseconds* and never fired. And the network budget was gated on `live` volatility, which had the reasoning backwards — the stable domains are the ones with an empty cache, so Wikipedia was **permanently unreachable** for all four of its domains. Also: a finished series kept announcing a next episode, because absent fields were omitted from `$set` with no `$unset`. |
| `8906a41` | 3 | Overlapping subjects produced a second, *wrong* fact ("Dissonanza" → musical dissonance beside the psychology one). Candidates are now tried most-specific-first and the source arbitrates. |
| `95add39` | 5 | Asked "quando esce il prossimo episodio di Tanya the Evil", the bot answered about season 1, concluded in 2017, then printed its own verification error to the group. Two causes: a shortlist was reported as a tool *failure*, so the agent discarded real data; and a franchise whose four entries share a name is not ambiguous when only one is airing — the user's own words now decide that. |
| `cd8dc60` | 3 | The bot pasted a field list, then the raw `WEB CONTEXT` block **including its own instructions**, then whole scraped pages — 6462 characters. Cause: `anime_knowledge` was registered in `terminalAgentTools`, forcing a retrieval question down the agent composer. Moved to the normal styled path, where it went from 6462 characters to a reply in voice. |
| `b451f50` | 7 | The bot answered "Non sono riuscito a completare questa azione in modo verificabile" about a series the catalog knew. Recall was computed *after* the agent branch returned, so any turn the planner routed elsewhere ran **blind** — the one mechanism meant to know things nobody asked for was sitting behind an early return. Also: an exact title match could lose to a near-identical alias, and a fuzzy hit on a partially-crawled cache was trusted as if the cache were complete. |
| `2a83ace` | 8 | `segui Chainsmoker Cat` roasted the user and **created no subscription** — Cortex classified it as banter. Free text is acceptable for a *read* and unacceptable for a *write*, where a miss is silent data loss. Added `/follow` (alias `/segui`), `/unfollow`, `/following`, `/anime`, translated into four languages. An existing test caught that `/help` was already near the Telegram 4096-char ceiling. |
| `ae35993` | 3 | **Not a code bug.** Every `/sing` and `/play` failed with a uniform `403 Forbidden`: YouTube now requires solving a JavaScript challenge. Needed both a JS runtime (Deno, user-local, added to the service `PATH`) *and* a current yt-dlp — the June build falls back to a player client YouTube rejects. Documented in `ops/YTDLP.md`, because it will recur. |

### Feature 3 — social standing and factual advocacy

| commit | files | what |
| --- | --- | --- |
| `7b1e064` | 14 | **Standing, allyship, and the end of the prompt leak.** Design in `docs/SOCIAL_STANDING.md`. `rapport` is a months-long memory of how someone treated the bot, deliberately separate from the fast-decaying `heat` score. **Teasing scores zero** — this group jokes by insulting, and if banter cost rapport nobody would ever be tagged a friend. Decay is one-directional: grudges expire, earned warmth does not. The `friend` tag needs +40 rapport, 20+ interactions and 30 quiet days, and only a genuine conflict revokes it. The resolved tension: **evidence decides the side, rapport decides the tone** — otherwise the bot is a sycophant. Same commit fixed the leak class properly: tool summaries no longer carry the prompt block, and `stripPromptScaffolding` runs where text becomes a reply, so a future tool that forgets cannot leak either. |
| `3e4dff9` | 3 | The document listed four verifiability tiers; the code produced three. `contested` was declared and never returned, so any dispute with **one** source graded as `settled` and the bot would call someone wrong on the strength of a single page. `settled` now needs two or more independent sources, counted by host. |

---

## 5. New state

Six collections, all in the existing database, indexes created idempotently at boot:

| collection | holds |
| --- | --- |
| `anime_series` | the catalog, keyed `source`+`sourceId`; refresh is an upsert |
| `anime_follows` | per-chat subscriptions + the `lastNotifiedEpisode` watermark |
| `ambient_cache` | cached ambient lookups, including negative results |
| `topic_affinity` | what each chat keeps coming back to, and who raised it |
| `job_notifications` | duplicate-suppression claims for `/learn` notices |
| `social_standing` | rapport, friend tag, interaction and conflict counts |

---

## 6. Recurring lessons

Six weeks of engineering compressed into one session; these are the mistakes worth not repeating.

1. **Stub the boundary, not the thing you are testing.** Two features shipped completely dead
   (`b4c1c42`) because tests stubbed the exact call that was broken. The tests passed and the
   feature never ran.
2. **A prompt block is not a reply.** Three separate leaks came from text written for the model
   being emitted to users. The fix that held was an invariant at the point of emission, not a patch
   per tool.
3. **The cache is a partial view of the source.** A lone cached candidate looks unambiguous only
   because its rivals were never fetched. This produced two wrong answers before it was fixed at
   the root (`b451f50`).
4. **Ambiguity is information, not failure.** Reporting a shortlist as a tool failure made the
   agent throw away real data and surface its own machinery instead.
5. **Free text for reads, commands for writes.** A misrouted read is a worse answer; a misrouted
   write is silent data loss the user believes succeeded.
6. **A uniform failure across every input is external.** A code defect fails selectively. That is
   how the yt-dlp block was distinguished from a regression — and it is why "you broke `/sing`" was
   answerable with evidence rather than apology.
7. **Verify before asserting.** Several times the honest answer to "is this done?" was found only
   by checking, and twice the check found a gap — including the one that produced `3e4dff9`.

---

## 7. Known open items

- **Latency.** Turns measured 23–72 s, dominated by the model endpoint returning
  `503 Gemini request attempt budget exhausted` and cooling down for ~17 s. Not application code.
  Worth looking at candidate count per reply and endpoint sizing.
- **`/help` headroom.** ~18 characters left in Spanish. The next command added needs `/help`
  paginated.
- **Corroboration ≠ agreement.** `settled` means several independent sources speak to a point, not
  that they were checked against each other. Deliberate, documented, and the reason a
  single-source catalog answer grades `contested`.
- **Group taste needs time.** `topic_affinity` only reaches the proactive surfaces after repeated
  mentions by more than one person, so unprompted images stay generic at first by design.
