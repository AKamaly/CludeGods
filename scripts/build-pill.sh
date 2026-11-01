#!/usr/bin/env bash
# build-pill.sh: compile CallPill from pill.swift, bundle it as CallPill.app, ad-hoc sign it.
#
#   scripts/build-pill.sh [BIN_DIR]
#
# BIN_DIR defaults to the skill's bin directory in this repo. Run it again after copying the
# skill to ~/.claude/skills/colleague/bin if you want the app built in place there:
#   scripts/build-pill.sh ~/.claude/skills/colleague/bin
#
# The signature is ad-hoc but carries a fixed designated requirement, so macOS (TCC) keeps
# the microphone grant across rebuilds. Override the identifier with CALLPILL_BUNDLE_ID.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/skills/colleague/bin}"
BIN="$(cd "$BIN" && pwd)"
ID="${CALLPILL_BUNDLE_ID:-dev.cludegods.callpill}"
SRC="$BIN/pill.swift"
[ -f "$SRC" ] || SRC="$ROOT/skills/colleague/bin/pill.swift"

command -v swiftc > /dev/null || { echo "swiftc not found: install the Xcode command line tools (xcode-select --install)" >&2; exit 1; }

echo "compiling $SRC"
swiftc -O "$SRC" -o "$BIN/pill" -framework Metal -framework MetalKit

APP="$BIN/CallPill.app"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN/pill" "$APP/Contents/MacOS/CallPill"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>CallPill</string>
	<key>CFBundleIdentifier</key>
	<string>$ID</string>
	<key>CFBundleName</key>
	<string>CallPill</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSMicrophoneUsageDescription</key>
	<string>CallPill reads the microphone level so the call orb moves with your voice. Audio is never recorded or sent anywhere.</string>
</dict>
</plist>
PLIST

codesign -f -s - -i "$ID" -r="designated => identifier \"$ID\"" "$APP"
echo "built $APP ($ID)"
echo "preview every state without a window: $BIN/pill --snapshot /tmp/callpill.png"
