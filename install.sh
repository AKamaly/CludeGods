#!/usr/bin/env bash
# CludeGods installer. Installs what lives in this repository: the gods and spaces skills,
# the cludegods CLI, CallPill, the hooks and the state folder. Workers and Spaces need nothing
# else; voice is an upgrade on top (--voice, or `cludegods setup voice` later).
# Safe to run again: it backs up what it replaces and adds only what is missing.
#
#   ./install.sh                     install or update (no VoiceMode, Xcode tools or uv needed)
#   ./install.sh --voice             also set up voice: VoiceMode, its services, Silero VAD
#   ./install.sh --bluetooth-patch   also patch VoiceMode's mouth for Bluetooth output
#   ./install.sh --skip-pill         do not install CallPill
#   ./install.sh --yes               answer yes to the voice setup's questions
#
# bootstrap.sh (the one-line install) runs this, then installs the three desktop mods.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$HOME/.claude/skills"
CALL="$HOME/.voicemode/call"
VM_PY="${VOICEMODE_PY:-$HOME/.local/share/uv/tools/voice-mode/bin/python}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUPS="$HOME/.claude/cludegods-backups/$STAMP"
CLI="$SKILLS/gods/bin/cludegods"
CLI_REF="~/.claude/skills/gods/bin/cludegods"
PATCH=0 PILL=1 VOICE=0 YES=0
for arg in "$@"; do
  case "$arg" in
    --voice) VOICE=1 ;;
    --bluetooth-patch) PATCH=1 ;;
    --skip-pill) PILL=0 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '  \033[33m!\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
LATER=()

step "1. Checking this Mac"
[ "$(uname -s)" = Darwin ] || { echo "CludeGods runs on macOS only." >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || note "not Apple Silicon: voice will use Kokoro, since mlx-audio needs Apple Silicon"
python3 -c 'import sys' > /dev/null 2>&1 \
  || { echo "python3 is required: install the Xcode command line tools (xcode-select --install) or Homebrew's python." >&2; exit 1; }
ok "macOS $(sw_vers -productVersion 2>/dev/null || echo)"

step "2. Skills"
mkdir -p "$SKILLS"
# 0.5 renamed the skill from `colleague` (/colleague) to `gods` (/gods). Move the old one out of
# ~/.claude/skills (a copy left there would load as a second skill) and point every path that
# named it at the new folder: the hooks in settings.json and the workers' registry.
if [ -d "$SKILLS/colleague" ]; then
  mkdir -p "$BACKUPS" && mv "$SKILLS/colleague" "$BACKUPS/colleague"
  note "moved the old colleague skill to ~/.claude/cludegods-backups/$STAMP/colleague (it is /gods now)"
  [ -d "$SKILLS/gods" ] || cp -R "$BACKUPS/colleague" "$SKILLS/gods"
  for f in "$HOME/.claude/settings.json" "$CALL/workers.json"; do
    if [ -f "$f" ] && grep -q "skills/colleague/" "$f"; then
      cp -p "$f" "$BACKUPS/$(basename "$f")"
      python3 - "$f" <<'PY'
import os, sys, tempfile
p = sys.argv[1]
s = open(p).read().replace("skills/colleague/", "skills/gods/")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p))
with os.fdopen(fd, "w") as fh:
    fh.write(s)
os.replace(tmp, p)
PY
      ok "updated skill paths in $(basename "$f")"
    fi
  done
fi
for s in gods spaces; do
  dst="$SKILLS/$s"
  if [ -d "$dst" ] && ! diff -rq -x CallPill.app -x pill -x __pycache__ "$REPO/skills/$s" "$dst" >/dev/null 2>&1; then
    # Back up outside ~/.claude/skills: a copy left there would load as a second skill.
    mkdir -p "$BACKUPS" && cp -R "$dst" "$BACKUPS/$s" && note "backed up your current $s skill to ~/.claude/cludegods-backups/$STAMP/$s"
  fi
  rsync -a --exclude __pycache__ "$REPO/skills/$s/" "$dst/"
  ok "$s skill in ~/.claude/skills/$s"
done
chmod +x "$SKILLS/gods/bin/"{call,listen.py,narrate,permit,guard,outbox-say,pages,reply,bridge,cludegods} 2>/dev/null || true

step "3. CallPill"
# built from source when the Swift compiler is there, else the prebuilt one from the latest
# release, signed on this Mac; never a reason to stop the install
if [ "$PILL" = 0 ]; then
  note "skipped (--skip-pill)"
elif msg=$("$REPO/scripts/install-pill.sh" "$SKILLS/gods/bin" 2>&1); then
  ok "$msg"
