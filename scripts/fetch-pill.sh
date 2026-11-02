#!/usr/bin/env bash
# fetch-pill.sh: download the prebuilt CallPill.app from the latest GitHub release into BIN_DIR
# and re-sign it ad-hoc on this Mac, with the same identifier as a local build.
#
#   scripts/fetch-pill.sh [BIN_DIR]
#
# For Macs without the Xcode command line tools. CALLPILL_URL overrides where it comes from.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/skills/gods/bin}"
URL="${CALLPILL_URL:-https://github.com/AKamaly/CludeGods/releases/latest/download/CallPill-macos.zip}"

mkdir -p "$BIN"
BIN="$(cd "$BIN" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL -o "$TMP/CallPill-macos.zip" "$URL" || { echo "could not download $URL" >&2; exit 1; }
mkdir "$TMP/x"
# ditto merges macOS metadata back; unzip would leave ._ files that break the signature
if command -v ditto > /dev/null; then
  ditto -x -k "$TMP/CallPill-macos.zip" "$TMP/x" || { echo "the download is not a zip" >&2; exit 1; }
else
  unzip -q "$TMP/CallPill-macos.zip" -d "$TMP/x" || { echo "the download is not a zip" >&2; exit 1; }
fi
find "$TMP/x" -name '._*' -delete
[ -x "$TMP/x/CallPill.app/Contents/MacOS/CallPill" ] || { echo "the download has no CallPill.app" >&2; exit 1; }
xattr -dr com.apple.quarantine "$TMP/x/CallPill.app" 2>/dev/null || true
"$ROOT/scripts/sign-pill.sh" "$TMP/x/CallPill.app" > /dev/null
rm -rf "$BIN/CallPill.app"
mv "$TMP/x/CallPill.app" "$BIN/CallPill.app"
echo "installed $BIN/CallPill.app from $URL"
