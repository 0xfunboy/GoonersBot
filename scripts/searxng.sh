#!/usr/bin/env bash
# GoonerBot SearXNG control (no Docker). Provides the free web-search backend for grounding.
#
#   scripts/searxng.sh setup    # one-time: clone + venv + deps + settings.yml (JSON, no limiter)
#   scripts/searxng.sh start    # launch on 127.0.0.1:8888 (background)
#   scripts/searxng.sh stop
#   scripts/searxng.sh status
#
# Override locations via env: SEARXNG_SRC, SEARXNG_VENV, SEARXNG_SETTINGS, SEARXNG_PORT.
set -euo pipefail

SRC="${SEARXNG_SRC:-$HOME/searxng-src}"
VENV="${SEARXNG_VENV:-$HOME/.local/searxng-venv}"
SETTINGS="${SEARXNG_SETTINGS:-$HOME/.config/searxng/settings.yml}"
PORT="${SEARXNG_PORT:-8888}"
PIDFILE="/tmp/searxng.pid"
LOG="/tmp/searxng.log"
PY="$VENV/bin/python"

setup() {
  [ -d "$SRC" ] || git clone --depth 1 https://github.com/searxng/searxng.git "$SRC"
  [ -d "$VENV" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install -U pip setuptools wheel pyyaml >/dev/null
  "$VENV/bin/pip" install -r "$SRC/requirements.txt" >/dev/null
  if [ ! -f "$SETTINGS" ]; then
    mkdir -p "$(dirname "$SETTINGS")"
    local secret
    secret="$("$PY" -c 'import secrets;print(secrets.token_hex(32))')"
    cat > "$SETTINGS" <<YAML
use_default_settings: true
general:
  instance_name: "goonerbot-searxng"
  debug: false
server:
  secret_key: "${secret}"
  bind_address: "127.0.0.1"
  port: ${PORT}
  limiter: false
  public_instance: false
  image_proxy: false
search:
  safe_search: 0
  formats:
    - html
    - json
  autocomplete: ""
YAML
  fi
  echo "SearXNG ready. Start with: scripts/searxng.sh start"
}

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "already running (pid $(cat "$PIDFILE"))"; return 0
  fi
  cd "$SRC"
  SEARXNG_SETTINGS_PATH="$SETTINGS" nohup "$PY" -m searx.webapp > "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 3
  status
}

stop() {
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null && rm -f "$PIDFILE" && echo "stopped" || echo "not running"
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "running (pid $(cat "$PIDFILE")) on http://127.0.0.1:${PORT}"
  else
    echo "not running"
  fi
}

case "${1:-}" in
  setup) setup ;;
  start) start ;;
  stop) stop ;;
  restart) stop || true; start ;;
  status) status ;;
  *) echo "usage: $0 {setup|start|stop|restart|status}"; exit 1 ;;
esac
