#!/usr/bin/env bash
# Remove CludeGods from this Mac: the gods and spaces skills (with the cludegods CLI and
# CallPill), the hooks it added to ~/.claude/settings.json, and the three desktop mods. Your
# workers, spaces and settings in ~/.voicemode/call go too, after you type "delete", unless you
# pass --keep-data. Everything is backed up first to ~/.claude/cludegods-backups.
#
#   ./uninstall.sh [--keep-data] [--yes]
#
# VoiceMode stays: it is its own project, with its own uninstaller.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$REPO/skills/gods/bin/cludegods" uninstall "$@"
