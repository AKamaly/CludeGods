#!/usr/bin/env bash
# sign-pill.sh: ad-hoc sign CallPill.app with a fixed identifier and designated requirement.
#
#   scripts/sign-pill.sh [APP]
#
# APP defaults to the skill's bin/CallPill.app in this repo. build-pill.sh signs every build
# with it, and fetch-pill.sh re-signs a downloaded build on this Mac. The fixed designated
# requirement is what makes macOS (TCC) keep the app's grants across rebuilds and downloads.
# Override the identifier with CALLPILL_BUNDLE_ID; keep it the same from one build to the next.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/skills/gods/bin/CallPill.app}"
ID="${CALLPILL_BUNDLE_ID:-dev.cludegods.callpill}"
PLIST="$APP/Contents/Info.plist"

[ -d "$APP" ] || { echo "no app at $APP" >&2; exit 1; }
# a build signed under another identifier (a download, a changed CALLPILL_BUNDLE_ID) takes this one
if [ -f "$PLIST" ] && [ "$(plutil -extract CFBundleIdentifier raw -o - "$PLIST" 2>/dev/null)" != "$ID" ]; then
  plutil -replace CFBundleIdentifier -string "$ID" "$PLIST"
fi
codesign -f -s - -i "$ID" -r="designated => identifier \"$ID\"" "$APP"
