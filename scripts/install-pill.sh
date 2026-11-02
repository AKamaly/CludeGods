#!/usr/bin/env bash
# install-pill.sh: put a signed CallPill.app in BIN_DIR, whichever way works on this Mac.
#
#   scripts/install-pill.sh [BIN_DIR]
#
# Builds it from source when the Swift compiler is there (build-pill.sh), else downloads the
# prebuilt app from the latest release (fetch-pill.sh). Prints one line saying which; exits 1,
# with the reason, when neither worked. install.sh and `cludegods doctor --fix rebuild-pill`
# both use it.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${1:-$HERE/../skills/gods/bin}"
mkdir -p "$BIN"

# /usr/bin/swiftc is only a stub until the Xcode command line tools are installed
if command -v swiftc > /dev/null 2>&1 && xcode-select -p > /dev/null 2>&1; then
  if "$HERE/build-pill.sh" "$BIN" > /dev/null 2>&1; then
    echo "built and signed CallPill.app"
    exit 0
  fi
  why="the build failed (scripts/build-pill.sh shows why)"
else
  why="no Swift compiler (xcode-select --install)"
fi
if out=$("$HERE/fetch-pill.sh" "$BIN" 2>&1); then
  echo "downloaded the prebuilt CallPill.app and signed it on this Mac"
  exit 0
fi
echo "CallPill not installed: $why, and the download failed (${out##*$'\n'})"
exit 1
