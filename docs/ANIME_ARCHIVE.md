# Anime episode archive

GoonersBot can resolve and rehost public episodes from AnimeUnity and HentaiSaturn without routing
the conversation through the artifact agent. AniList/Jikan may supply internal metadata and title
aliases, but never a watch/download link or a release notification. Live availability, follow
notifications and every rehost action come exclusively from AnimeUnity first, with HentaiSaturn as
an NSFW-policy-gated fallback.

## User flow

Supported public URL shapes are:

- `https://www.animeunity.so/anime/<id>-<slug>/<episode-id>` — one episode;
- `https://www.animeunity.so/anime/<id>-<slug>/` — all currently listed episodes;
- `https://www.hentaisaturn.tv/episode/<slug>/ep-<number>` — one episode;
- `https://www.hentaisaturn.tv/hentai/<slug>` — all currently listed episodes.

A supported episode URL may be pasted by itself. After the ordinary approval and quota checks, the
bot queues it and returns immediately; download and Telegram upload happen in the background in the
same chat and forum topic. A Telegram-compatible source file is uploaded byte-for-byte unchanged;
ffmpeg preparation is fallback-only for an incompatible or oversized source.

A series URL never starts work immediately. A true group administrator (or a configured bot admin)
receives `Vuoi scaricare e rehostare l'intero anime su telegram?` with `SI | NO` on one row. Private
chat bulk requests are restricted to configured bot admins. The opaque confirmation expires, is
bound to its requester/chat/topic, re-checks admin status on `SI`, and is consumed atomically. Once
consumed, the original prompt remains in chat as an audit trail and only its buttons are removed.
Completed episodes carry Telegram receipts, so a restarted worker resumes at the first unfinished
episode and keeps concurrency at exactly one.

Natural-language archive actions use the same LLM-first action architecture as the rest of the
bot. Cortex is the authoritative intent evaluator: it decides whether the turn needs
`anime_knowledge` (catalog metadata/follows) or the `anime_archive` action tool, and emits structured
`intent`, `title`, optional `episode` and optional `source` arguments. The coordinator may execute
`anime_archive` only when Cortex requested it; the planner cannot invent the write action on its own.
The archive service then deterministically verifies AnimeUnity/HentaiSaturn and creates the offer or
queue job. Actual source URLs and `SI / NO` callbacks remain the only archive interactions handled
before Cortex because their meaning is already explicit protocol state, not natural-language
classification.

`anime_archive` supports `availability`, `rehost` and `series`. Availability verifies the requested
episode and creates `Vuoi che te lo scarichi e rehosti qui?`; an explicit rehost request queues the
resolved episode; whole-series requests create the existing admin-only confirmation. The Cortex is
given the replied-to Telegram text explicitly, so short follow-ups such as `scaricalo` can resolve
pronouns and episode references semantically rather than through keyword/regex parsing. Ordinary
anime questions continue through `anime_knowledge`; after a catalog lookup, the existing bounded
source enrichment may still add a relevant archive offer. Follow notifications are emitted only
after the episode is observed on a supported archive source and include that canonical source URL.

Long jobs keep one best-effort Telegram status message updated across download and upload, adding a
conversion stage only when fallback preparation is actually required. Status delivery is
hard-time-bounded and cannot delay the worker, its lease, or the media upload itself.

HentaiSaturn remains governed by `LINK_MEDIA_NSFW_ALLOW`; the archive layer does not weaken the
existing adult-host policy.

## Configuration

The long-form limits are separate from `LINK_MEDIA_MAX_DURATION_SECONDS`. Ordinary social/general
link rehosting therefore retains its short-form 180-second default.

