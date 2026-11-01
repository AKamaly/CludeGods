"""Slack bridge tests against a fake Slack client and socket; nothing reaches Slack.

  python3 -B -m unittest discover -s ~/.claude/skills/colleague/bridges/slack/tests -v
"""
import json
import logging
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import slack_bridge as sb  # noqa: E402

BOT = "UBOT0001"
TEAM = "T0TEAM01"
OWNER = "U0OWNER1"
FRIEND = "U0FRIEND"
STRANGER = "U0STRANG"
GENERAL = "C0GENRL1"
SCOUTS = "C0SCOUT1"
CLOSED = "C0CLOSED"  # the bot is there, the channel is not allowed
DM = "D0DIRECT1"


class SlackApiError(Exception):
    """Shaped like slack_sdk's: a message that may hold anything, and a response."""

    def __init__(self, code, retry_after=None):
        super().__init__(f"The request failed: token xoxb-0000-SECRET and body text {code}")
        self.response = _Resp(code, retry_after)


class _Resp(dict):
    def __init__(self, code, retry_after):
        super().__init__(ok=False, error=code)
        self.headers = {"Retry-After": str(retry_after)} if retry_after else {}


class FakeWeb:
    def __init__(self):
        self.posts = []
        self.reactions = []
        self.fail = []  # exceptions raised by the next chat_postMessage calls, in order

    def reactions_add(self, channel, timestamp, name):
        self.reactions.append((channel, timestamp, name))
        return {"ok": True}

    def chat_postMessage(self, **kw):
        if self.fail:
            raise self.fail.pop(0)
        self.posts.append(kw)
        return {"ok": True, "ts": f"{2000 + len(self.posts)}.0"}

    def auth_test(self):
        return {"ok": True, "user_id": BOT, "team_id": TEAM}


