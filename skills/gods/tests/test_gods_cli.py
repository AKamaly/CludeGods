"""Tests for the cludegods CLI (skills/gods/bin/cludegods), install.sh, bootstrap.sh and
uninstall.sh.

Nothing real is installed and nothing outside a temporary folder is touched: every test runs
with a temporary HOME and fake brew, uv, uvx, voicemode, VoiceMode's python, claude, curl,
codesign, xcode-select, swiftc and call first on PATH (or in the temporary HOME). The fakes log
each call and leave the marker files the real tools would (a LaunchAgent plist for `voicemode
service enable`, VoiceMode's python for `uvx voice-mode-install`, ...). The voice services'
ports are a local HTTP server that answers 200 only for the services a fake has "started".

  python3 -B -I -m unittest discover -s skills/gods/tests -v
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "skills" / "gods" / "bin" / "cludegods"
SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
COPY_IGNORE = shutil.ignore_patterns(".git", "art", "docs", "node_modules", "__pycache__",
                                     "CallPill.app", "pill", "*.pyc", ".DS_Store")

# ---------------------------------------------------------------------------------------------
# the fakes: one program, behaving as whatever name it is called by

FAKE = r'''
import json, os, sys
from datetime import datetime
from pathlib import Path

name = os.path.basename(sys.argv[0])
args = sys.argv[1:]
HOME = Path(os.environ["HOME"])
STATE = Path(os.environ["FAKE_STATE"])
FAKEBIN = Path(os.environ["FAKE_BIN"])
PROG = os.environ["FAKE_PROG"]
VM_BIN = HOME / ".local/share/uv/tools/voice-mode/bin"
with open(STATE / "log", "a") as fh:
    fh.write(json.dumps([name] + args) + "\n")


def flag(n):
    return (STATE / n).exists()


def touch(p):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()


def link(dst):
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        os.symlink(PROG, dst)


def heard(*recs):
    d = HOME / ".voicemode/logs/conversations"
    d.mkdir(parents=True, exist_ok=True)
    now = datetime.now().astimezone()
    with open(d / f"heard_{now.date().isoformat()}.jsonl", "a") as fh:
        for r in recs:
            fh.write(json.dumps({"ts": now.isoformat(timespec="milliseconds"), **r}) + "\n")


if name == "brew":
    if args[:2] == ["install", "uv"]:
        if flag("brew-fails"):
            print("Error: no bottle for uv")
            sys.exit(1)
        link(FAKEBIN / "uv")
        link(FAKEBIN / "uvx")
    sys.exit(0)

if name == "uv":
    if args[:2] == ["pip", "install"]:
        if flag("uv-pip-fails"):
            print("error: no wheel for this Python")
            sys.exit(1)
        touch(STATE / "onnxruntime")
    else:
        print("uv 0.0.0")
    sys.exit(0)

if name == "uvx":
    if args[:1] == ["voice-mode-install"]:
        if "--dry-run" in args:
            print("Would install: VoiceMode, portaudio, ffmpeg")
            sys.exit(0)
        if flag("uvx-fails"):
            print("voice-mode-install: something broke")
            sys.exit(1)
        link(VM_BIN / "python")
        link(VM_BIN / "voicemode")
        sys.exit(0)
    sys.exit(1)

if name == "python":   # VoiceMode's python
    code = args[1] if args[:1] == ["-c"] else ""
    if args[:1] == ["-V"]:
        print("Python 3.12.0")
    elif "onnxruntime" in code:
        sys.exit(0 if flag("onnxruntime") else 1)
    elif "sounddevice" in code:
        print(json.dumps({"device": "Fake Mic", "peak": int(os.environ.get("FAKE_MIC_PEAK", "0"))}))
    elif "voice_mode" in code:
        site = HOME / "vm-site"
        site.mkdir(exist_ok=True)
        print(site)
    sys.exit(0)

if name == "voicemode":
    if args[:2] == ["service", "install"]:
        svc = args[2]
        if flag(f"install-{svc}-fails"):
            print(f"{svc}: download failed")
            sys.exit(1)
        if svc == "mlx-audio":
            (HOME / ".local/share/uv/tools/mlx-audio").mkdir(parents=True, exist_ok=True)
        else:
            touch(HOME / ".voicemode/services" / svc / "installed")
    elif args[:2] == ["whisper", "model"]:
        touch(HOME / ".voicemode/services/whisper/models/ggml-large-v3-turbo.bin")
    elif args[:2] == ["service", "enable"]:
        touch(HOME / f"Library/LaunchAgents/com.voicemode.{args[2]}.plist")
        if not flag(f"{args[2]}-stays-down"):
            touch(STATE / f"up-{args[2]}")
    elif args[:2] in (["service", "start"], ["service", "restart"]):
        if not flag(f"{args[2]}-stays-down"):
            touch(STATE / f"up-{args[2]}")
    sys.exit(0)

if name == "curl":
    out = Path(args[args.index("-o") + 1])
    url = args[-1]
    if "silero" in url and not flag("curl-fails"):
        out.write_bytes(b"onnx model")
    elif "CallPill" in url and os.environ.get("FAKE_PILL_ZIP"):
        out.write_bytes(Path(os.environ["FAKE_PILL_ZIP"]).read_bytes())
    else:
        sys.stderr.write("curl: (22) The requested URL returned error: 404\n")
        sys.exit(22)
    sys.exit(0)

if name == "codesign":
    sys.exit(0)

if name == "xcode-select":
    sys.exit(0 if flag("xcode") else 2)

if name == "swiftc":
    sys.exit(1)

if name == "claude":
    path = STATE / "claude.json"
    st = json.loads(path.read_text()) if path.exists() else {"plugins": {}, "markets": []}

    def save():
        path.write_text(json.dumps(st))

    if args == ["plugin", "--help"]:
        print("Usage: claude plugin")
    elif args[:2] == ["plugin", "list"]:
        print(json.dumps([{"id": k, "enabled": v, "scope": "user"} for k, v in st["plugins"].items()]))
    elif args[:3] == ["plugin", "marketplace", "list"]:
        print(json.dumps([{"name": n, "source": "github"} for n in st["markets"]]))
    elif args[:3] == ["plugin", "marketplace", "add"]:
        st["markets"].append("cludegods")
        save()
    elif args[:3] == ["plugin", "marketplace", "remove"]:
        st["markets"] = [m for m in st["markets"] if m != args[3]]
        save()
    elif args[:3] == ["plugin", "marketplace", "update"]:
        print("updated")
    elif args[:2] in (["plugin", "install"], ["plugin", "enable"]):
        st["plugins"][args[2]] = True
        save()
    elif args[:2] == ["plugin", "uninstall"]:
        st["plugins"].pop(args[2], None)
        save()
    elif args[:2] == ["plugin", "update"]:
        print(f"{args[2]} is up to date")
    else:
        sys.exit(1)
    sys.exit(0)

if name == "call":
    if args[:1] == ["start"]:
        ears = os.environ.get("FAKE_EARS", "hear")
        if ears == "error":
            heard({"kind": "event", "event": "listen-stopped", "source": "mic",
                   "device": "Fake Mic", "error": "input overflow"})
        else:
            heard({"kind": "event", "event": "listen-started", "source": "mic", "device": "Fake Mic"},
                  {"kind": "said", "source": "mouth", "device": "Fake Speakers", "reason": "done"})
            if ears == "hear":
                heard({"kind": "partial", "source": "mic", "device": "Fake Mic", "text": "testing"})
        (HOME / ".voicemode/call").mkdir(parents=True, exist_ok=True)
        (HOME / ".voicemode/call/started").write_text("0")
        print("call up in 1 s: voice=mlx-audio, speaker=Fake Speakers, greeting queued")
    sys.exit(0)

sys.exit(0)
'''

# always faked; pkill, pgrep, open and killall too, so nothing here can reach a real process
ALWAYS = ("codesign", "xcode-select", "swiftc", "curl", "pkill", "pgrep", "open", "killall")


class Ports(BaseHTTPRequestHandler):
    """/mlx-audio, /kokoro, /whisper: 200 while STATE/up-<service> exists, else 503."""
    state: Path | None = None

    def do_GET(self):
        svc = self.path.strip("/").split("/")[0]
        up = Ports.state is not None and (Ports.state / f"up-{svc}").exists()
        self.send_response(200 if up else 503)
        self.end_headers()

    def log_message(self, *a):
        pass


def setUpModule():
    global SERVER, PORT, SRC, TMP_ROOT
    SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Ports)
    PORT = SERVER.server_address[1]
    threading.Thread(target=SERVER.serve_forever, daemon=True).start()
    TMP_ROOT = Path(tempfile.mkdtemp(prefix="cludegods-test-"))
    SRC = TMP_ROOT / "src"   # a clean copy of the repo (no build outputs) to install from
    shutil.copytree(REPO, SRC, ignore=COPY_IGNORE, symlinks=True)


def tearDownModule():
    SERVER.shutdown()
    shutil.rmtree(TMP_ROOT, ignore_errors=True)


def load_cli():
    loader = SourceFileLoader("cludegods_cli", str(CLI))
    mod = module_from_spec(spec_from_loader("cludegods_cli", loader))
    loader.exec_module(mod)
    return mod


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t-", dir=TMP_ROOT))
        self.home = self.tmp / "home"
        self.bin = self.tmp / "bin"
        self.state = self.tmp / "state"
        for d in (self.home, self.bin, self.state):
            d.mkdir()
        self.prog = self.tmp / "fake.py"
        self.prog.write_text(f"#!{sys.executable}\n" + FAKE)
        self.prog.chmod(0o755)
        (self.bin / "python3").symlink_to(sys.executable)
        self.fake(*ALWAYS)
        Ports.state = self.state
        self.env = {
            "HOME": str(self.home), "PATH": f"{self.bin}:{SYSTEM_PATH}", "TMPDIR": str(self.tmp),
            "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8",
            "CLUDEGODS_FALLBACK_PATH": "",
            "FAKE_STATE": str(self.state), "FAKE_BIN": str(self.bin), "FAKE_PROG": str(self.prog),
            "CLUDEGODS_MLX_URL": f"http://127.0.0.1:{PORT}/mlx-audio",
            "CLUDEGODS_KOKORO_URL": f"http://127.0.0.1:{PORT}/kokoro",
            "CLUDEGODS_WHISPER_URL": f"http://127.0.0.1:{PORT}/whisper",
            "CLUDEGODS_WAIT_S": "2", "CLUDEGODS_SERVICE_WAIT_S": "2", "CLUDEGODS_SELFTEST_S": "2",
            "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid",
            "GIT_CONFIG_NOSYSTEM": "1",
        }

    def tearDown(self):
        Ports.state = None
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers

    def fake(self, *names):
        for n in names:
            p = self.bin / n
            if not p.exists():
                p.symlink_to(self.prog)

    def flag(self, *names):
        for n in names:
            (self.state / n).touch()

    def up(self, *svcs):
        for s in svcs:
            (self.state / f"up-{s}").touch()

    def log(self) -> list:
        p = self.state / "log"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def calls(self, name) -> list:
        return [c[1:] for c in self.log() if c[0] == name]

    def run_cmd(self, cmd, env=None, timeout=120, stdin=subprocess.DEVNULL, cwd=None):
        e = dict(self.env, **(env or {}))
        # a new session has no controlling terminal: /dev/tty cannot be opened, as in the pane
        return subprocess.run([str(c) for c in cmd], env=e, stdin=stdin, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, timeout=timeout,
                              start_new_session=True, cwd=cwd)

    def cli(self, *args, **kw):
        return self.run_cmd([sys.executable, CLI, *args], **kw)

    def installed_cli(self, *args, **kw):
        return self.run_cmd([sys.executable, self.home / ".claude/skills/gods/bin/cludegods", *args], **kw)

    def cli_tty(self, args, answers: str, cmd=None):
        """Run with a terminal on stdin, typing `answers` into it."""
        master, slave = os.openpty()
        try:
            os.write(master, answers.encode())
            p = subprocess.run([str(c) for c in (cmd or [sys.executable, CLI, *args])],
                               env=self.env, stdin=slave, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, timeout=120)
        finally:
            os.close(slave)
            os.close(master)
        return p

    def install(self, *flags, src=None, env=None):
        r = self.run_cmd(["bash", (src or SRC) / "install.sh", *flags], env=env, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout)
        return r

    def doctor(self, *extra):
        r = self.cli("doctor", "--json", *extra)
        self.assertEqual(r.returncode, 0, r.stdout)
        return json.loads(r.stdout)

    def checks(self) -> dict:
        return {c["id"]: c for c in self.doctor()["checks"]}

    def voice_files(self, onnx=True, model=True):
        """VoiceMode as `uvx voice-mode-install` leaves it, as fakes."""
        vm = self.home / ".local/share/uv/tools/voice-mode/bin"
        vm.mkdir(parents=True)
        (vm / "python").symlink_to(self.prog)
        (vm / "voicemode").symlink_to(self.prog)
        if onnx:
            self.flag("onnxruntime")
        if model:
            m = self.home / ".voicemode/models/silero_vad.onnx"
            m.parent.mkdir(parents=True)
            m.write_bytes(b"onnx")

    def services_done(self):
        (self.home / ".local/share/uv/tools/mlx-audio").mkdir(parents=True, exist_ok=True)
        for p in ("services/whisper/installed", "services/whisper/models/ggml-large-v3-turbo.bin"):
            f = self.home / ".voicemode" / p
            f.parent.mkdir(parents=True, exist_ok=True)
            f.touch()
        la = self.home / "Library/LaunchAgents"
        la.mkdir(parents=True, exist_ok=True)
        for s in ("whisper", "mlx-audio"):
            (la / f"com.voicemode.{s}.plist").touch()

    def fake_call(self):
        """The call script, as the fake (the real one would start VoiceMode)."""
        call = self.home / ".claude/skills/gods/bin/call"
        call.parent.mkdir(parents=True, exist_ok=True)
        if call.exists():
            call.unlink()
        call.symlink_to(self.prog)

    def write(self, rel, data):
        p = self.home / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(data if isinstance(data, str) else json.dumps(data))
        return p

    def heard(self, *recs, ago_s=0):
        d = self.home / ".voicemode/logs/conversations"
        d.mkdir(parents=True, exist_ok=True)
        t = datetime.now().astimezone() - timedelta(seconds=ago_s)
        with open(d / f"heard_{t.date().isoformat()}.jsonl", "a") as fh:
            for r in recs:
                fh.write(json.dumps({"ts": t.isoformat(timespec="milliseconds"), **r}) + "\n")

    def pill_zip(self) -> Path:
        z = self.tmp / "CallPill-macos.zip"
        with zipfile.ZipFile(z, "w") as zf:
            plist = ('<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
                     '<key>CFBundleIdentifier</key><string>dev.cludegods.callpill</string>'
                     '<key>CFBundleExecutable</key><string>CallPill</string></dict></plist>')
            zf.writestr("CallPill.app/Contents/Info.plist", plist)
            info = zipfile.ZipInfo("CallPill.app/Contents/MacOS/CallPill")
            info.external_attr = 0o100755 << 16
            zf.writestr(info, "#!/bin/sh\nexit 0\n")
        return z


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                          env=dict(os.environ, GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.invalid",
                                   GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.invalid",
                                   GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)).stdout


def make_remote(root: Path) -> Path:
    """A bare git remote holding a copy of this repo (one commit on main)."""
    work = root / "work"
    shutil.copytree(SRC, work, symlinks=True)
    git("init", "-q", "-b", "main", cwd=work)
    git("add", "-A", cwd=work)
    git("commit", "-q", "-m", "CludeGods", cwd=work)
    bare = root / "remote.git"
    git("clone", "-q", "--bare", str(work), str(bare), cwd=root)
    git("remote", "add", "origin", str(bare), cwd=work)
    git("fetch", "-q", "origin", cwd=work)
    git("branch", "-q", "--set-upstream-to=origin/main", cwd=work)
    return bare


# ---------------------------------------------------------------------------------------------

class TestContract(unittest.TestCase):
    def test_embedded_hooks_match_the_example(self):
        example = json.loads((REPO / "config/settings.example.json").read_text())["hooks"]
        self.assertEqual(load_cli().HOOKS, example)

    def test_fix_ids_the_doctor_offers_all_exist(self):
        mod = load_cli()
        src = CLI.read_text()
        import re
        offered = set(re.findall(r'"([a-z]+-[a-z-]+)",\s*"[A-Z][^"]*"\)', src))
        self.assertTrue(offered)
        self.assertLessEqual(offered, set(mod.FIXES), offered - set(mod.FIXES))


class TestDoctor(Base):
    def test_json_shape(self):
        self.install("--skip-pill")
        rep = self.doctor()
        self.assertEqual(set(rep), {"version", "voice_installed", "checks"})
        self.assertIsInstance(rep["version"], str)
        self.assertNotEqual(rep["version"], "")
        self.assertIs(rep["voice_installed"], False)
        ids = [c["id"] for c in rep["checks"]]
        self.assertEqual(len(ids), len(set(ids)))
        for c in rep["checks"]:
            self.assertEqual(set(c), {"id", "label", "ok", "severity", "detail", "fix", "fix_label"})
            self.assertIsInstance(c["ok"], bool)
            self.assertIn(c["severity"], ("error", "warn", "info"))
            self.assertIsInstance(c["label"], str)
            self.assertIsInstance(c["detail"], str)
            if c["ok"]:
                self.assertIsNone(c["fix"])
                self.assertIsNone(c["fix_label"])
            if c["fix"] is not None:
                self.assertIsInstance(c["fix_label"], str)
        for want in ("skills", "hooks", "config", "workers", "panes", "voice", "pill", "worker-chats"):
            self.assertIn(want, ids)
        # voice checks wait until voice is installed
        for hidden in ("vad", "voice-service", "whisper", "mic"):
            self.assertNotIn(hidden, ids)
        c = {c["id"]: c for c in rep["checks"]}
        self.assertTrue(c["skills"]["ok"] and c["hooks"]["ok"] and c["config"]["ok"] and c["workers"]["ok"])
        self.assertEqual((c["voice"]["ok"], c["voice"]["severity"], c["voice"]["fix"], c["voice"]["fix_label"]),
                         (False, "info", "setup-voice", "Enable voice"))

    def test_skills(self):
        c = self.checks()["skills"]
        self.assertEqual((c["ok"], c["severity"], c["fix"]), (False, "error", "reinstall-skills"))
        self.install("--skip-pill")
        self.assertTrue(self.checks()["skills"]["ok"])
        (self.home / ".claude/skills/colleague").mkdir()
        c = self.checks()["skills"]
        self.assertEqual((c["ok"], c["severity"]), (False, "warn"))
        self.assertIn("colleague", c["detail"])
        shutil.rmtree(self.home / ".claude/skills/gods")
        c = self.checks()["skills"]
        self.assertEqual((c["ok"], c["severity"]), (False, "error"))
        self.assertIn("Missing from ~/.claude/skills: gods (the old colleague skill is still there", c["detail"])
        r = self.cli("doctor", "--fix", "reinstall-skills")   # install.sh moves it to gods
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertTrue(self.checks()["skills"]["ok"])
        self.assertFalse((self.home / ".claude/skills/colleague").exists())

    def test_hooks(self):
        c = self.checks()["hooks"]
        self.assertEqual((c["ok"], c["fix"]), (False, "reinstall-hooks"))
        self.write(".claude/settings.json", "{not json")
        c = self.checks()["hooks"]
        self.assertEqual((c["ok"], c["severity"], c["fix"]), (False, "error", None))
        self.assertIn("line 1", c["detail"])
        self.write(".claude/settings.json", {"hooks": {"PreToolUse": [{"hooks": [
            {"type": "command", "command": "$HOME/.claude/skills/gods/bin/narrate"}]}]}})
        c = self.checks()["hooks"]
        self.assertFalse(c["ok"])
        self.assertIn("guard", c["detail"])
        self.assertIn("permit", c["detail"])
        self.assertNotIn("narrate", c["detail"])
        r = self.cli("doctor", "--fix", "reinstall-hooks")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertTrue(self.checks()["hooks"]["ok"])
        # the old colleague paths are pointed at gods
        self.write(".claude/settings.json", {"hooks": {k: v for k, v in load_cli().HOOKS.items()}})
        s = (self.home / ".claude/settings.json").read_text().replace("skills/gods/", "skills/colleague/")
        self.write(".claude/settings.json", s)
        c = self.checks()["hooks"]
        self.assertFalse(c["ok"])
        self.assertEqual(c["detail"], "Still pointing at the old colleague skill: narrate, guard, permit")
        self.assertEqual(self.cli("doctor", "--fix", "reinstall-hooks").returncode, 0)
        self.assertTrue(self.checks()["hooks"]["ok"])
        self.assertNotIn("colleague", (self.home / ".claude/settings.json").read_text())

    def test_config(self):
        c = self.checks()["config"]
        self.assertEqual((c["ok"], c["severity"], c["fix"], c["fix_label"]),
                         (False, "warn", "restore-config", "Create it"))
        self.assertEqual(self.cli("doctor", "--fix", "restore-config").returncode, 0)
        self.assertTrue(self.checks()["config"]["ok"])
        cfg = self.home / ".voicemode/call/config.json"
        self.assertEqual(json.loads(cfg.read_text())["approvals"]["outward"], "spoken")
        self.write(".voicemode/call/config.json", {"approvals": {"outward": "shouted"}})
        c = self.checks()["config"]
        self.assertEqual((c["ok"], c["severity"], c["fix"]), (False, "warn", None))
        self.assertIn("approvals.outward", c["detail"])
        self.write(".voicemode/call/config.json", '{"approvals": ')
        c = self.checks()["config"]
        self.assertEqual((c["ok"], c["severity"], c["fix"]), (False, "error", "reset-config"))
        r = self.cli("doctor", "--fix", "reset-config")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertTrue(self.checks()["config"]["ok"])
        backups = list((self.home / ".claude/cludegods-backups").glob("*/config.json"))
        self.assertEqual([b.read_text() for b in backups], ['{"approvals": '])

    def test_workers(self):
        c = self.checks()["workers"]
        self.assertEqual((c["ok"], c["fix"]), (False, "create-workers"))
        self.assertEqual(self.cli("doctor", "--fix", "create-workers").returncode, 0)
        c = self.checks()["workers"]
        self.assertTrue(c["ok"])
        self.assertEqual(c["detail"], "No workers yet")
        self.write(".voicemode/call/workers.json", "[1, 2")
        c = self.checks()["workers"]
        self.assertEqual((c["ok"], c["severity"], c["fix"]), (False, "error", None))
        self.assertEqual(self.cli("doctor", "--fix", "create-workers").returncode, 1)
        self.assertEqual((self.home / ".voicemode/call/workers.json").read_text(), "[1, 2")
        self.write(".voicemode/call/workers.json", {"workers": [{"key": "a"}, {"key": "a"}, {"name": "x"}]})
        c = self.checks()["workers"]
        self.assertFalse(c["ok"])
        self.assertIn("used twice", c["detail"])
        self.assertIn("entry 3 has no key", c["detail"])

    def test_panes(self):
        c = self.checks()["panes"]
        self.assertEqual((c["ok"], c["severity"], c["fix"]), (False, "warn", None))
        self.assertIn("CLI was not found", c["detail"])
        self.fake("claude")
        c = self.checks()["panes"]
        self.assertEqual((c["ok"], c["severity"], c["fix"]), (False, "error", "install-panes"))
        self.assertIn("workers-pane", c["detail"])
        r = self.cli("doctor", "--fix", "install-panes")
        self.assertEqual(r.returncode, 0, r.stdout)
        claude = self.calls("claude")
        self.assertIn(["plugin", "marketplace", "add", "AKamaly/CludeGods"], claude)
        for p in ("workers-pane", "spaces-pane", "inbox-relay"):
            self.assertIn(["plugin", "install", f"{p}@cludegods"], claude)
        c = self.checks()["panes"]
        self.assertTrue(c["ok"], c)
        # a second run adds nothing
        before = len(self.calls("claude"))
        self.assertEqual(self.cli("doctor", "--fix", "install-panes").returncode, 0)
        self.assertFalse([a for a in self.calls("claude")[before:] if a[:2] == ["plugin", "install"]])
        # turned off counts as not there for the two panes, not for inbox-relay
        st = json.loads((self.state / "claude.json").read_text())
        st["plugins"]["inbox-relay@cludegods"] = False
        (self.state / "claude.json").write_text(json.dumps(st))
        self.assertTrue(self.checks()["panes"]["ok"])
        st["plugins"]["spaces-pane@cludegods"] = False
        (self.state / "claude.json").write_text(json.dumps(st))
        c = self.checks()["panes"]
        self.assertFalse(c["ok"])
        self.assertIn("turned off", c["detail"])
        self.assertEqual(self.cli("doctor", "--fix", "install-panes").returncode, 0)
        self.assertIn(["plugin", "enable", "spaces-pane@cludegods"], self.calls("claude"))

    def test_claude_from_the_app_bundle(self):
        app = self.home / ("Library/Application Support/Claude/claude-code/2.1.9/abc/"
                           "claude.app/Contents/MacOS/claude")
        app.parent.mkdir(parents=True)
        app.symlink_to(self.prog)
        newer = self.home / ("Library/Application Support/Claude/claude-code/2.1.10/def/"
                             "claude.app/Contents/MacOS/claude")
        newer.parent.mkdir(parents=True)
        newer.symlink_to(self.prog)
        c = self.checks()["panes"]
        self.assertEqual(c["fix"], "install-panes")   # found a CLI, so it could list the plugins

    def test_voice_checks(self):
        self.voice_files(onnx=False, model=False)
        rep = self.doctor()
        self.assertIs(rep["voice_installed"], True)
        c = {c["id"]: c for c in rep["checks"]}
        self.assertTrue(c["voice"]["ok"])
        self.assertEqual((c["vad"]["ok"], c["vad"]["fix"]), (False, "setup-vad"))
        self.assertEqual((c["voice-service"]["ok"], c["voice-service"]["fix"], c["voice-service"]["fix_label"]),
                         (False, "restart-voice", "Restart voice"))
        self.assertEqual((c["whisper"]["ok"], c["whisper"]["fix"]), (False, "restart-whisper"))
        self.assertTrue(c["mic"]["ok"])
        self.assertIn("No call yet", c["mic"]["detail"])
        self.assertEqual((c["pill"]["severity"], c["pill"]["fix"]), ("warn", "rebuild-pill"))
        self.fake("uv")
        r = self.cli("doctor", "--fix", "setup-vad")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.up("kokoro", "whisper")
        c = self.checks()
        self.assertTrue(c["vad"]["ok"])
        self.assertTrue(c["voice-service"]["ok"])
        self.assertIn("Kokoro", c["voice-service"]["detail"])
        self.assertTrue(c["whisper"]["ok"])
        self.up("mlx-audio")
        self.assertIn("mlx-audio", self.checks()["voice-service"]["detail"])

    def test_restart_fixes(self):
        self.voice_files()
        self.services_done()
        r = self.cli("doctor", "--fix", "restart-voice")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn(["service", "restart", "mlx-audio"], self.calls("voicemode"))
        r = self.cli("doctor", "--fix", "restart-whisper")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn(["service", "restart", "whisper"], self.calls("voicemode"))
        (self.state / "up-whisper").unlink()
        self.flag("whisper-stays-down")
        r = self.cli("doctor", "--fix", "restart-whisper")
        self.assertEqual(r.returncode, 1)
        self.assertIn("not answering", r.stdout)
        self.assertIn("Next:", r.stdout)

    def test_mic(self):
        self.voice_files()
        self.heard({"kind": "event", "event": "listen-started", "source": "mic", "device": "Desk Mic"},
                   ago_s=300)
        c = self.checks()["mic"]
        self.assertTrue(c["ok"])
        # Not in a call: how an old call went is history, not a problem.
        self.assertIn("Not in a call", c["detail"])
        self.write(".voicemode/call/ears.pid", str(os.getpid()))
        c = self.checks()["mic"]
        self.assertTrue(c["ok"])
        self.assertIn("not heard a turn", c["detail"])
        self.heard({"kind": "turn", "source": "mic", "device": "Desk Mic", "text": "hi"}, ago_s=180)
        c = self.checks()["mic"]
        self.assertTrue(c["ok"])
        self.assertIn("Heard you 3 min ago on Desk Mic", c["detail"])
        self.heard({"kind": "event", "event": "heartbeat", "source": "mic", "device": "Desk Mic",
                    "peak": 0, "rms": 0})
        c = self.checks()["mic"]
        self.assertEqual((c["ok"], c["severity"]), (False, "warn"))
        self.assertIn("Microphone", c["detail"])
        self.heard({"kind": "event", "event": "listen-started", "source": "mic", "device": "Desk Mic"},
                   {"kind": "event", "event": "listen-stopped", "source": "mic", "error": "device lost"})
        c = self.checks()["mic"]
        self.assertFalse(c["ok"])
        self.assertIn("stopped sending sound", c["detail"])
        # Once the call is over and the stop is old, it isn't shown as a problem.
        os.remove(self.home / ".voicemode/call/ears.pid")
        shutil.rmtree(self.home / ".voicemode/logs/conversations")
        self.heard({"kind": "event", "event": "listen-started", "source": "mic", "device": "Desk Mic"},
                   ago_s=7200)
        self.heard({"kind": "event", "event": "listen-stopped", "source": "mic", "error": "device lost"},
                   ago_s=7100)
        c = self.checks()["mic"]
        self.assertTrue(c["ok"], c)

    def test_pill(self):
        c = self.checks()["pill"]
        self.assertEqual((c["ok"], c["severity"], c["fix"]), (False, "info", "rebuild-pill"))
        self.install("--skip-pill")
        r = self.cli("doctor", "--fix", "rebuild-pill")
        self.assertEqual(r.returncode, 1)
        self.assertIn("download failed", r.stdout)
        r = self.cli("doctor", "--fix", "rebuild-pill", env={"FAKE_PILL_ZIP": str(self.pill_zip())})
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("downloaded", r.stdout)
        self.assertTrue(self.checks()["pill"]["ok"])
        sign = self.calls("codesign")[-1]
        self.assertIn("dev.cludegods.callpill", sign)
        self.assertTrue(any("designated" in a for a in sign))

    def test_worker_chats(self):
        self.assertTrue(self.checks()["worker-chats"]["ok"])
        t = self.write(".claude/projects/-Users-you-proj/abc.jsonl", "{}\n")
        self.write(".voicemode/call/workers.json", {"workers": [
            {"key": "a", "name": "Alpha", "session": "local_1", "transcript": "abc.jsonl"},
            {"key": "b", "name": "Beta", "session": "local_2", "transcript": "-Users-you-proj/abc.jsonl"},
            {"key": "c", "name": "Gamma", "session": "local_3", "transcript": str(t)},
        ]})
        c = self.checks()["worker-chats"]
        self.assertTrue(c["ok"], c)
        self.write(".voicemode/call/workers.json", {"workers": [
            {"key": "a", "name": "Alpha", "session": "local_1", "transcript": "abc.jsonl"},
            {"key": "b", "name": "Beta"},
            {"key": "c", "name": "Gamma", "session": "local_3"},
            {"key": "d", "name": "Delta", "session": "local_4", "transcript": "gone.jsonl"},
            {"key": "e", "name": "Echo", "paused": True},
        ]})
        c = self.checks()["worker-chats"]
        self.assertEqual((c["ok"], c["severity"]), (False, "warn"))
        self.assertIn("Beta has no chat yet", c["detail"])
        self.assertIn("Delta's chat can't be found", c["detail"])
        # A worker links its transcript on its first turn, and a paused one isn't expected to run.
        self.assertNotIn("Gamma", c["detail"])
        self.assertNotIn("Echo", c["detail"])
        self.assertNotIn("Alpha", c["detail"])

    def test_human_output(self):
        r = self.cli("doctor")
        self.assertEqual(r.returncode, 1)   # skills and hooks missing: error-level
        self.assertIn("✗ Skills installed", r.stdout)
        self.assertIn("! Voice (VoiceMode)", r.stdout)
        self.assertIn("fix: ~/.claude/skills/gods/bin/cludegods doctor --fix reinstall-skills", r.stdout)
        self.assertNotIn("\033[", r.stdout)
        self.install("--skip-pill")
        r = self.cli("doctor")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("✓ Skills installed", r.stdout)

    def test_fix_dispatch(self):
        r = self.cli("doctor", "--fix", "no-such-fix")
        self.assertEqual(r.returncode, 2)
        self.assertIn("restart-voice", r.stdout)
        # --json with --fix: the repair talks on stderr, stdout is the fresh report
        e = dict(self.env)
        p = subprocess.run([sys.executable, CLI, "doctor", "--json", "--fix", "create-workers"], env=e,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, start_new_session=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        rep = json.loads(p.stdout)
        self.assertTrue({c["id"]: c for c in rep["checks"]}["workers"]["ok"])
        self.assertIn("created an empty workers registry", p.stderr)
        # setup-voice is `setup voice --yes`
        self.fake("brew", "uv", "uvx")
        self.fake_call()
        r = self.cli("doctor", "--fix", "setup-voice")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn(["voice-mode-install", "--yes"], self.calls("uvx"))
        self.assertNotIn(["voice-mode-install", "--dry-run"], self.calls("uvx"))
        # reinstall-skills runs install.sh from the recorded source with the recorded options
        self.install("--skip-pill")
        shutil.rmtree(self.home / ".claude/skills/spaces")
        r = self.cli("doctor", "--fix", "reinstall-skills")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("install.sh --skip-pill", r.stdout)
        self.assertTrue((self.home / ".claude/skills/spaces/SKILL.md").is_file())


class TestSetupVoice(Base):
    def setUp(self):
        super().setUp()
        self.fake_call()

    def test_fresh_then_idempotent(self):
        self.fake("brew")
        r = self.cli("setup", "voice", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout)
        out = r.stdout
        for n in range(1, 7):
            self.assertIn(f"{n}/6 ", out)
        self.assertIn("1/6 Checking Homebrew and uv… done, installed uv", out)
        self.assertIn(["install", "uv"], self.calls("brew"))
        self.assertIn(["voice-mode-install", "--yes"], self.calls("uvx"))
        vm = self.calls("voicemode")
        for want in (["service", "install", "mlx-audio"], ["service", "install", "whisper"],
                     ["whisper", "model", "large-v3-turbo"], ["service", "enable", "whisper"],
                     ["service", "enable", "mlx-audio"]):
            self.assertIn(want, vm)
        self.assertTrue((self.state / "onnxruntime").exists())
        self.assertTrue((self.home / ".voicemode/models/silero_vad.onnx").is_file())
        self.assertIn("5/6 Bluetooth patch… skipped", out)
        self.assertIn("6/6 Self-test", out)
        self.assertIn("heard you on Fake Mic", out)
        self.assertEqual(self.calls("call")[-1], ["stop", "--now"])
        self.assertFalse((self.home / ".voicemode/call/started").exists())   # no receipt for a test
        self.assertIn("--voice", json.loads((self.home / ".voicemode/call/install.json").read_text())["flags"])

        # again: every step finds its work done and installs nothing
        before = len(self.log())
        r = self.cli("setup", "voice", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("1/6 Checking Homebrew and uv… ok", r.stdout)
        self.assertIn("2/6 Installing VoiceMode… ok, already installed", r.stdout)
        self.assertIn("ok, already set up", r.stdout)
        again = self.log()[before:]
        installs = [c for c in again if c[0] in ("brew", "uvx")
                    or (c[0] == "voicemode" and c[1:3] in (["service", "install"], ["service", "enable"]))
                    or (c[0] == "uv" and c[1:3] == ["pip", "install"]) or c[0] == "curl"]
        self.assertEqual(installs, [])

    def test_asks_on_a_terminal(self):
        self.fake("brew")
        r = self.cli_tty(["setup", "voice"], "y\ny\n")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("Install it with Homebrew now", r.stdout)
        self.assertIn("Would install: VoiceMode", r.stdout)   # the dry run comes first
        self.assertIn("Install VoiceMode now?", r.stdout)
        uvx = self.calls("uvx")
        self.assertEqual(uvx[:2], [["voice-mode-install", "--dry-run"], ["voice-mode-install", "--yes"]])

    def test_a_no_stops_the_setup(self):
        self.fake("brew")
        r = self.cli_tty(["setup", "voice"], "n\n")
        self.assertEqual(r.returncode, 1)
        self.assertIn("1/6 Checking Homebrew and uv… failed", r.stdout)
        self.assertIn("Next: brew install uv", r.stdout)
        self.assertEqual(self.calls("brew"), [])

    def test_without_a_terminal_it_needs_yes(self):
        self.fake("uv", "uvx")
        r = self.cli("setup", "voice")
        self.assertEqual(r.returncode, 1)
        self.assertIn("2/6 Installing VoiceMode… failed", r.stdout)
        self.assertIn("no terminal to ask on", r.stdout)
        self.assertIn("setup voice --yes", r.stdout)
        self.assertNotIn(["voice-mode-install", "--yes"], self.calls("uvx"))

    def test_no_homebrew(self):
        r = self.cli("setup", "voice", "--yes")
        self.assertEqual(r.returncode, 1)
        lines = r.stdout.strip().splitlines()
        self.assertIn("1/6 Checking Homebrew and uv… failed", lines[0])
        self.assertIn("Homebrew is not installed", lines[1])
        self.assertIn("Next: install Homebrew from https://brew.sh", lines[2])
        self.assertEqual(len(lines), 3)

    def test_installer_fails(self):
        self.fake("uv", "uvx")
        self.flag("uvx-fails")
        r = self.cli("setup", "voice", "--yes")
        self.assertEqual(r.returncode, 1)
        self.assertIn("2/6 Installing VoiceMode… failed", r.stdout)
        self.assertIn("voice-mode-install: something broke", r.stdout)
        self.assertIn("Next: uvx voice-mode-install --yes", r.stdout)

    def test_service_step_fails(self):
        self.fake("uv", "uvx")
        self.voice_files()
        self.flag("install-whisper-fails")
        r = self.cli("setup", "voice", "--yes")
        self.assertEqual(r.returncode, 1)
        self.assertIn("3/6 Setting up the voice services (mlx-audio, Whisper)… failed", r.stdout)
        self.assertIn("Next: voicemode service install whisper", r.stdout)

    def test_services_that_never_answer(self):
        self.fake("uv", "uvx")
        self.voice_files()
        self.services_done()
        self.flag("mlx-audio-stays-down", "whisper-stays-down")
        r = self.cli("setup", "voice", "--yes")
        self.assertEqual(r.returncode, 1)
        self.assertIn("6/6 Self-test… failed", r.stdout)
        self.assertIn("not answering on 8890 or 8880", r.stdout)
        self.assertIn("doctor --fix restart-voice", r.stdout)

    def test_mic_blocked(self):
        self.fake("uv", "uvx")
        self.voice_files()
        self.services_done()
        self.up("mlx-audio", "whisper")
        r = self.cli("setup", "voice", "--yes", env={"FAKE_EARS": "silent", "FAKE_MIC_PEAK": "0"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("Fake Mic is silent: macOS is blocking the microphone", r.stdout)
        self.assertIn("Privacy & Security, Microphone", r.stdout)
        self.assertIn("Claude", r.stdout)
        # a mic that hears the room but no words passes, with a note
        r = self.cli("setup", "voice", "--yes", env={"FAKE_EARS": "silent", "FAKE_MIC_PEAK": "900"})
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("heard no speech", r.stdout)
        # an ears error is a failure with its reason
        r = self.cli("setup", "voice", "--yes", env={"FAKE_EARS": "error"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("input overflow", r.stdout)

    def test_selftest_skipped_during_a_call(self):
        self.fake("uv", "uvx")
        self.voice_files()
        self.services_done()
        self.up("mlx-audio", "whisper")
        self.write(".voicemode/call/ears.pid", str(os.getpid()))
        r = self.cli("setup", "voice", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("a call is running", r.stdout)
        self.assertEqual(self.calls("call"), [])

    def test_bluetooth_patch(self):
        self.fake("uv", "uvx")
        self.voice_files()
        self.services_done()
        self.up("mlx-audio", "whisper")
        self.install("--skip-pill")   # records the source, where the patch lives
        self.fake_call()
        r = self.cli("setup", "voice", "--yes", "--bluetooth-patch")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("5/6 Bluetooth patch… skipped: the patch does not fit this VoiceMode version", r.stdout)
        flags = json.loads((self.home / ".voicemode/call/install.json").read_text())["flags"]
        self.assertIn("--bluetooth-patch", flags)

    def test_vad_failures(self):
        self.voice_files(onnx=False, model=False)
        r = self.cli("setup", "vad")
        self.assertEqual(r.returncode, 1)
        self.assertIn("uv is missing", r.stdout)
        self.fake("uv")
        self.flag("uv-pip-fails")
        r = self.cli("setup", "vad")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Could not install onnxruntime into VoiceMode's Python (Python 3.12.0)", r.stdout)
        self.assertIn("Next: uv pip install --python", r.stdout)
        (self.state / "uv-pip-fails").unlink()
        self.flag("curl-fails")
        r = self.cli("setup", "vad")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Could not download the Silero VAD model", r.stdout)
        self.assertFalse(list((self.home / ".voicemode/models").glob("*.part")))


class TestInstall(Base):
    def test_lite_install_needs_no_voice_tools(self):
        r = self.install()
        out = r.stdout
        self.assertIn("6. Voice", out)
        self.assertIn("skipped: Workers and Spaces work without voice", out)
        self.assertIn("CallPill not installed: no Swift compiler", out)
        self.assertIn("calls just have no floating card", out)
        self.assertIn("Done. Two steps left", out)
        sk = self.home / ".claude/skills"
        self.assertTrue((sk / "gods/SKILL.md").is_file() and (sk / "spaces/SKILL.md").is_file())
        self.assertTrue(os.access(sk / "gods/bin/cludegods", os.X_OK))
        self.assertTrue((self.home / ".voicemode/call/workers.json").is_file())
        self.assertTrue((self.home / ".voicemode/call/config.json").is_file())
        rec = json.loads((self.home / ".voicemode/call/install.json").read_text())
        self.assertEqual((rec["repo"], rec["flags"]), (str(SRC.resolve()), []))
        names = {c[0] for c in self.log()}
        self.assertFalse(names & {"brew", "uv", "uvx", "voicemode", "python"}, names)
        self.assertTrue(self.checks()["hooks"]["ok"])

    def test_pill_is_downloaded_and_signed(self):
        r = self.install(env={"FAKE_PILL_ZIP": str(self.pill_zip())})
        self.assertIn("downloaded the prebuilt CallPill.app and signed it on this Mac", r.stdout)
        app = self.home / ".claude/skills/gods/bin/CallPill.app"
        self.assertTrue(os.access(app / "Contents/MacOS/CallPill", os.X_OK))
        sign = self.calls("codesign")[-1]
        self.assertEqual(sign[:5], ["-f", "-s", "-", "-i", "dev.cludegods.callpill"])
        # a build where swiftc fails falls back to the download too
        self.flag("xcode")
        r = self.install(env={"FAKE_PILL_ZIP": str(self.pill_zip())})
        self.assertIn("downloaded the prebuilt", r.stdout)

    def test_keeps_what_is_yours(self):
        self.write(".voicemode/call/config.json", {"user_label": "ME"})
        self.write(".voicemode/call/workers.json", {"workers": [{"key": "k"}]})
        mine = {"type": "command", "command": "/usr/local/bin/my-hook"}
        self.write(".claude/settings.json", {"theme": "dark", "hooks": {"PreToolUse": [{"hooks": [mine]}]}})
        r = self.install("--skip-pill")
        self.assertIn("kept your config.json", r.stdout)
        self.assertIn("kept your workers registry", r.stdout)
        self.assertEqual(json.loads((self.home / ".voicemode/call/config.json").read_text()), {"user_label": "ME"})
        s = json.loads((self.home / ".claude/settings.json").read_text())
        self.assertEqual(s["theme"], "dark")
        self.assertEqual(s["hooks"]["PreToolUse"][0]["hooks"], [mine])
        self.assertTrue(list((self.home / ".claude").glob("settings.json.bak-*")))
        r = self.install("--skip-pill")
        self.assertIn("hooks already in place", r.stdout)

    def test_migrates_the_colleague_skill(self):
        old = self.home / ".claude/skills/colleague"
        (old / "bin").mkdir(parents=True)
        (old / "SKILL.md").write_text("old")
        self.write(".claude/settings.json", {"hooks": {"PreToolUse": [{"hooks": [
            {"type": "command", "command": "$HOME/.claude/skills/colleague/bin/guard"}]}]}})
        r = self.install("--skip-pill")
        self.assertIn("moved the old colleague skill", r.stdout)
        self.assertFalse(old.exists())
        self.assertTrue(list((self.home / ".claude/cludegods-backups").glob("*/colleague/SKILL.md")))
        self.assertNotIn("skills/colleague/", (self.home / ".claude/settings.json").read_text())

    def test_voice_flag_runs_the_voice_setup(self):
        self.fake("brew", "uv", "uvx")
        # the self-test would run the call script install.sh just copied in: the real one
        r = self.run_cmd(["bash", SRC / "install.sh", "--voice", "--yes", "--skip-pill"], timeout=300,
                         env={"CLUDEGODS_NO_SELFTEST": "1"})
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("6/6 Self-test… skipped", r.stdout)
        self.assertIn("voice is ready", r.stdout)
        self.assertIn(["voice-mode-install", "--yes"], self.calls("uvx"))
        rec = json.loads((self.home / ".voicemode/call/install.json").read_text())
        self.assertEqual(rec["flags"], ["--voice", "--yes", "--skip-pill"])

    def test_voice_setup_failure_does_not_fail_the_install(self):
        r = self.install("--voice", "--skip-pill")
        self.assertIn("Homebrew is not installed", r.stdout)
        self.assertIn("finish the voice setup", r.stdout)

    def test_existing_voicemode_keeps_its_vad_step(self):
        self.fake("uv")
        self.voice_files(onnx=False, model=False)
        r = self.install("--skip-pill")
        self.assertIn("found VoiceMode", r.stdout)
        self.assertIn("1/1 Adding Silero VAD… done, installed onnxruntime and downloaded the model", r.stdout)
        self.assertFalse(self.calls("uvx"))
        self.assertFalse([c for c in self.calls("voicemode") if c[:2] == ["service", "install"]])

    def test_unknown_option(self):
        r = self.run_cmd(["bash", SRC / "install.sh", "--nope"])
        self.assertEqual(r.returncode, 2)
        self.assertIn("unknown option", r.stdout)


class TestUpdateAndUninstall(Base):
    def test_update(self):
        bare = make_remote(self.tmp)
        src = self.tmp / "checkout"
        git("clone", "-q", str(bare), str(src), cwd=self.tmp)
        self.fake("claude")
        self.install("--skip-pill", src=src)
        self.assertEqual(self.cli("doctor", "--fix", "install-panes").returncode, 0)
        r = self.installed_cli("update")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("Already up to date", r.stdout)
        # a new commit upstream
        work = self.tmp / "work"
        (work / "skills/gods/NEWFILE").write_text("new\n")
        git("add", "-A", cwd=work)
        git("commit", "-q", "-m", "Add a new file", cwd=work)
        git("push", "-q", "origin", "main", cwd=work)
        before = len(self.log())
        r = self.installed_cli("update")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("What changed", r.stdout)
        self.assertIn("Add a new file", r.stdout)
        self.assertIn("install.sh --skip-pill", r.stdout)
        self.assertTrue((self.home / ".claude/skills/gods/NEWFILE").is_file())
        claude = [c[1:] for c in self.log()[before:] if c[0] == "claude"]
        self.assertIn(["plugin", "marketplace", "update", "cludegods"], claude)
        for p in ("workers-pane", "spaces-pane", "inbox-relay"):
            self.assertIn(["plugin", "update", f"{p}@cludegods"], claude)
        self.assertEqual(json.loads((self.home / ".voicemode/call/install.json").read_text())["flags"],
                         ["--skip-pill"])

    def test_update_without_a_source(self):
        self.install("--skip-pill")   # from a plain copy, not a git checkout
        r = self.installed_cli("update")
        self.assertEqual(r.returncode, 1)
        self.assertIn("not a git checkout", r.stdout)
        self.assertIn("Next: run the one-line installer again", r.stdout)

    def _installed_with_panes(self):
        self.fake("claude")
        self.install("--skip-pill")
        self.assertEqual(self.cli("doctor", "--fix", "install-panes").returncode, 0)
        s = json.loads((self.home / ".claude/settings.json").read_text())
        s["hooks"]["PreToolUse"].append({"hooks": [{"type": "command", "command": "/opt/mine/hook"}]})
        s["model"] = "x"
        self.write(".claude/settings.json", s)
        self.write(".voicemode/call/spaces/notes/space.json", {"name": "Notes"})

    def test_uninstall_yes(self):
        self._installed_with_panes()
        r = self.installed_cli("uninstall", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertFalse((self.home / ".claude/skills/gods").exists())
        self.assertFalse((self.home / ".claude/skills/spaces").exists())
        self.assertFalse((self.home / ".voicemode/call").exists())
        s = json.loads((self.home / ".claude/settings.json").read_text())
        self.assertEqual(s, {"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "/opt/mine/hook"}]}]},
                             "model": "x"})
        claude = self.calls("claude")
        for p in ("workers-pane", "spaces-pane", "inbox-relay"):
            self.assertIn(["plugin", "uninstall", f"{p}@cludegods"], claude)
        self.assertIn(["plugin", "marketplace", "remove", "cludegods"], claude)
        backup = next((self.home / ".claude/cludegods-backups").glob("*-uninstall"))
        self.assertTrue((backup / "skills/gods/SKILL.md").is_file())
        self.assertTrue((backup / "call/spaces/notes/space.json").is_file())
        self.assertIn("narrate", (backup / "settings.json").read_text())

    def test_uninstall_keep_data(self):
        self._installed_with_panes()
        r = self.installed_cli("uninstall", "--keep-data")   # no confirmation needed
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertFalse((self.home / ".claude/skills/gods").exists())
        self.assertTrue((self.home / ".voicemode/call/spaces/notes/space.json").is_file())
        self.assertFalse(our_hooks_left(self.home))

    def test_uninstall_needs_a_typed_yes(self):
        self._installed_with_panes()
        r = self.installed_cli("uninstall")
        self.assertEqual(r.returncode, 1)
        self.assertIn("nothing was removed", r.stdout)
        self.assertTrue((self.home / ".claude/skills/gods").exists())
        r = self.cli_tty([], "no\n", cmd=[sys.executable, self.home / ".claude/skills/gods/bin/cludegods", "uninstall"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("Nothing removed", r.stdout)
        self.assertTrue((self.home / ".voicemode/call").exists())
        r = self.cli_tty([], "delete\n", cmd=["bash", SRC / "uninstall.sh"])
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertFalse((self.home / ".voicemode/call").exists())
        self.assertFalse((self.home / ".claude/skills/gods").exists())


def our_hooks_left(home: Path) -> bool:
    return "skills/gods/bin" in (home / ".claude/settings.json").read_text()


class TestBootstrap(Base):
    def test_bootstrap_and_rerun(self):
        bare = make_remote(self.tmp)
        self.fake("claude")
        env = {"CLUDEGODS_REPO_URL": f"file://{bare}"}
        script = (REPO / "bootstrap.sh").read_bytes()
        # as `curl ... | bash -s -- --skip-pill`: the script arrives on stdin
        r = subprocess.run(["bash", "-s", "--", "--skip-pill"], input=script, env=dict(self.env, **env),
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300,
                           start_new_session=True)
        out = r.stdout.decode()
        self.assertEqual(r.returncode, 0, out)
        src = self.home / ".cludegods/src"
        self.assertTrue((src / ".git").is_dir())
        self.assertTrue((self.home / ".claude/skills/gods/bin/cludegods").is_file())
        claude = self.calls("claude")
        self.assertIn(["plugin", "marketplace", "add", "AKamaly/CludeGods"], claude)
        for p in ("workers-pane", "spaces-pane", "inbox-relay"):
            self.assertIn(["plugin", "install", f"{p}@cludegods"], claude)
        self.assertIn("✓ Workers and Spaces panes", out)          # the doctor ran
        self.assertNotIn("Done. Two steps left", out)              # install.sh's own ending is quiet
        tail = out.strip().splitlines()[-3:]
        self.assertEqual([l.strip() for l in tail], [
            "Next",
            "1. Restart the Claude app (quit it fully, then open it again).",
            "2. Type /gods in any chat."])
        rec = json.loads((self.home / ".voicemode/call/install.json").read_text())
        self.assertEqual((rec["repo"], rec["flags"]), (str(src.resolve()), ["--skip-pill"]))

        # again: pulls, reinstalls, installs no pane twice
        before = len(self.log())
        r = self.run_cmd(["bash", REPO / "bootstrap.sh", "--skip-pill"], env=env, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("updated", r.stdout)
        again = [c[1:] for c in self.log()[before:] if c[0] == "claude"]
        self.assertFalse([c for c in again if c[:2] == ["plugin", "install"]])
        self.assertIn("2. Type /gods in any chat.", r.stdout)

    def test_bootstrap_bad_url(self):
        r = self.run_cmd(["bash", REPO / "bootstrap.sh"], env={"CLUDEGODS_REPO_URL": f"file://{self.tmp}/none.git"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("could not clone", r.stdout)


class TestVersion(Base):
    def test_version(self):
        r = self.cli("version")
        self.assertEqual(r.returncode, 0)
        self.assertRegex(r.stdout, r"^cludegods \S+\n$")
        self.install("--skip-pill")
        r = self.installed_cli("version")
        self.assertRegex(r.stdout, r"^cludegods \d+\.\d+\.\d+")   # CHANGELOG's, the copy has no git


if __name__ == "__main__":
    unittest.main()