```dotenv
ANIME_ARCHIVE_ENABLED=true
ANIME_ARCHIVE_BULK_ENABLED=true
ANIME_ARCHIVE_PROFILE=source
ANIME_ARCHIVE_MAX_DURATION_SECONDS=7200
ANIME_ARCHIVE_MAX_DOWNLOAD_MB=2048
ANIME_ARCHIVE_BULK_CONCURRENCY=1
ANIME_ARCHIVE_TIMEOUT_MS=1800000
ANIME_ARCHIVE_MAX_HEIGHT=720
ANIME_ARCHIVE_CRF=28
ANIME_ARCHIVE_AUDIO_BITRATE_KBPS=80
ANIME_ARCHIVE_FFMPEG_THREADS=1
ANIME_ARCHIVE_OFFER_TTL_MINUTES=15
ANIME_ARCHIVE_MAX_RETRIES=3
ANIME_ARCHIVE_TMP_DIR=.tmp-anime-archive
```

Every archive job first preserves the downloaded AnimeUnity/HentaiSaturn file byte-for-byte when
its H.264/AAC streams are already Telegram-compatible and it fits the configured upload ceiling.
This fast path runs before profile selection: there is no remux and no lossy encode for a source
that is already valid. If Telegram compatibility or the hard size ceiling requires preparation,
the worker falls back to the bounded normalizer. `source` is the default fallback profile; `mobile`
keeps the explicit compact H.264/AAC, `yuv420p`, `+faststart` fallback profile, never upscales past
the configured height and switches directly to a bitrate-limited encode when a CRF pass would
predictably exceed the Telegram ceiling. The final upload ceiling is the existing
`LINK_MEDIA_MAX_UPLOAD_MB` setting. Long-form ffmpeg work caps decoder/filter/encoder parallelism
(one to four threads) whenever a fallback encode is needed; ordinary short-form media keeps its
existing behavior.

## Persistence and resource bounds

MongoDB collections `anime_archive_offers` and `anime_archive_jobs` hold confirmation state,
leases, per-episode attempts and Telegram receipts. They never hold signed media URLs, cookies or
player headers. Signed URLs are resolved just in time for every bounded attempt; HTTP 403/410 and
transient network failures restart source resolution rather than persisting an expired token.

After media preparation and immediately before final quota admission/upload, the worker persists an
opaque per-episode delivery marker with majority+journal write concern. A receipt is committed
durably only against that marker. A definite quota denial or Telegram client-side rejection can
roll the marker and reservation back for a bounded retry; ambiguous quota responses, Telegram
timeouts/5xx responses and process loss retain the latch and any possible reservation. The episode
then terminates as `delivery outcome unknown` and is never resent automatically, including after
lease recovery, series refresh or manual resume. Conservatively, this can also produce an unknown
row when quota admission may have committed but Telegram was never invoked. Operator inspection may
be required, but the rule prevents duplicate uploads and double quota charging.

Downloads stream to a mode-0700, per-process scratch subtree. A job keeps only one episode on disk,
passes local paths to ffmpeg and Telegram, and removes the episode directory in `finally` on
success, failure, cancellation or shutdown. Do not point `ANIME_ARCHIVE_TMP_DIR` at a shared or
valuable directory.

Direct files use the existing redirect-aware, DNS-rebinding-resistant safe fetcher. HLS/DASH
fallbacks use the existing bubblewrap network namespace and guarded egress proxy with only the
adapter's page/player/media hosts allowed. Source and signed URLs are redacted before logging.

## Troubleshooting source changes

The adapters parse current public structured page/player data, not captured media tokens. If a site
changes markup, run the fixture tests first and then a bounded live probe that stops after metadata
and candidate resolution. A structural parse error is permanent for that attempt; 429/5xx,
timeouts, connection resets and expired candidates are retried within the configured budget.

Useful checks:

```bash
pnpm vitest run tests/animeArchiveAdapters.test.ts tests/animeArchiveStorage.test.ts \
  tests/animeArchiveService.test.ts tests/animeNormalizer.test.ts
pnpm typecheck
journalctl --user -u goonerbot.service -n 200 --no-pager | rg 'anime archive'
```

Never paste a full candidate URL from production logs or a browser inspector into an issue. Query
strings may contain short-lived access material even when the underlying page is public.