class Records(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


CONFIG = {
    "team": TEAM,
    "allow_users": {OWNER: "Owner", FRIEND: "Friend"},
    "allow_channels": {GENERAL: "general", SCOUTS: "scouting"},
    "allow_dms": True,
    "default_worker": "scribe",
    "routes": {"write": "scribe", SCOUTS: "scout", "dm": "sales"},
}
WORKERS = {
    "workers": [
        {"key": "scribe", "name": "Scribe", "session": "local_a"},
        {"key": "scout", "name": "Scout", "session": "local_b"},
        {"key": "sales", "name": "Sales", "session": "local_c"},
        {"key": "research", "name": "Reader", "session": "local_d"},
    ]
}


def mention(text, ts="1000.0001", user=OWNER, channel=GENERAL, thread_ts=None, **extra):
    e = {"type": "app_mention", "user": user, "text": f"<@{BOT}> {text}", "ts": ts,
         "channel": channel, "team": TEAM, "event_ts": ts}
    if thread_ts:
        e["thread_ts"] = thread_ts
    e.update(extra)
    return e


def message(text, ts, user=OWNER, channel=GENERAL, thread_ts=None, channel_type="channel", **extra):
    e = {"type": "message", "user": user, "text": text, "ts": ts, "channel": channel,
         "channel_type": channel_type, "team": TEAM, "event_ts": ts}
    if thread_ts:
        e["thread_ts"] = thread_ts
    e.update(extra)
    return e


def dm(text, ts, user=OWNER, thread_ts=None):
    return message(text, ts, user=user, channel=DM, thread_ts=thread_ts, channel_type="im")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.call = Path(self.tmp.name)
        (self.call / "workers.json").write_text(json.dumps(WORKERS))
        self.paths = sb.Paths(self.call)
        self.t = 1_800_000_000.0
        self.sleeps = []
        self.web = FakeWeb()
        self.log = Records()
        sb.LOG.addHandler(self.log)
        sb.LOG.setLevel(logging.INFO)
        self.cfg = sb.parse_config(CONFIG)
        self.bridge = self.make()

    def tearDown(self):
        sb.LOG.removeHandler(self.log)
        self.tmp.cleanup()

    def make(self, cfg=None):
        return sb.Bridge(cfg or self.cfg, self.web, self.paths, BOT, TEAM,
                         now=lambda: self.t, sleep=self.sleeps.append)

    def inbox(self, key):
        p = self.call / "inbox" / f"{key}.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []

    def all_inbox(self):
        d = self.call / "inbox"
        return sorted(p.name for p in d.glob("*.jsonl")) if d.exists() else []

    def reply(self, iid, text, name=None, **extra):
        d = self.call / "replies"
        d.mkdir(exist_ok=True)
        p = d / (name or f"{iid}.json")
        p.write_text(json.dumps({"id": iid, "text": text, **extra}))
        return p

    def dropped(self, reason):
        return [line for line in self.log.lines if line.startswith(f"drop ({reason})")]


class AllowList(Base):
    def test_allowed_mention_writes_the_spec_line_and_reacts(self):
        iid = self.bridge.handle_event(mention("draft the release notes"), TEAM)
        self.assertRegex(iid, r"^in_[0-9a-f]{12}$")
        [line] = self.inbox("scribe")
        for field in ("id", "at", "source", "from", "channel", "thread", "text", "delivered"):
            self.assertIn(field, line)
        self.assertEqual(line["id"], iid)
        self.assertEqual(line["source"], "slack")
        self.assertEqual(line["from"], "Owner")
        self.assertEqual(line["channel"], "general")
        self.assertEqual(line["thread"], "1000.0001")
        self.assertEqual(line["text"], "draft the release notes")
        self.assertIs(line["delivered"], False)
        self.assertIs(line["dm"], False)
        self.assertEqual(self.web.reactions, [(GENERAL, "1000.0001", "eyes")])
        mode = (self.call / "inbox" / "scribe.jsonl").stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_a_user_not_on_the_list_is_dropped_and_logged_without_its_text(self):
        self.assertIsNone(self.bridge.handle_event(mention("secret plan", user=STRANGER), TEAM))
        self.assertEqual(self.all_inbox(), [])
        self.assertEqual(self.web.reactions, [])
        [line] = self.dropped("user not allowed")
        self.assertIn(STRANGER, line)
        self.assertNotIn("secret plan", "\n".join(self.log.lines))

    def test_an_allowed_user_in_a_channel_not_on_the_list_is_dropped(self):
        self.assertIsNone(self.bridge.handle_event(mention("hello", channel=CLOSED), TEAM))
        self.assertEqual(self.all_inbox(), [])
        self.assertEqual(len(self.dropped("channel not allowed")), 1)

    def test_bots_edits_deletes_joins_and_its_own_messages_are_dropped(self):
        events = [
            mention("hi", bot_id="B01"),
            mention("hi", subtype="bot_message"),
            message(f"<@{BOT}> hi", "1.1", subtype="message_changed"),
            message(f"<@{BOT}> hi", "1.2", subtype="message_deleted"),
            message(f"<@{BOT}> hi", "1.3", subtype="channel_join"),
            mention("hi", user=BOT),
            {"type": "reaction_added", "user": OWNER},
            {"type": "app_mention", "user": OWNER},  # no channel, no ts
        ]
        for e in events:
            self.assertIsNone(self.bridge.handle_event(e, TEAM))
        self.assertEqual(self.all_inbox(), [])
        self.assertEqual(self.web.reactions, [])
        self.assertEqual(len(self.log.lines), len(events))

    def test_another_workspace_is_dropped_when_team_is_set(self):
        self.assertIsNone(self.bridge.handle_event(mention("hi", team="T0OTHER1", user_team="T0OTHER1"), "T0OTHER1"))
        self.assertEqual(len(self.dropped("other workspace")), 1)

    def test_dms_from_allowed_users_go_through_and_can_be_switched_off(self):
        iid = self.bridge.handle_event(dm("how are the follow-ups", "1100.0001"), TEAM)
        [line] = self.inbox("sales")  # routes["dm"]
        self.assertEqual(line["id"], iid)
        self.assertIs(line["dm"], True)
        self.assertEqual(line["channel"], "dm")
        self.assertIsNone(self.bridge.handle_event(dm("hi", "1100.0002", user=STRANGER), TEAM))
        off = sb.parse_config({**CONFIG, "allow_dms": False})
        bridge = self.make(off)
        self.assertIsNone(bridge.handle_event(dm("hi", "1100.0003"), TEAM))
        self.assertEqual(len(self.dropped("DMs are off")), 1)

    def test_plain_channel_chatter_is_not_addressed_to_the_bot(self):
        self.assertIsNone(self.bridge.handle_event(message("lunch?", "1200.0001"), TEAM))
        self.assertEqual(len(self.dropped("not addressed to the bot")), 1)
        self.assertEqual(self.all_inbox(), [])

    def test_the_same_message_twice_is_written_once(self):
        # app_mention and message.channels both fire for one mention; Slack also redelivers.
        a = self.bridge.handle_event(mention("once", ts="1300.0001"), TEAM)
        b = self.bridge.handle_event(message(f"<@{BOT}> once", "1300.0001"), TEAM)
        c = self.bridge.handle_event(mention("once", ts="1300.0001"), TEAM)
        self.assertIsNotNone(a)
        self.assertIsNone(b)
        self.assertIsNone(c)
        self.assertEqual(len(self.inbox("scribe")), 1)
        self.assertEqual(len(self.web.reactions), 1)


class Routing(Base):
    def test_a_leading_word_picks_the_worker_and_leaves_the_text(self):
        self.bridge.handle_event(mention("scout: watch the competitor pricing page", ts="2.1"), TEAM)
        self.bridge.handle_event(mention("write a short changelog", ts="2.2"), TEAM)  # a route word
        self.bridge.handle_event(mention("Reader find the paper", ts="2.3"), TEAM)  # a worker's name
        self.bridge.handle_event(mention("sales, any replies today?", ts="2.4"), TEAM)
        self.assertEqual([x["text"] for x in self.inbox("scout")], ["watch the competitor pricing page"])
        self.assertEqual([x["text"] for x in self.inbox("scribe")], ["a short changelog"])
        self.assertEqual([x["text"] for x in self.inbox("research")], ["find the paper"])
        self.assertEqual([x["text"] for x in self.inbox("sales")], ["any replies today?"])

    def test_a_channel_route_then_the_default(self):
        self.bridge.handle_event(mention("anything new?", channel=SCOUTS, ts="3.1"), TEAM)
        self.bridge.handle_event(mention("please tidy this", ts="3.2"), TEAM)
        self.assertEqual([x["text"] for x in self.inbox("scout")], ["anything new?"])
        self.assertEqual([x["text"] for x in self.inbox("scribe")], ["please tidy this"])

    def test_no_default_and_no_route_drops_it(self):
        cfg = sb.parse_config({k: v for k, v in CONFIG.items() if k not in ("default_worker", "routes")})
        bridge = self.make(cfg)
        self.assertIsNone(bridge.handle_event(mention("tidy this", ts="3.3"), TEAM))
        self.assertTrue(any("no worker" in x for x in self.log.lines))

    def test_slack_markup_is_made_readable(self):
        text = (f"<@{FRIEND}> asked about <#{SCOUTS}|scouting>, see <https://example.com/a|the doc> "
                "and <https://example.com/b> &amp; 1 &lt; 2")
        self.bridge.handle_event(mention(text, ts="3.4"), TEAM)
        [line] = self.inbox("scribe")
        self.assertEqual(line["text"], "@Friend asked about #scouting, see the doc (https://example.com/a) "
                                       "and https://example.com/b & 1 < 2")

    def test_attached_files_are_noted(self):
        self.bridge.handle_event(mention("look at this", ts="3.5", files=[{"id": "F1"}, {"id": "F2"}]), TEAM)
        self.assertEqual(self.inbox("scribe")[0]["text"], "look at this\n\n(2 attached files not shown)")
        # a DM with a file arrives as subtype file_share: still a person's message
        self.bridge.handle_event({**dm("scribe this one", "3.6"), "subtype": "file_share", "files": [{"id": "F3"}]}, TEAM)
        self.assertEqual(self.inbox("scribe")[1]["text"], "this one\n\n(1 attached file not shown)")


class Threads(Base):
    def test_a_thread_reply_stays_with_its_worker_without_a_mention(self):
        first = self.bridge.handle_event(mention("scout watch the launch", ts="4000.0001"), TEAM)
        # "sales" leads the follow-up, but a known thread keeps its worker.
        again = self.bridge.handle_event(message("sales numbers too please", "4000.0002", thread_ts="4000.0001"), TEAM)
        friend = self.bridge.handle_event(message("and the docs", "4000.0003", user=FRIEND, thread_ts="4000.0001"), TEAM)
        self.assertIsNotNone(first)
        self.assertIsNotNone(again)
        self.assertIsNotNone(friend)
        lines = self.inbox("scout")
        self.assertEqual([x["text"] for x in lines], ["watch the launch", "sales numbers too please", "and the docs"])
        self.assertEqual({x["thread"] for x in lines}, {"4000.0001"})
        self.assertEqual(self.inbox("sales"), [])

    def test_a_stranger_in_a_known_thread_is_dropped(self):
        self.bridge.handle_event(mention("start", ts="4100.0001"), TEAM)
        self.assertIsNone(self.bridge.handle_event(message("me too", "4100.0002", user=STRANGER, thread_ts="4100.0001"), TEAM))
        self.assertEqual(len(self.inbox("scribe")), 1)

    def test_an_unknown_thread_needs_a_mention_and_then_becomes_known(self):
        self.assertIsNone(self.bridge.handle_event(message("hm", "4200.0002", thread_ts="4200.0001"), TEAM))
        iid = self.bridge.handle_event(mention("scout help here", ts="4200.0003", thread_ts="4200.0001"), TEAM)
        self.assertIsNotNone(iid)
        self.assertEqual(self.inbox("scout")[0]["thread"], "4200.0001")
        self.assertIsNotNone(self.bridge.handle_event(message("more", "4200.0004", thread_ts="4200.0001"), TEAM))
        self.assertEqual(len(self.inbox("scout")), 2)

    def test_threads_survive_a_restart(self):
        self.bridge.handle_event(mention("scout keep an eye", ts="4300.0001"), TEAM)
        restarted = self.make()
        self.assertIsNotNone(restarted.handle_event(message("still there?", "4300.0002", thread_ts="4300.0001"), TEAM))
        self.assertEqual(len(self.inbox("scout")), 2)

    def test_dm_threads_continue_too(self):
        self.bridge.handle_event(dm("scribe a note on pricing", "4400.0001"), TEAM)
        self.bridge.handle_event(dm("shorter", "4400.0002", thread_ts="4400.0001"), TEAM)
        self.assertEqual([x["text"] for x in self.inbox("scribe")], ["a note on pricing", "shorter"])


class Replies(Base):
    def test_a_reply_goes_into_its_thread_then_the_file_is_gone(self):
        iid = self.bridge.handle_event(mention("scout status?", ts="5000.0001"), TEAM)
        p = self.reply(iid, "All quiet. **Two** pages changed.")
        self.assertEqual(self.bridge.flush_replies(), 1)
        [post] = self.web.posts
        self.assertEqual(post["channel"], GENERAL)
        self.assertEqual(post["thread_ts"], "5000.0001")
        self.assertEqual(post["text"], "All quiet. *Two* pages changed.")
        self.assertFalse(p.exists())

    def test_a_reply_in_a_continued_thread_goes_to_the_thread_root(self):
        self.bridge.handle_event(mention("start", ts="5050.0001"), TEAM)
        iid = self.bridge.handle_event(message("next", "5050.0002", thread_ts="5050.0001"), TEAM)
        self.reply(iid, "ok")
        self.bridge.flush_replies()
        self.assertEqual(self.web.posts[0]["thread_ts"], "5050.0001")

    def test_an_unknown_id_is_refused_moved_aside_and_logged(self):
        p = self.reply("in_0123456789ab", "hello")
        bad = self.reply("../../etc", "x", name="bad.json")
        self.assertEqual(self.bridge.flush_replies(), 0)
        self.assertEqual(self.web.posts, [])
        self.assertFalse(p.exists())
        self.assertFalse(bad.exists())
        refused = sorted(x.name for x in (self.call / "replies" / ".refused").iterdir())
        self.assertEqual(len(refused), 2)
        self.assertTrue(any("not from an allowed Slack message" in x for x in self.log.lines))
        self.assertTrue(any("no valid inbox id" in x for x in self.log.lines))

    def test_a_reply_cannot_redirect_itself(self):
        iid = self.bridge.handle_event(mention("hi", ts="5100.0001"), TEAM)
        self.reply(iid, "here", channel=CLOSED, thread="9.9", thread_ts="9.9")
        self.bridge.flush_replies()
        [post] = self.web.posts
        self.assertEqual((post["channel"], post["thread_ts"]), (GENERAL, "5100.0001"))

    def test_a_channel_taken_off_the_list_gets_no_more_replies(self):
        iid = self.bridge.handle_event(mention("hi", ts="5200.0001"), TEAM)
        narrowed = sb.parse_config({**CONFIG, "allow_channels": {SCOUTS: "scouting"}})
        bridge = self.make(narrowed)
        self.reply(iid, "late answer")
        self.assertEqual(bridge.flush_replies(), 0)
        self.assertEqual(self.web.posts, [])
        self.assertTrue(any("no longer allowed" in x for x in self.log.lines))

    def test_bad_files_are_refused(self):
        d = self.call / "replies"
        d.mkdir()
        (d / "junk.json").write_text("{not json")
        (d / "list.json").write_text("[1, 2]")
        iid = self.bridge.handle_event(mention("hi", ts="5300.0001"), TEAM)
        self.reply(iid, "   ")
        (d / ".hidden.json").write_text("{}")  # a CLI temp file is never read
        (d / "notes.txt").write_text("x")
        self.bridge.flush_replies()
        self.assertEqual(self.web.posts, [])
        self.assertEqual(len(list((d / ".refused").iterdir())), 3)
        self.assertTrue((d / ".hidden.json").exists())
        self.assertTrue((d / "notes.txt").exists())

    def test_a_long_reply_is_posted_in_order_in_pieces_under_the_limit(self):
        iid = self.bridge.handle_event(mention("write it all", ts="5400.0001"), TEAM)
        paras = [f"Paragraph {i}. " + ("word " * 150).strip() for i in range(30)]
        code = "```python\n" + "\n".join(f"line_{i} = {i}  # <tag>" for i in range(400)) + "\n```"
        self.reply(iid, "\n\n".join(paras) + "\n\n" + code + "\n\nThe end.")
        self.assertEqual(self.bridge.flush_replies(), 1)
        texts = [p["text"] for p in self.web.posts]
        self.assertGreater(len(texts), 3)
        for t in texts:
            self.assertLessEqual(len(t), sb.CHUNK)
            self.assertEqual(t.count("```") % 2, 0, "every piece opens and closes its code blocks")
        joined = "\n".join(texts)
        self.assertTrue(joined.startswith("Paragraph 0."))
        self.assertTrue(joined.rstrip().endswith("The end."))
        for i in range(30):
            self.assertIn(f"Paragraph {i}.", joined)
        self.assertIn("line_399 = 399  # &lt;tag&gt;", joined)
        self.assertNotIn("```python", joined)
        self.assertEqual({p["thread_ts"] for p in self.web.posts}, {"5400.0001"})
        self.assertEqual(len(self.sleeps), len(texts) - 1)  # paced, one message per second

    def test_a_failed_post_keeps_the_file_and_resumes_after_the_last_piece(self):
        iid = self.bridge.handle_event(mention("go", ts="5500.0001"), TEAM)
        long = "\n\n".join(f"Part {i} " + "x " * 1000 for i in range(4))
        p = self.reply(iid, long)
        # the second piece fails once, rate limited for 30 s
        real = self.web.chat_postMessage
        calls = {"n": 0}

        def flaky(**kw):
            calls["n"] += 1
            if calls["n"] == 2:
                raise SlackApiError("ratelimited", retry_after=30)
            return real(**kw)

        self.web.chat_postMessage = flaky
        self.assertEqual(self.bridge.flush_replies(), 0)
        self.assertTrue(p.exists())
        self.assertEqual(json.loads(p.read_text())["posted_chunks"], 1)
        posts_before = len(self.web.posts)
        self.t += 10
        self.assertEqual(self.bridge.flush_replies(), 0)  # still waiting out Retry-After
        self.t += 25
        self.assertEqual(self.bridge.flush_replies(), 1)
        self.assertFalse(p.exists())
        texts = [x["text"] for x in self.web.posts]
        self.assertEqual(posts_before, 1)
        self.assertEqual(len(texts), len(set(texts)), "no piece posted twice")
        self.assertTrue(texts[0].startswith("Part 0"))
        log = "\n".join(self.log.lines)
        self.assertIn("SlackApiError (ratelimited)", log)
        self.assertNotIn("xoxb-", log)

    def test_a_reply_that_keeps_failing_is_set_aside(self):
        iid = self.bridge.handle_event(mention("go", ts="5600.0001"), TEAM)
        p = self.reply(iid, "short")
        self.web.fail = [SlackApiError("channel_not_found") for _ in range(10)]
        for _ in range(len(sb.RETRY_DELAYS) + 1):
            self.bridge.flush_replies()
            self.t += 1000
        self.assertFalse(p.exists())
        self.assertEqual(len(list((self.call / "replies" / ".failed").iterdir())), 1)
        self.assertNotIn("xoxb-", "\n".join(self.log.lines))


class Text(unittest.TestCase):
    def test_markdown_to_mrkdwn(self):
        md = "\n".join([
            "# Weekly note",
            "**Bold**, *italic*, ***both***, ~~gone~~ and `a < b`.",
            "- one",
            "* two with [a link](https://example.com/x?a=1&b=2)",
            "> quoted & kept",
            "---",
            "```js",
            "if (a < b && c) {}",
            "```",
            "snake_case_name stays",
        ])
        self.assertEqual(sb.md_to_mrkdwn(md).split("\n"), [
            "*Weekly note*",
            "*Bold*, _italic_, *_both_*, ~gone~ and `a &lt; b`.",
            "• one",
            "• two with <https://example.com/x?a=1&amp;b=2|a link>",
            ">quoted &amp; kept",
            "───",
            "```",
            "if (a &lt; b &amp;&amp; c) {}",
            "```",
            "snake_case_name stays",
        ])

    def test_an_unclosed_fence_is_closed(self):
        self.assertEqual(sb.md_to_mrkdwn("```\ncode"), "```\ncode\n```")

    def test_chunk_keeps_short_text_whole_and_splits_long_lines(self):
        self.assertEqual(sb.chunk("hello"), ["hello"])
        long = " ".join(["word"] * 2000)
        pieces = sb.chunk(long, limit=500)
        self.assertTrue(all(len(p) <= 500 for p in pieces))
        self.assertEqual(" ".join(pieces).split(), long.split())
        unbroken = "x" * 1300
        self.assertEqual("".join(sb.chunk(unbroken, limit=500)), unbroken)

    def test_chunk_closes_and_reopens_code_blocks(self):
        text = "intro\n```\n" + "\n".join(f"row {i}" for i in range(200)) + "\n```\noutro"
        pieces = sb.chunk(text, limit=300)
        self.assertGreater(len(pieces), 3)
        for p in pieces:
            self.assertLessEqual(len(p), 300)
            self.assertEqual(p.count("```") % 2, 0)
        rows = [line for p in pieces for line in p.split("\n") if line.startswith("row ")]
        self.assertEqual(rows, [f"row {i}" for i in range(200)])

    def test_safe_failure_never_carries_the_message(self):
        self.assertEqual(sb.safe_failure(SlackApiError("invalid_auth")), "SlackApiError (invalid_auth)")
        self.assertEqual(sb.safe_failure(RuntimeError("xoxb-123 leaked")), "Error")
        self.assertEqual(sb.safe_failure(TimeoutError()), "TimeoutError")


class Config(unittest.TestCase):
    def test_lists_or_maps_and_validation(self):
        cfg = sb.parse_config({"allow_users": [OWNER], "allow_channels": [GENERAL], "routes": {"Write": "scribe"}})
        self.assertEqual(cfg.allow_users, {OWNER: ""})
        self.assertEqual(cfg.routes, {"write": "scribe"})
        self.assertTrue(cfg.allow_dms)
        with self.assertRaises(sb.ConfigError) as e:
            sb.parse_config({"allow_users": ["someone", OWNER], "allow_channels": ["#general"],
                             "default_worker": "../x", "routes": {"C0OK1234": "Bad Key", "two words": "x"}})
        msg = str(e.exception)
        for part in ("'someone' is not a Slack id", "'#general' is not a Slack id", "default_worker",
                     "'Bad Key' is not a worker key", "neither a channel id nor a word"):
            self.assertIn(part, msg)
        with self.assertRaises(sb.ConfigError):
            sb.parse_config({"allow_users": []})
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sb.ConfigError) as e:
                sb.load_config(Path(d) / "slack.json")
            self.assertEqual(str(e.exception), "missing")

    def test_tokens_from_env_then_keychain_and_never_echoed(self):
        calls = []

        class R:
            def __init__(self, code, out=""):
                self.returncode, self.stdout = code, out

        def keychain(argv, **kw):
            calls.append(argv)
            if argv[3] == sb.KEYCHAIN_APP:
                return R(0, "xapp-from-keychain\n" if "-w" in argv else "attrs")
            return R(44)

        bot, app = sb.read_tokens({"SLACK_BOT_TOKEN": "xoxb-env"}, keychain)
        self.assertEqual((bot, app), ("xoxb-env", "xapp-from-keychain"))
        self.assertEqual(calls[0][:4], ["/usr/bin/security", "find-generic-password", "-s", sb.KEYCHAIN_APP])
        calls.clear()
        self.assertEqual(sb.tokens_present({}, keychain), (False, True))
        self.assertTrue(all("-w" not in c for c in calls), "status never reads a secret")
        self.assertEqual(sb.read_tokens({}, lambda *a, **k: R(44)), (None, None))


