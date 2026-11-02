"""bin/reply and bin/bridge, run as a worker would, against a throwaway HOME.

  python3 -B -m unittest discover -s ~/.claude/skills/gods/bridges/slack/tests -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import slack_bridge as sb  # noqa: E402

BIN = Path(__file__).resolve().parents[3] / "bin"
REPLY = BIN / "reply"
BRIDGE = BIN / "bridge"

LINE = {
    "id": "in_00112233aabb", "at": "2026-11-01T17:00:00+03:00", "source": "slack",
    "from": "Owner", "channel": "general", "thread": "1000.0001", "text": "status?",
    "delivered": False, "worker": "scout", "user": "U0OWNER1", "channel_id": "C0GENRL1",
    "ts": "1000.0001", "dm": False,
}


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.call = self.home / ".voicemode" / "call"
        (self.call / "inbox").mkdir(parents=True)
        (self.call / "inbox" / "scout.jsonl").write_text(
            "not json\n" + json.dumps(LINE) + "\n" + json.dumps({**LINE, "id": "in_ffffffffffff", "dm": True}) + "\n"
        )
        env = {k: v for k, v in os.environ.items() if not k.startswith("SLACK_")}
        self.env = {**env, "HOME": str(self.home)}

    def tearDown(self):
        self.tmp.cleanup()

    def run_(self, argv, stdin=None, env=None):
        return subprocess.run([str(a) for a in argv], input=stdin, capture_output=True, text=True,
                              env=env or self.env, timeout=60)

    def replies(self):
        d = self.call / "replies"
        return sorted(p.name for p in d.iterdir()) if d.exists() else []


class Reply(Cli):
    def test_a_known_id_queues_one_file_for_the_bridge(self):
        r = self.run_([REPLY, "in_00112233aabb", "Nothing changed on the pricing page."])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("queued: reply to Owner in #general (in_00112233aabb)", r.stdout)
        self.assertIn("the Slack bridge is stopped", r.stdout)
        self.assertEqual(self.replies(), ["in_00112233aabb.json"])
        body = json.loads((self.call / "replies" / "in_00112233aabb.json").read_text())
        self.assertEqual(body["id"], "in_00112233aabb")
        self.assertEqual(body["text"], "Nothing changed on the pricing page.")
        self.assertEqual(body["by"], "scout")
        mode = (self.call / "replies" / "in_00112233aabb.json").stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_text_from_stdin_and_a_second_reply_never_overwrites_the_first(self):
        a = self.run_([REPLY, "in_ffffffffffff"], stdin="# Notes\n\n- one\n- two\n")
        b = self.run_([REPLY, "in_ffffffffffff", "-"], stdin="and a follow-up")
        self.assertEqual((a.returncode, b.returncode), (0, 0), a.stderr + b.stderr)
        self.assertIn("in a direct message", a.stdout)
        self.assertEqual(self.replies(), ["in_ffffffffffff.2.json", "in_ffffffffffff.json"])
        first = json.loads((self.call / "replies" / "in_ffffffffffff.json").read_text())
        self.assertEqual(first["text"], "# Notes\n\n- one\n- two")

    def test_unknown_or_malformed_ids_and_empty_text_are_refused(self):
        r = self.run_([REPLY, "in_999999999999", "hi"])
        self.assertEqual(r.returncode, 3)
        self.assertIn("unknown id", r.stderr)
        r = self.run_([REPLY, "../../etc/passwd", "hi"])
        self.assertEqual(r.returncode, 2)
        r = self.run_([REPLY, "in_00112233aabb", "   "])
        self.assertEqual(r.returncode, 2)
        r = self.run_([REPLY, "in_00112233aabb"], stdin="")
        self.assertEqual(r.returncode, 2)
        r = self.run_([REPLY])
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.replies(), [])


class RoundTrip(Cli):
    """The bridge writes the inbox, a worker runs bin/reply, the bridge posts into the thread."""

    def test_mention_to_reply_to_thread_post(self):
        class Web:
            posts, reactions = [], []

            def reactions_add(self, **kw):
                self.reactions.append(kw)

            def chat_postMessage(self, **kw):
                self.posts.append(kw)

        cfg = sb.parse_config({"allow_users": {"U0OWNER1": "Owner"}, "allow_channels": {"C0GENRL1": "general"},
                               "default_worker": "scout"})
        web = Web()
        bridge = sb.Bridge(cfg, web, sb.Paths(self.call), "UBOT0001", "T0TEAM01", sleep=lambda s: None)
        event = {"type": "app_mention", "user": "U0OWNER1", "text": "<@UBOT0001> anything new?",
                 "ts": "1500.0001", "channel": "C0GENRL1", "team": "T0TEAM01"}
        iid = bridge.handle_event(event, "T0TEAM01")
        r = self.run_([REPLY, iid], stdin="Two pages changed:\n\n- **pricing**\n- docs\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(bridge.flush_replies(), 1)
        self.assertEqual(web.posts, [{
            "channel": "C0GENRL1", "thread_ts": "1500.0001", "text": "Two pages changed:\n\n• *pricing*\n• docs",
            "mrkdwn": True, "unfurl_links": False, "unfurl_media": False,
        }])
        self.assertEqual(self.replies(), [])


class Bridge(Cli):
    def test_status_with_no_config_is_a_clean_not_configured(self):
        r = self.run_([BRIDGE, "status"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[0], "slack: not configured")
        self.assertIn("no ~/.voicemode/call/slack.json yet", r.stdout)
        self.assertEqual(r.stderr, "")

    def test_status_names_a_bad_config(self):
        (self.call / "slack.json").write_text(json.dumps({"allow_users": ["nobody"]}))
        r = self.run_([BRIDGE, "status", "slack"])
        self.assertEqual(r.stdout.splitlines()[0], "slack: not configured")
        self.assertIn("'nobody' is not a Slack id", r.stdout)

    def test_status_with_config_but_no_tokens_says_so(self):
        (self.call / "slack.json").write_text(json.dumps({"allow_users": ["U0OWNER1"], "default_worker": "scout"}))
        r = self.run_([BRIDGE, "status"])
        self.assertEqual(r.stdout.splitlines()[0], "slack: not configured")
        self.assertIn("no bot token and app token", r.stdout)

    def test_status_with_config_and_tokens_is_stopped_and_never_prints_them(self):
        (self.call / "slack.json").write_text(json.dumps({"allow_users": ["U0OWNER1"], "default_worker": "scout"}))
        env = {**self.env, "SLACK_BOT_TOKEN": "xoxb-not-real", "SLACK_APP_TOKEN": "xapp-not-real"}
        r = self.run_([BRIDGE, "status"], env=env)
        self.assertEqual(r.stdout.splitlines()[0],
                         "slack: stopped (1 user, 0 channels, DMs on, default worker scout)")
        self.assertNotIn("xoxb", r.stdout + r.stderr)

    def test_status_after_a_failed_run_shows_its_last_error(self):
        (self.call / "slack.json").write_text(json.dumps({"allow_users": ["U0OWNER1"]}))
        (self.call / "slack-bridge.state").write_text(json.dumps(
            {"state": "error", "detail": "auth.test failed: SlackApiError (invalid_auth)", "since": 1.0, "pid": 1}))
        env = {**self.env, "SLACK_BOT_TOKEN": "xoxb-not-real", "SLACK_APP_TOKEN": "xapp-not-real"}
        r = self.run_([BRIDGE, "status"], env=env)
        self.assertEqual(r.stdout.splitlines()[0],
                         "slack: not running, last error: auth.test failed: SlackApiError (invalid_auth)")

    def test_status_while_running_reads_the_daemon_state(self):
        (self.call / "slack.json").write_text(json.dumps({"allow_users": ["U0OWNER1"]}))
        (self.call / "slack-bridge.pid").write_text(f"{os.getpid()}\n")  # any live pid stands in
        (self.call / "slack-bridge.state").write_text(json.dumps({"state": "connected", "since": 1_800_000_000.0}))
        env = {**self.env, "SLACK_BOT_TOKEN": "xoxb-not-real", "SLACK_APP_TOKEN": "xapp-not-real"}
        r = self.run_([BRIDGE, "status"], env=env)
        self.assertRegex(r.stdout.splitlines()[0], rf"^slack: connected since \d\d:\d\d \(pid {os.getpid()}\)$")

    def test_start_without_config_refuses_and_installs_nothing(self):
        r = self.run_([BRIDGE, "start"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("not configured", r.stdout)
        self.assertFalse((self.home / ".voicemode" / "venvs").exists())
        self.assertFalse((self.call / "slack-bridge.pid").exists())

    def test_teams_is_not_supported_yet(self):
        r = self.run_([BRIDGE, "status", "teams"])
        self.assertEqual(r.returncode, 2)
        self.assertIn("teams: not supported yet", r.stdout)

    def test_stop_when_not_running(self):
        r = self.run_([BRIDGE, "stop"])
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "slack: stopped")


if __name__ == "__main__":
    unittest.main()
