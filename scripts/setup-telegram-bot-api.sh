#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/third_party/telegram-bot-api"
BUILD="$SRC/build"
PREFIX="${TELEGRAM_BOT_API_PREFIX:-$HOME/.local}"
JOBS="${TELEGRAM_BOT_API_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"
UNIT_SRC="$ROOT/ops/systemd/telegram-bot-api.service"
UNIT_DST="$HOME/.config/systemd/user/telegram-bot-api.service"
SECRET_ENV="$HOME/.config/goonerbot/telegram-bot-api.env"

log() { printf '[telegram-bot-api] %s\n' "$*"; }
die() { printf '[telegram-bot-api] ERROR: %s\n' "$*" >&2; exit 1; }

resolve_cmake() {
  if command -v cmake >/dev/null 2>&1; then command -v cmake; return; fi
  if [[ -x "$HOME/.local/venvs/telegram-bot-api-build/bin/cmake" ]]; then
    printf '%s\n' "$HOME/.local/venvs/telegram-bot-api-build/bin/cmake"
    return
  fi
  die "cmake not found. Install cmake or create $HOME/.local/venvs/telegram-bot-api-build with the Python cmake package."
}

resolve_gperf() {
  if command -v gperf >/dev/null 2>&1; then command -v gperf; return; fi
  if [[ -x "$HOME/.local/bin/gperf" ]]; then printf '%s\n' "$HOME/.local/bin/gperf"; return; fi
  die "gperf not found. Install gperf (system package or $HOME/.local/bin/gperf)."
}

command -v git >/dev/null 2>&1 || die "git not found"
command -v make >/dev/null 2>&1 || die "make not found"
command -v c++ >/dev/null 2>&1 || die "C++ compiler not found"
command -v pkg-config >/dev/null 2>&1 || die "pkg-config not found"
pkg-config --exists openssl || die "OpenSSL development files not found"
pkg-config --exists zlib || die "zlib development files not found"

CMAKE="$(resolve_cmake)"
GPERF="$(resolve_gperf)"

log "initializing pinned upstream source"
git -C "$ROOT" submodule update --init --recursive third_party/telegram-bot-api

[[ -f "$SRC/CMakeLists.txt" ]] || die "submodule missing at $SRC"

# A checkout can be moved together with an old CMake build directory. CMake stores the absolute
# source path in CMakeCache.txt and refuses to reuse it from another location, so invalidate only
# that stale build cache and leave a correctly-rooted incremental build untouched.
if [[ -f "$BUILD/CMakeCache.txt" ]]; then
  CACHED_SOURCE="$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "$BUILD/CMakeCache.txt" | head -1)"
  if [[ -n "$CACHED_SOURCE" && "$CACHED_SOURCE" != "$SRC" ]]; then
    log "discarding stale build cache rooted at $CACHED_SOURCE"
    rm -rf "$BUILD"
  fi
fi

log "building with cmake=$CMAKE gperf=$GPERF jobs=$JOBS"
PATH="$(dirname "$GPERF"):$PATH" "$CMAKE" \
  -S "$SRC" \
  -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
PATH="$(dirname "$GPERF"):$PATH" "$CMAKE" --build "$BUILD" --target telegram-bot-api --parallel "$JOBS"

install -d -m 0755 "$PREFIX/bin"
install -m 0755 "$BUILD/telegram-bot-api" "$PREFIX/bin/telegram-bot-api"
log "installed $PREFIX/bin/telegram-bot-api"

install -d -m 0700 "$HOME/.config/goonerbot" "$HOME/.config/systemd/user"
if [[ ! -f "$SECRET_ENV" ]]; then
  install -m 0600 "$ROOT/ops/systemd/telegram-bot-api.env.example" "$SECRET_ENV"
  log "created $SECRET_ENV; fill TELEGRAM_API_ID and TELEGRAM_API_HASH before starting the service"
else
  chmod 0600 "$SECRET_ENV"
fi

install -m 0644 "$UNIT_SRC" "$UNIT_DST"
systemctl --user daemon-reload
systemctl --user enable telegram-bot-api.service >/dev/null

if grep -Eq '^TELEGRAM_API_ID=[0-9]+$' "$SECRET_ENV" && grep -Eq '^TELEGRAM_API_HASH=[0-9a-fA-F]+$' "$SECRET_ENV"; then
  systemctl --user restart telegram-bot-api.service
  systemctl --user --no-pager --full status telegram-bot-api.service | sed -n '1,18p'
else
  log "service installed/enabled but not started: credentials are still placeholders in $SECRET_ENV"
fi

log "done"