class Req:
    """A Socket Mode request as slack_sdk hands it to a listener."""

    def __init__(self, type, envelope_id, payload):
        self.type, self.envelope_id, self.payload = type, envelope_id, payload


def fake_sdk(web, made):
    """slack_sdk's three names, faked: the web client, the socket, the ack."""

    class Resp:
        def __init__(self, envelope_id):
            self.envelope_id = envelope_id

    class Sock:
        def __init__(self, app_token, web_client, logger=None):
            made["sock"] = self
            made["app_token"] = app_token
            self.socket_mode_request_listeners = []
            self.acks = []
            self.connected = False
            self.closed = False

        def connect(self):
            self.connected = True

        def is_connected(self):
            return self.connected

        def close(self):
            self.closed = True

        def send_socket_mode_response(self, resp):
            self.acks.append(resp.envelope_id)

    class Sdk:
        SocketModeClient = Sock
        SocketModeResponse = Resp

        @staticmethod
        def WebClient(token):
            made["bot_token"] = token
            return web

    return Sdk


class Socket(Base):
    """The daemon loop with a fake SDK: ack, inbox, reply, state, shutdown."""

    def serve_in_background(self, made):
        stop = threading.Event()
        result = {}
        sdk = fake_sdk(self.web, made)
        th = threading.Thread(target=lambda: result.setdefault(
            "rc", sb.serve(self.paths, self.cfg, "xoxb-test-bot", "xapp-test-app", sdk, stop, poll_s=0.01)))
        th.start()
        self._wait(lambda: sb.read_state(self.paths).get("state") == "connected")
        return stop, th, result

    def test_an_edited_allow_list_takes_effect_without_a_restart(self):
        made = {}
        stop, th, _ = self.serve_in_background(made)
        try:
            sock = made["sock"]
            [listen] = sock.socket_mode_request_listeners
            listen(sock, Req("events_api", "e1", {"team_id": TEAM, "event": mention("one", user=FRIEND, ts="7000.0001")}))
            self.assertEqual(len(self.inbox("scribe")), 1)
            self.paths.config.write_text(json.dumps({**CONFIG, "allow_users": {OWNER: "Owner"}}))
            self._wait(lambda: any("slack.json reloaded" in x for x in self.log.lines))
            listen(sock, Req("events_api", "e2", {"team_id": TEAM, "event": mention("two", user=FRIEND, ts="7000.0002")}))
            self.assertEqual(len(self.inbox("scribe")), 1)
            self.paths.config.write_text("{ broken")
            self._wait(lambda: any("not reloaded" in x for x in self.log.lines))
            listen(sock, Req("events_api", "e3", {"team_id": TEAM, "event": mention("three", ts="7000.0003")}))
            self.assertEqual(len(self.inbox("scribe")), 2)  # the last good list still stands
        finally:
            stop.set()
            th.join(5)

    def test_serve_acks_events_posts_replies_and_stops_cleanly(self):
        web = self.web
        made = {}
        stop, th, result = self.serve_in_background(made)
        try:
            sock = made["sock"]
            [listen] = sock.socket_mode_request_listeners
            listen(sock, Req("events_api", "env-1", {"team_id": TEAM, "event": mention("scout secret plan", ts="6000.0001")}))
            listen(sock, Req("slash_commands", "env-2", {"command": "/x"}))
            listen(sock, Req("events_api", "env-3", {"team_id": TEAM, "event": mention("hi", user=STRANGER, ts="6000.0002")}))
            self.assertEqual(sock.acks, ["env-1", "env-2", "env-3"])
            [line] = self.inbox("scout")
            self.reply(line["id"], "Done, nothing changed.")
            self._wait(lambda: len(web.posts) == 1)
            self.assertEqual(web.posts[0]["thread_ts"], "6000.0001")
        finally:
            stop.set()
            th.join(5)
        self.assertEqual(result["rc"], 0)
        self.assertTrue(made["sock"].closed)
        self.assertEqual(sb.read_state(self.paths)["state"], "stopped")
        self.assertEqual((made["bot_token"], made["app_token"]), ("xoxb-test-bot", "xapp-test-app"))
        log = "\n".join(self.log.lines)
        self.assertNotIn("xoxb-", log)
        self.assertNotIn("xapp-", log)
        self.assertNotIn("secret plan", log)

    def test_a_token_for_another_workspace_stops_before_connecting(self):
        class Sdk:
            @staticmethod
            def WebClient(token):
                class W(FakeWeb):
                    def auth_test(self):
                        return {"ok": True, "user_id": BOT, "team_id": "T0ELSE01"}
                return W()

            def SocketModeClient(*a, **k):
                raise AssertionError("must not connect")

        rc = sb.serve(self.paths, self.cfg, "xoxb-x", "xapp-x", Sdk, threading.Event())
        self.assertEqual(rc, 4)
        self.assertEqual(sb.read_state(self.paths)["state"], "error")

    @staticmethod
    def _wait(cond, timeout=5.0):
        end = time.time() + timeout
        while time.time() < end:
            if cond():
                return
            time.sleep(0.01)
        raise AssertionError("timed out")


if __name__ == "__main__":
    unittest.main()
