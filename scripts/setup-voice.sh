#!/usr/bin/env bash
# Provision the local voice toolchain into vendor/ (gitignored): static ffmpeg + whisper.cpp + model.
# Idempotent. Requires: curl, tar, gcc/g++, make, git. cmake is downloaded if missing.
# Usage: scripts/setup-voice.sh [model]   (model: tiny|base|small ; default base)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
MODEL="${1:-base}"
mkdir -p "$VENDOR/bin" "$VENDOR/models"

# ---- ffmpeg ----
# Prefer a system ffmpeg (apt install ffmpeg): it is dynamically linked with real TLS and handles
# network/HLS input + section cutting. The johnvansickle static build segfaults on those, so we only
# fall back to a static BtbN build (also network-capable) when no system ffmpeg is present.
# When using a system ffmpeg, set FFMPEG_BIN=/usr/bin/ffmpeg in .env.
if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg: using system $(command -v ffmpeg) ($(ffmpeg -version | head -1)). Set FFMPEG_BIN=$(command -v ffmpeg) in .env."
elif [ ! -x "$VENDOR/bin/ffmpeg" ]; then
  echo "==> no system ffmpeg; downloading static ffmpeg (BtbN)"
  tmp="$(mktemp -d)"
  curl -sL -o "$tmp/ffmpeg.tar.xz" https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
  tar -xf "$tmp/ffmpeg.tar.xz" -C "$tmp"
  d="$(ls -d "$tmp"/ffmpeg-*-linux64-gpl | head -1)"
  cp "$d/bin/ffmpeg" "$d/bin/ffprobe" "$VENDOR/bin/"
  rm -rf "$tmp"
  echo "ffmpeg: $("$VENDOR/bin/ffmpeg" -version | head -1)"
fi

# ---- yt-dlp (standalone, no python needed) for /sing /play music ----
if [ ! -x "$VENDOR/bin/yt-dlp" ]; then
  echo "==> downloading yt-dlp"
  curl -sL -o "$VENDOR/bin/yt-dlp" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
  chmod +x "$VENDOR/bin/yt-dlp"
fi
echo "yt-dlp: $("$VENDOR/bin/yt-dlp" --version 2>/dev/null | head -1)"

# ---- cmake (portable, only if not on PATH) ----
CMAKE=cmake
if ! command -v cmake >/dev/null 2>&1; then
  if [ ! -x "$VENDOR/cmake/bin/cmake" ]; then
    echo "==> downloading portable cmake"
    tmp="$(mktemp -d)"
    curl -sL -o "$tmp/cmake.tar.gz" https://github.com/Kitware/CMake/releases/download/v3.30.5/cmake-3.30.5-linux-x86_64.tar.gz
    tar -xf "$tmp/cmake.tar.gz" -C "$tmp"
    mv "$tmp"/cmake-3.30.5-linux-x86_64 "$VENDOR/cmake"
    rm -rf "$tmp"
  fi
  CMAKE="$VENDOR/cmake/bin/cmake"
fi

# ---- whisper.cpp ----
if [ ! -x "$VENDOR/whisper.cpp/build/bin/whisper-cli" ]; then
  echo "==> cloning + building whisper.cpp"
  rm -rf "$VENDOR/whisper.cpp"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$VENDOR/whisper.cpp"
  ( cd "$VENDOR/whisper.cpp"
    "$CMAKE" -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_EXAMPLES=ON
    "$CMAKE" --build build -j"$(nproc)" --config Release )
fi
echo "whisper-cli: $VENDOR/whisper.cpp/build/bin/whisper-cli"

# ---- model ----
MODEL_FILE="$VENDOR/models/ggml-$MODEL.bin"
if [ ! -f "$MODEL_FILE" ]; then
  echo "==> downloading whisper model: $MODEL"
  curl -sL -o "$MODEL_FILE" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
fi
echo "model: $MODEL_FILE ($(du -h "$MODEL_FILE" | cut -f1))"

echo "==> voice toolchain ready. Set STT_ENABLED=true / TTS_ENABLED=true in .env."
