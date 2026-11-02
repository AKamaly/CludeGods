#!/usr/bin/env bash
# CludeGods one-line install:
#
#   curl -fsSL https://raw.githubusercontent.com/AKamaly/CludeGods/main/bootstrap.sh | bash
#
# Voice too (VoiceMode, its services, Silero VAD and a self-test):
#
#   curl -fsSL https://raw.githubusercontent.com/AKamaly/CludeGods/main/bootstrap.sh | bash -s -- --voice
#
# It clones CludeGods to ~/.cludegods/src (or pulls it when it is already there), runs
# install.sh with any options you pass, installs the three desktop mods with the Claude Code
# CLI, and runs `cludegods doctor`. Safe to run again.
#
# CLUDEGODS_REPO_URL, CLUDEGODS_BRANCH and CLUDEGODS_SRC point it at another copy (a fork).
set -euo pipefail

# Everything runs from main(): bash reads a piped script as it goes, so nothing below may run
# before the whole file has arrived, and nothing may read stdin (it is this script).
main() {
  local url="${CLUDEGODS_REPO_URL:-https://github.com/AKamaly/CludeGods.git}"
  local branch="${CLUDEGODS_BRANCH:-main}"
  local src="${CLUDEGODS_SRC:-$HOME/.cludegods/src}"
  local cli="$HOME/.claude/skills/gods/bin/cludegods"

  title() { printf '\n\033[1m%s\033[0m\n' "$*"; }
  die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

  [ "$(uname -s)" = Darwin ] || die "CludeGods runs on macOS only."
  python3 -c 'import sys' > /dev/null 2>&1 \
    || die "python3 is needed: run xcode-select --install (or brew install python), then run this again."
  git --version > /dev/null 2>&1 \
    || die "git is needed: run xcode-select --install, then run this again."

  title "Getting CludeGods"
  if [ -d "$src/.git" ]; then
    if git -C "$src" pull --ff-only --quiet < /dev/null; then
      echo "  updated $src"
    else
      echo "  ! could not update $src (local changes?); installing the copy that is there"
    fi
  else
    if [ -e "$src" ]; then
      local aside
      aside="$src.old-$(date +%Y%m%d-%H%M%S)"
      mv "$src" "$aside"
      echo "  ! $src was not a git checkout; moved it to $aside"
    fi
    mkdir -p "$(dirname "$src")"
    git clone --quiet --branch "$branch" "$url" "$src" < /dev/null \
      || die "could not clone $url. Check your connection, then run this again."
    echo "  cloned into $src"
  fi

  title "Installing"
  CLUDEGODS_NO_NEXT_STEPS=1 bash "$src/install.sh" "$@" < /dev/null

  title "Installing the desktop mods"
  python3 "$cli" doctor --fix install-panes < /dev/null \
    || echo "  ! the mods are not installed yet: the check below says what to do"

  title "Checking"
  python3 "$cli" doctor < /dev/null || true

  title "Next"
  echo "  1. Restart the Claude app (quit it fully, then open it again)."
  echo "  2. Type /gods in any chat."
}

main "$@"
