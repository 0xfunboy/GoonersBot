# yt-dlp and the YouTube JS challenge

## What broke

On 2026-08-18 every `/sing`, `/play` and YouTube link rehost failed with:

```
yt-dlp exited 1: ERROR: unable to download video data: HTTP Error 403: Forbidden
```

Every query failed, not just some, and nothing in the bot's code had touched the
media path. The cause was external: YouTube now requires clients to solve a JavaScript
challenge to sign media requests. yt-dlp says so explicitly when a runtime is missing:

```
WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled
by default. YouTube extraction without a JS runtime has been deprecated
```

## What it needs

Two things, both external to this repository:

1. **A JavaScript runtime.** yt-dlp looks for `deno` on `PATH` by default. Installed
   user-local at `~/.deno/bin/deno`; `ops/systemd/goonerbot.service` prepends that
   directory to the service `PATH`. Without it, yt-dlp cannot sign the request.
2. **A current yt-dlp.** The June stable build fails even with a runtime available: it
   falls back to the `android_vr` player client, which YouTube answers with 403.
   Excluding that client leaves only image formats. The nightly build carries the
   working client set.

Both are needed. A runtime without a current build still fails, and vice versa.

## Updating

```bash
curl -sL -o /tmp/yt-dlp \
  https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux
chmod +x /tmp/yt-dlp && cp /tmp/yt-dlp vendor/bin/yt-dlp
```

Verify in the service's own environment, not an interactive shell - an interactive shell
has a richer `PATH` and will pass where the service fails:

```bash
env -i HOME=$HOME PATH="$HOME/.deno/bin:/usr/local/bin:/usr/bin:/bin" \
  vendor/bin/yt-dlp -f bestaudio --no-playlist -o /tmp/t.%\(ext\)s "ytsearch1:test"
```

A working run logs `[youtube] [jsc:deno] Solving JS challenges using deno`. If that line
is absent, the runtime was not found and a 403 is coming.

## Expect this again

YouTube changes this periodically and any pinned yt-dlp will eventually fail the same
way. The symptom is always a uniform 403 across every query, which is how you tell it
from a bug in this codebase: a code defect would fail selectively.