else
  note "${msg:-CallPill not installed}"
  note "everything else works without it; calls just have no floating card"
  LATER+=("CallPill: run $CLI_REF doctor --fix rebuild-pill (after xcode-select --install, or once a release has the prebuilt app)")
fi

step "4. Hooks in ~/.claude/settings.json"
python3 - "$REPO/config/settings.example.json" "$HOME/.claude/settings.json" "$STAMP" <<'PY'
import json, os, shutil, sys
example, target, stamp = sys.argv[1:4]
want = json.load(open(example))["hooks"]
cur = {}
if os.path.exists(target):
    try:
        cur = json.load(open(target))
    except ValueError:
        sys.exit(f"  {target} is not valid JSON; fix it, then run ./install.sh again")
hooks = cur.setdefault("hooks", {})
have = {h.get("command") for entries in hooks.values() for e in entries for h in e.get("hooks", [])}
added = []
for event, entries in want.items():
    for e in entries:
        new = [h for h in e["hooks"] if h["command"] not in have]
        if new:
            hooks.setdefault(event, []).append({**e, "hooks": new})
            added += [f"{event}: {os.path.basename(h['command'])}" for h in new]
if added:
    if os.path.exists(target):
        shutil.copy2(target, f"{target}.bak-{stamp}")
        print(f"  ! backed up settings.json to settings.json.bak-{stamp}")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = target + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cur, f, indent=2)
        f.write("\n")
    os.replace(tmp, target)
    for a in added:
        print(f"  \033[32m✓\033[0m added {a}")
else:
    print("  \033[32m✓\033[0m hooks already in place")
PY

step "5. State folder"
mkdir -p "$CALL/outbox" "$CALL/spaces"
if [ -f "$CALL/workers.json" ]; then
  ok "kept your workers registry"
else
  printf '{\n  "workers": []\n}\n' > "$CALL/workers.json" && ok "created an empty workers registry"
fi
if [ -e "$CALL/config.json" ]; then
  ok "kept your config.json"
else
  cp "$REPO/config/config.example.json" "$CALL/config.json" \
    && ok "created config.json (spoken yes after a read-back, the app's permission dialog, workers save pages)"
fi
# where this install came from and with which options, for `cludegods update`
python3 "$CLI" record-install "$REPO" "$@" || note "could not write ~/.voicemode/call/install.json"
ok "~/.voicemode/call is ready"

step "6. Voice"
if [ "$VOICE" = 1 ]; then
  args=(setup voice)
  if [ "$YES" = 1 ]; then args+=(--yes); fi
  if [ "$PATCH" = 1 ]; then args+=(--bluetooth-patch); fi
  if python3 "$CLI" "${args[@]}"; then
    ok "voice is ready"
  else
    LATER+=("finish the voice setup: $CLI_REF setup voice (it picks up where it stopped)")
  fi
elif [ -x "$VM_PY" ]; then
  # VoiceMode is already here: keep its ears current (Silero VAD), as every install did before
  ok "found VoiceMode (./install.sh --voice checks the whole voice setup)"
  python3 "$CLI" setup vad || LATER+=("Silero VAD: $CLI_REF setup vad")
  if [ "$PATCH" = 1 ]; then
    python3 "$CLI" setup bluetooth || LATER+=("Bluetooth patch: $CLI_REF setup bluetooth")
  fi
else
  ok "skipped: Workers and Spaces work without voice"
  note "to talk to Claude, add voice any time: ./install.sh --voice (or $CLI_REF setup voice)"
fi

if [ -n "${CLUDEGODS_NO_NEXT_STEPS:-}" ]; then
  # bootstrap.sh and `cludegods update` install the mods and print what comes next themselves
  if [ ${#LATER[@]} -gt 0 ]; then
    step "Still to do:"
    for l in "${LATER[@]}"; do note "$l"; done
  fi
  exit 0
fi
step "Done. Two steps left, inside Claude Code:"
cat <<'EOF'

  a) Install the desktop mods. In a terminal session of Claude Code:

       /plugin install workers-pane --marketplace AKamaly/CludeGods
       /plugin install spaces-pane  --marketplace AKamaly/CludeGods
       /plugin install inbox-relay  --marketplace AKamaly/CludeGods   (only for Slack)

     Or in the desktop app: + next to the prompt box, Plugins, Add marketplace
     AKamaly/CludeGods, then add each plugin. Restart the app once afterwards.

  b) Type /gods in any chat.

  Check everything any time: ~/.claude/skills/gods/bin/cludegods doctor
EOF
if [ ${#LATER[@]} -gt 0 ]; then
  step "Still to do:"
  for l in "${LATER[@]}"; do note "$l"; done
fi
