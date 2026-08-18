# X frontend (interactive noVNC MVP)

This service starts a dedicated Firefox session for the bot's X account and exposes its display
through noVNC. It is an operator console: the browser is interactive and the operator navigates X
manually.

The MVP does **not** publish, comment, like, repost, follow, delete or send direct messages through
bot automation. It is not connected to Telegram commands or the capability-learning system. Manual
clicks inside Firefox are real X actions and take effect immediately; there is no draft approval
step in this MVP.

## Network boundary

Both listeners are local-only:

- noVNC HTTP/WebSocket listens on `127.0.0.1:6088` by default;
- x11vnc listens on `127.0.0.1:5908` by default.

The application accepts only `127.0.0.1` for `SOCIAL_X_FRONTEND_HOST`. Do not publish either port
through a router, cloud firewall, reverse proxy or public tunnel. This MVP has no separate web-login
layer; the SSH account and tunnel are its access boundary.

Use an SSH local-forward from the operator workstation:

```bash
ssh -N -L 127.0.0.1:6088:127.0.0.1:6088 funboy@SERVER
```

Then open this URL on that workstation:

```text
http://127.0.0.1:6088/vnc.html?autoconnect=1&resize=remote
```

Close the browser tab and SSH tunnel when the session is no longer needed. Treat screenshots and
clipboard contents as account data.

## Runtime configuration

The committed systemd unit reads `/home/funboy/goonerbot/data/x-frontend.env`. Keep the file mode
`0600`; it must contain paths and settings, never raw cookie values. A minimal configuration is:

```dotenv
SOCIAL_X_FRONTEND_HOST=127.0.0.1
SOCIAL_X_FRONTEND_PORT=6088
SOCIAL_X_VNC_PORT=5908
SOCIAL_X_DISPLAY=:98
SOCIAL_X_COOKIE_JAR_FILE=/home/funboy/goonerbot/data/social-sessions/x.cookies.txt
SOCIAL_X_BROWSER_PROFILE_DIR=/home/funboy/goonerbot/data/social-browser/x
```

`SOCIAL_X_COOKIE_JAR_FILE` and `SOCIAL_X_BROWSER_PROFILE_DIR` must be absolute paths. Keep the cookie
jar at mode `0600` and the profile directory at mode `0700`. Neither location may be served by
noVNC or committed to Git. The persistent profile is dedicated to this bot account; never point it
at a personal Firefox profile that is open elsewhere.

The Netscape jar bootstraps an empty profile. Once Firefox has its own authenticated X cookies, the
runtime preserves those newer browser cookies instead of overwriting them with the original jar.
If authentication later needs attention, noVNC remains available for a manual login or challenge.

The runtime expects these programs on `PATH`:

- Node.js 24.18.0 at `/home/funboy/.nvm/versions/node/v24.18.0/bin/node`;
- `Xvfb`, `x11vnc`, `websockify`, `firefox` and `geckodriver`;
- noVNC static files at `/usr/share/novnc`.

Firefox and geckodriver are installed as Snap packages on this host. The service therefore cannot
use systemd's `PrivateTmp` or `NoNewPrivileges`: both prevent `snap-confine` from launching. The
browser still runs inside Snap confinement, and the VNC/noVNC listeners remain loopback-only.

Ports `5908` and `6088` and display `:98` must not already be in use. The systemd service starts the
compiled entrypoint `dist/xFrontendMain.js`, so build the project before starting or restarting it.

## Unit installation

The repository unit is [goonerbot-x-frontend.service](../ops/systemd/goonerbot-x-frontend.service).
After reviewing the environment file and building the project, an operator can install it as a user
service:

```bash
install -d -m 700 /home/funboy/goonerbot/data/social-browser/x
chmod 600 /home/funboy/goonerbot/data/x-frontend.env
chmod 600 /home/funboy/goonerbot/data/social-sessions/x.cookies.txt
pnpm build
install -m 644 /home/funboy/goonerbot/ops/systemd/goonerbot-x-frontend.service \
  /home/funboy/.config/systemd/user/goonerbot-x-frontend.service
systemctl --user daemon-reload
systemctl --user enable --now goonerbot-x-frontend.service
```

Those commands are deployment instructions only; adding this documentation does not install or
start the service.

## Operations

Inspect service state and recent sanitized runtime messages with:

```bash
systemctl --user status goonerbot-x-frontend.service
journalctl --user -u goonerbot-x-frontend.service -n 100 --no-pager
```

The runtime must never log cookie values, browser storage, authorization headers or the contents of
the X page. If Firefox shows a login or challenge page, resolve it manually through noVNC. Do not add
credentials to the environment file, command line or journal.

On a clean stop, the supervisor closes WebDriver and Firefox, then terminates Xvfb, x11vnc and
websockify. Snap places Firefox/geckodriver in its own transient scope, while the local display and
proxy processes stay in the service cgroup. The profile remains on disk for the next session.

## Scope of the next phase

A future GoonerBot frontend may extract a sanitized view of notifications/comments and present
immutable post drafts for explicit approval. Publishing must remain a separate adapter with durable
audit, idempotency and per-account authorization. The interactive noVNC browser is not that approval
system and must not be treated as one.
