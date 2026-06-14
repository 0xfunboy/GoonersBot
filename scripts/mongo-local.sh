#!/usr/bin/env bash
# Local MongoDB helper for GoonerBot dev (no Docker, no root).
# Uses a user-local mongod binary + data dir. Auth is enabled; the app user/password
# are whatever you created — keep the matching MONGO_URI in your .env.
#
# Usage: scripts/mongo-local.sh {start|stop|status}
set -euo pipefail

MONGOD="${MONGOD_BIN:-$HOME/.local/mongodb/bin/mongod}"
DBPATH="${GOONER_MONGO_DBPATH:-$HOME/.local/goonerbot-mongo/db}"
LOGPATH="${GOONER_MONGO_LOG:-$HOME/.local/goonerbot-mongo/mongod.log}"
PORT="${GOONER_MONGO_PORT:-27017}"

case "${1:-}" in
  start)
    mkdir -p "$DBPATH"
    "$MONGOD" --dbpath "$DBPATH" --bind_ip 127.0.0.1 --port "$PORT" --auth \
      --logpath "$LOGPATH" --fork
    echo "mongod started on 127.0.0.1:$PORT (auth on)"
    ;;
  stop)
    "$MONGOD" --dbpath "$DBPATH" --shutdown
    echo "mongod stopped"
    ;;
  status)
    if ss -lntp 2>/dev/null | grep -q ":$PORT "; then echo "mongod: UP on :$PORT"; else echo "mongod: DOWN"; fi
    ;;
  *)
    echo "Usage: $0 {start|stop|status}"; exit 1;;
esac
