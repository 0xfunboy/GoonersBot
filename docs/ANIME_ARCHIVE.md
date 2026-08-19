# Anime episode archive

GoonersBot can resolve and rehost public episodes from AnimeUnity and HentaiSaturn without routing
the conversation through the artifact agent. The existing AniList/Jikan catalog remains the source
for release facts, title matching, follows and scheduled notifications; this module only checks
whether the resolved episode is currently available from one of the two media sources.

## User flow

Supported public URL shapes are:

- `https://www.animeunity.so/anime/<id>-<slug>/<episode-id>` — one episode;
- `https://www.animeunity.so/anime/<id>-<slug>/` — all currently listed episodes;
- `https://www.hentaisaturn.tv/episode/<slug>/ep-<number>` — one episode;
- `https://www.hentaisaturn.tv/hentai/<slug>` — all currently listed episodes.

A supported episode URL may be pasted by itself. After the ordinary approval and quota checks, the
bot queues it and returns immediately; download, ffmpeg preparation and Telegram upload happen in
the background in the same chat and forum topic.

A series URL never starts work immediately. A true group administrator (or a configured bot admin)
receives `Vuoi scaricare e rehostare l'intero anime su telegram?` with `SI | NO` on one row. Private
chat bulk requests are restricted to configured bot admins. The opaque confirmation expires, is
bound to its requester/chat/topic, re-checks admin status on `SI`, and is consumed atomically.
Completed episodes carry Telegram receipts, so a restarted worker resumes at the first unfinished
episode and keeps concurrency at exactly one.

Normal anime questions continue through `anime_knowledge` and the styled reply pipeline. Once the
existing catalog has resolved a series, a bounded live source lookup can add the natural offer
`Vuoi che te lo rehosti qui?`. A button or a short reply such as `sì`, `scaricalo` or `vai` invokes
the same single-episode job used by a pasted URL. Follow notifications use the same offer path.

HentaiSaturn remains governed by `LINK_MEDIA_NSFW_ALLOW`; the archive layer does not weaken the
existing adult-host policy.

## Configuration

The long-form limits are separate from `LINK_MEDIA_MAX_DURATION_SECONDS`. Ordinary social/general
link rehosting therefore retains its short-form 180-second default.

```dotenv
ANIME_ARCHIVE_ENABLED=true
ANIME_ARCHIVE_BULK_ENABLED=true
ANIME_ARCHIVE_PROFILE=mobile
ANIME_ARCHIVE_MAX_DURATION_SECONDS=7200
ANIME_ARCHIVE_MAX_DOWNLOAD_MB=2048
ANIME_ARCHIVE_BULK_CONCURRENCY=1
ANIME_ARCHIVE_TIMEOUT_MS=1800000
ANIME_ARCHIVE_MAX_HEIGHT=720
ANIME_ARCHIVE_CRF=28
ANIME_ARCHIVE_AUDIO_BITRATE_KBPS=80
ANIME_ARCHIVE_FFMPEG_THREADS=2
ANIME_ARCHIVE_OFFER_TTL_MINUTES=15
ANIME_ARCHIVE_MAX_RETRIES=3
ANIME_ARCHIVE_TMP_DIR=.tmp-anime-archive
```

`mobile` always produces H.264/AAC, `yuv420p`, `+faststart`, never upscales past the configured
height and makes a bitrate-aware second pass when needed. `source` remuxes a compatible source that
already fits Telegram's byte and height ceilings, otherwise it uses the same safe transcode path.
The final upload ceiling is the existing `LINK_MEDIA_MAX_UPLOAD_MB` setting. Long-form ffmpeg work
also caps decoder/filter/encoder parallelism (one to four threads) so a single episode cannot take
every CPU core; ordinary short-form media keeps its existing behavior.

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
