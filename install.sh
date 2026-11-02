#!/usr/bin/env bash
# CludeGods installer. Installs everything that lives in this repository: the gods and
# spaces skills, CallPill, the hooks, Silero VAD for VoiceMode's ears, and the state folder.
# Safe to run again: it backs up what it replaces and adds only what is missing.
#
#   ./install.sh                     install or update
#   ./install.sh --bluetooth-patch   also patch VoiceMode's mouth for Bluetooth output
#   ./install.sh --skip-pill         do not build CallPill
#
# VoiceMode itself and the three desktop mods install from inside Claude Code; the script
# prints those steps at the end.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$HOME/.claude/skills"
CALL="$HOME/.voicemode/call"
VM_PY="${VOICEMODE_PY:-$HOME/.local/share/uv/tools/voice-mode/bin/python}"
SILERO="$HOME/.voicemode/models/silero_vad.onnx"
SILERO_URL="https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUPS="$HOME/.claude/cludegods-backups/$STAMP"
PATCH=0 PILL=1
for arg in "$@"; do
  case "$arg" in
    --bluetooth-patch) PATCH=1 ;;
    --skip-pill) PILL=0 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '  \033[33m!\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
LATER=()

step "1. Checking this Mac"
[ "$(uname -s)" = Darwin ] || { echo "CludeGods runs on macOS only." >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || note "not Apple Silicon: mlx-audio will not run, the Kokoro fallback will"
command -v python3 >/dev/null || { echo "python3 is required (install the Xcode command line tools)." >&2; exit 1; }
ok "macOS $(sw_vers -productVersion 2>/dev/null || echo)"

step "2. VoiceMode"
if [ -x "$VM_PY" ]; then
  ok "found VoiceMode's Python"
  if "$VM_PY" -c "import onnxruntime" 2>/dev/null; then
    ok "onnxruntime already installed"
  elif command -v uv >/dev/null; then
    if uv pip install --quiet --python "$VM_PY" onnxruntime 2>/dev/null; then
      ok "installed onnxruntime for Silero VAD"
    else
      note "could not install onnxruntime into VoiceMode's Python ($("$VM_PY" -V 2>&1))"
      LATER+=("install onnxruntime into VoiceMode's Python: uv pip install --python $VM_PY onnxruntime")
    fi
  else
    note "uv not found: install it (brew install uv), then run this script again"
    LATER+=("install uv and run ./install.sh again (Silero VAD needs onnxruntime)")
  fi
  if [ -s "$SILERO" ]; then
    ok "Silero VAD model present"
  else
    mkdir -p "$(dirname "$SILERO")"
    curl -fsSL -o "$SILERO" "$SILERO_URL" && ok "downloaded the Silero VAD model"
  fi
  if [ "$PATCH" = 1 ]; then
    SITE="$("$VM_PY" -c 'import voice_mode, os; print(os.path.dirname(voice_mode.__path__[0]))')"
    P="$REPO/patches/voicemode-mouth-bluetooth.patch"
    if patch -d "$SITE" -p1 -R --dry-run -s -f < "$P" >/dev/null 2>&1; then
      ok "Bluetooth patch already applied"
    elif patch -d "$SITE" -p1 --dry-run -s -f < "$P" >/dev/null 2>&1; then
      patch -d "$SITE" -p1 -b -s < "$P" && ok "applied the Bluetooth patch (original kept as .orig)"
    else
      note "the Bluetooth patch does not fit this VoiceMode version; skipped"
    fi
  fi
else
  note "VoiceMode is not installed yet. The voice call needs it; everything else works without it."
  LATER+=("install VoiceMode (README, Get started, step 1), then run ./install.sh again")
fi

step "3. Skills"
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
chmod +x "$SKILLS/gods/bin/"{call,listen.py,narrate,permit,guard,outbox-say,pages,reply,bridge} 2>/dev/null || true

step "4. CallPill"
if [ "$PILL" = 0 ]; then
  note "skipped (--skip-pill)"
elif command -v swiftc >/dev/null; then
  "$REPO/scripts/build-pill.sh" "$SKILLS/gods/bin" >/dev/null 2>&1 && ok "built and signed CallPill.app" || note "CallPill build failed: run scripts/build-pill.sh to see why"
else
  note "swiftc not found: run xcode-select --install, then ./install.sh again"
  LATER+=("install the Xcode command line tools and run ./install.sh again (CallPill)")
fi

step "5. Hooks in ~/.claude/settings.json"
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

step "6. State folder"
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
ok "~/.voicemode/call is ready"

step "Done. Two steps left, inside Claude Code:"
cat <<'EOF'

  a) Install the desktop mods. In a terminal session of Claude Code:

       /plugin install workers-pane --marketplace AKamaly/CludeGods
       /plugin install spaces-pane  --marketplace AKamaly/CludeGods
       /plugin install inbox-relay  --marketplace AKamaly/CludeGods   (only for Slack)

     Or in the desktop app: + next to the prompt box, Plugins, Add marketplace
     AKamaly/CludeGods, then add each plugin. Restart the app once afterwards.

  b) Start a call: type /gods in any chat.
EOF
if [ ${#LATER[@]} -gt 0 ]; then
  step "Still to do:"
  for l in "${LATER[@]}"; do note "$l"; done
fi
