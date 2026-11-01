#!/usr/bin/env python3
"""Slack bridge for the colleague's workers: Socket Mode in, thread replies out.

Runs on this Mac. Socket Mode is an outbound websocket to Slack, so there is no
public URL, no open port and no webhook.

  slack_bridge.py run      connect and serve (bin/bridge start runs this)
  slack_bridge.py check    configured? one line; exit 0 when ready to start
  slack_bridge.py status   configured, running, connected (bin/bridge status)

Inbound: an app_mention or a DM from an allow-listed user, in an allowed place,
becomes one line of ~/.voicemode/call/inbox/<worker>.jsonl and gets an "eyes"
reaction. A reply in a thread the bridge already knows goes to the same worker.
Everything else is dropped and logged: who, where and why, never the text.

Outbound: ~/.voicemode/call/replies/*.json (written by bin/reply) are posted as
thread replies, then deleted. A reply goes only into the thread its inbox id came
from, whatever the file says; anything else is refused, moved to
replies/.refused/ and logged.

Tokens come from SLACK_BOT_TOKEN / SLACK_APP_TOKEN or the macOS keychain
(services cludegods-slack-bot and cludegods-slack-app), never from a file.

Only the standard library is imported at load; slack_sdk is imported by `run`.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import logging.handlers
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

LOG = logging.getLogger("slack-bridge")

# A worker key is a file name in inbox/: lowercase, digits, - and _.
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
# Inbox ids this bridge mints: in_ + 12 hex of sha1(team:channel:ts).
ID_RE = re.compile(r"^in_[0-9a-f]{12}$")
USER_RE = re.compile(r"^[UW][A-Z0-9]{2,30}$")
CHANNEL_RE = re.compile(r"^[CG][A-Z0-9]{2,30}$")
TEAM_RE = re.compile(r"^[TE][A-Z0-9]{2,30}$")
WORD_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

CHUNK = 3500  # Slack asks for at most 4,000 characters per message
MAX_INBOUND = 20_000
MAX_REPLY = 40_000
THREAD_TTL_S = 30 * 86400
MAX_THREADS = 5000
RETRY_DELAYS = (5, 15, 60, 300)
CHUNK_GAP_S = 1.1  # chat.postMessage allows about one message per second per channel
# A person's own new message with a file, or a thread reply also sent to the channel.
# Every other subtype (edits, deletes, joins, bot messages) is dropped.
HUMAN_SUBTYPES = {"file_share", "thread_broadcast"}

KEYCHAIN_BOT = "cludegods-slack-bot"
KEYCHAIN_APP = "cludegods-slack-app"
SECURITY = "/usr/bin/security"
SDK_PIN = "slack_sdk==3.45.0"


class ConfigError(Exception):
    pass


# ---------------------------------------------------------------- config


class Config:
    """~/.voicemode/call/slack.json, validated."""

    def __init__(
        self,
        allow_users: Dict[str, str],
        allow_channels: Dict[str, str],
        allow_dms: bool = True,
        team: Optional[str] = None,
        default_worker: Optional[str] = None,
        routes: Optional[Dict[str, str]] = None,
    ):
        self.allow_users = allow_users
        self.allow_channels = allow_channels
        self.allow_dms = allow_dms
        self.team = team
        self.default_worker = default_worker
        self.routes = routes or {}

    def summary(self) -> str:
        users = len(self.allow_users)
        chans = len(self.allow_channels)
        parts = [
            f"{users} user{'s' if users != 1 else ''}",
            f"{chans} channel{'s' if chans != 1 else ''}",
            "DMs on" if self.allow_dms else "DMs off",
        ]
        if self.default_worker:
            parts.append(f"default worker {self.default_worker}")
        return ", ".join(parts)


def _id_map(value: Any, pattern: re.Pattern, field: str, problems: List[str]) -> Dict[str, str]:
    """A list of ids, or a map of id to a display name."""
    if value is None:
        return {}
    if isinstance(value, list):
        pairs = [(v, "") for v in value]
    elif isinstance(value, dict):
        pairs = list(value.items())
    else:
        problems.append(f"{field} must be a list of ids or a map of id to name")
        return {}
    out: Dict[str, str] = {}
    for k, name in pairs:
        if not isinstance(k, str) or not pattern.match(k):
            problems.append(f"{field}: {k!r} is not a Slack id")
            continue
        out[k] = name.strip() if isinstance(name, str) else ""
    return out


def parse_config(raw: Any) -> Config:
    if not isinstance(raw, dict):
        raise ConfigError("slack.json must be a JSON object")
    problems: List[str] = []
    users = _id_map(raw.get("allow_users"), USER_RE, "allow_users", problems)
    chans = _id_map(raw.get("allow_channels"), CHANNEL_RE, "allow_channels", problems)
    allow_dms = raw.get("allow_dms", True)
    if not isinstance(allow_dms, bool):
        problems.append("allow_dms must be true or false")
        allow_dms = False
    team = raw.get("team")
    if team is not None and (not isinstance(team, str) or not TEAM_RE.match(team)):
        problems.append(f"team: {team!r} is not a Slack workspace id")
        team = None
    default = raw.get("default_worker")
    if default is not None and (not isinstance(default, str) or not KEY_RE.match(default)):
        problems.append(f"default_worker: {default!r} is not a worker key")
        default = None
    routes: Dict[str, str] = {}
    raw_routes = raw.get("routes") or {}
    if not isinstance(raw_routes, dict):
        problems.append("routes must be a map of word or channel id to worker key")
        raw_routes = {}
    for k, v in raw_routes.items():
        if not isinstance(v, str) or not KEY_RE.match(v):
            problems.append(f"routes[{k!r}]: {v!r} is not a worker key")
            continue
        if isinstance(k, str) and CHANNEL_RE.match(k):
            routes[k] = v
        elif isinstance(k, str) and WORD_RE.match(k.lower()):
            routes[k.lower()] = v
        else:
            problems.append(f"routes: {k!r} is neither a channel id nor a word")
    if not users:
        problems.append("allow_users is empty: nobody could reach a worker")
    if problems:
        raise ConfigError("; ".join(problems))
    return Config(users, chans, allow_dms, team, default, routes)


def load_config(path: Path) -> Config:
    try:
        text = path.read_text()
    except FileNotFoundError:
        raise ConfigError("missing")
    try:
        raw = json.loads(text)
    except ValueError as e:
        raise ConfigError(f"slack.json is not valid JSON (line {getattr(e, 'lineno', '?')})")
    return parse_config(raw)


# ---------------------------------------------------------------- paths


class Paths:
    def __init__(self, call: Path):
        self.call = call
        self.config = call / "slack.json"
        self.inbox = call / "inbox"
        self.replies = call / "replies"
        self.refused = self.replies / ".refused"
        self.failed = self.replies / ".failed"
        self.workers = call / "workers.json"
        self.threads = call / "slack-threads.json"
        self.state = call / "slack-bridge.state"
        self.log = call / "slack-bridge.log"
        self.pid = call / "slack-bridge.pid"

    @classmethod
    def default(cls) -> "Paths":
        return cls(Path.home() / ".voicemode" / "call")


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def _append_line(path: Path, obj: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
    fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, data)  # one write with O_APPEND: lines from two writers never interleave
    finally:
        os.close(fd)


def read_workers(path: Path) -> Dict[str, str]:
    """workers.json as key -> lowercase name; {} when missing or unreadable."""
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    out: Dict[str, str] = {}
    for w in raw.get("workers", []) if isinstance(raw, dict) else []:
        if isinstance(w, dict) and isinstance(w.get("key"), str) and KEY_RE.match(w["key"]):
            name = w.get("name") if isinstance(w.get("name"), str) else ""
            out[w["key"]] = name.strip().lower()
    return out


# ---------------------------------------------------------------- errors


_SAFE_NAMES = {
    "SlackApiError", "SlackRequestError", "SlackClientError", "SlackClientNotConnectedError",
    "TimeoutError", "ConnectionError", "ConnectionResetError", "URLError", "HTTPError",
    "OSError", "ValueError", "KeyError", "TypeError",
}


def safe_failure(error: BaseException) -> str:
    """An error as a log line that cannot carry a token or a message body.

    Only the class name (from a short list) and Slack's error code are kept,
    the same rule OpenDots applies to its Slack channel failures.
    """
    name = type(error).__name__
    name = name if name in _SAFE_NAMES else "Error"
    code = None
    resp = getattr(error, "response", None)
    if resp is not None:
        try:
            code = resp.get("error")
        except Exception:
            code = None
    if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,64}", code):
        return f"{name} ({code})"
    return name


def _error_code(error: BaseException) -> Optional[str]:
    resp = getattr(error, "response", None)
    try:
        code = resp.get("error") if resp is not None else None
    except Exception:
        return None
    return code if isinstance(code, str) else None


def _retry_after(error: BaseException) -> Optional[int]:
    resp = getattr(error, "response", None)
    headers = getattr(resp, "headers", None) or {}
    try:
        value = headers.get("Retry-After") or headers.get("retry-after")
        return max(1, min(int(value), 600)) if value is not None else None
    except (TypeError, ValueError, AttributeError):
        return None


# ---------------------------------------------------------------- text


def inbox_id(team: Optional[str], channel: str, ts: str) -> str:
    """Stable per Slack message, so a redelivered event writes nothing twice."""
    return "in_" + hashlib.sha1(f"{team or ''}:{channel}:{ts}".encode()).hexdigest()[:12]


def clean_text(raw: str, bot_user_id: Optional[str], cfg: Config) -> str:
    """Slack's wire format to plain text: the bot's own mention removed, the rest readable."""
    t = raw or ""
    if bot_user_id:
        t = re.sub(r"<@" + re.escape(bot_user_id) + r"(?:\|[^>]*)?>", "", t)

    def user(m: re.Match) -> str:
        return "@" + (m.group(2) or cfg.allow_users.get(m.group(1)) or m.group(1))

    def chan(m: re.Match) -> str:
        return "#" + (m.group(2) or cfg.allow_channels.get(m.group(1)) or m.group(1))

    t = re.sub(r"<@([UW][A-Z0-9]+)(?:\|([^>]*))?>", user, t)
    t = re.sub(r"<#([CG][A-Z0-9]+)(?:\|([^>]*))?>", chan, t)
    t = re.sub(r"<!(here|channel|everyone)(?:\|[^>]*)?>", r"@\1", t)
    t = re.sub(r"<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>", lambda m: m.group(1) or "@group", t)
    t = re.sub(r"<((?:https?|mailto):[^|>]+)\|([^>]+)>", r"\2 (\1)", t)
    t = re.sub(r"<((?:https?|mailto):[^>]+)>", r"\1", t)
    t = t.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    return t.strip()


def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


_LINK_RE = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_AUTOLINK_RE = re.compile(r"<((?:https?|mailto):[^>\s]+)>")


def _inline(text: str) -> str:
    """One line of Markdown (outside code) to Slack mrkdwn."""
    parts = re.split(r"(`[^`\n]+`)", text)
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1:  # an inline code span: escaped, otherwise as is
            out.append(_escape(part))
            continue
        held: List[str] = []

        def hold(s: str) -> str:
            held.append(s)
            return f"\x00{len(held) - 1}\x00"

        def link(m: re.Match) -> str:
            label, url = m.group(1), m.group(2)
            if re.match(r"^(https?|mailto):", url):
                safe_label = _escape(label.replace("|", "/"))
                return hold(f"<{_escape(url)}|{safe_label}>")
            return m.group(0)

        s = _LINK_RE.sub(link, part)
        s = _AUTOLINK_RE.sub(lambda m: hold(f"<{_escape(m.group(1))}>"), s)
        s = _escape(s)
        s = re.sub(r"\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*", "\x01_\\1_\x01", s)
        s = re.sub(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", "\x01\\1\x01", s)
        s = re.sub(r"__(?=\S)(.+?)(?<=\S)__", "\x01\\1\x01", s)
        s = re.sub(r"(?<![*\w])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\w])", r"_\1_", s)
        s = re.sub(r"~~(?=\S)(.+?)(?<=\S)~~", r"~\1~", s)
        s = s.replace("\x01", "*")
        s = re.sub(r"\x00(\d+)\x00", lambda m: held[int(m.group(1))], s)
        out.append(s)
    return "".join(out)


def md_to_mrkdwn(md: str) -> str:
    """Markdown as a worker writes it, to Slack's mrkdwn."""
    lines_out: List[str] = []
    in_fence = False
    for line in md.replace("\r\n", "\n").split("\n"):
        if line.strip().startswith("```"):
            lines_out.append("```")  # mrkdwn has no language tag
            in_fence = not in_fence
            continue
        if in_fence:
            lines_out.append(_escape(line))
            continue
        m = re.match(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$", line)
        if m:
            inner = re.sub(r"\*\*(.+?)\*\*", r"\1", m.group(1))
            lines_out.append(f"*{_inline(inner)}*" if inner else "")
            continue
        m = re.match(r"^\s*>\s?(.*)$", line)
        if m:
            lines_out.append(">" + _inline(m.group(1)))  # the quote marker stays unescaped
            continue
        if re.match(r"^\s*([-*_])(\s*\1){2,}\s*$", line):
            lines_out.append("───")
            continue
        m = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
        if m:
            lines_out.append(f"{m.group(1)}• {_inline(m.group(2))}")
            continue
        lines_out.append(_inline(line))
    if in_fence:
        lines_out.append("```")
    return "\n".join(lines_out)


def _split_long(line: str, n: int) -> List[str]:
    out = []
    while len(line) > n:
        cut = line.rfind(" ", 0, n)
        if cut <= n // 2:
            cut = n
        out.append(line[:cut].rstrip())
        line = line[cut:].lstrip(" ")
    out.append(line)
    return out


def chunk(text: str, limit: int = CHUNK) -> List[str]:
    """Split a long mrkdwn message on line breaks, each piece at most `limit`.

    A piece that ends inside a code block closes it, and the next reopens it.
    """
    budget = limit - 4  # room to close a code block
    chunks: List[str] = []
    cur: List[str] = []
    size = 0
    in_fence = False

    def flush() -> None:
        nonlocal cur, size
        body = "\n".join(cur).strip("\n")
        if in_fence:
            body += "\n```"
        if body.strip("`\n "):
            chunks.append(body)
        cur = ["```"] if in_fence else []
        size = 3 if in_fence else 0

    for line in text.split("\n"):
        is_fence = line.strip().startswith("```")
        for piece in _split_long(line, budget - 4):
            add = len(piece) + (1 if cur else 0)
            # A closing fence fits in the room kept for it, so no empty block opens the next piece.
            closes = in_fence and is_fence and size + add <= limit
            if cur and size + add > budget and not closes:
                flush()
                add = len(piece) + (1 if cur else 0)
            cur.append(piece)
            size += add
        if is_fence:
            in_fence = not in_fence
    in_fence = False
    if cur:
        flush()
    return chunks


# ---------------------------------------------------------------- thread registry


class Registry:
    """Threads that started from an allowed message, and the inbox ids in them.

    Persisted, so a reply still finds its thread after a restart. A reply can only
    ever go to a thread listed here.
    """

    def __init__(self, path: Path, now: Callable[[], float]):
        self.path = path
        self.now = now
        self.threads: Dict[str, dict] = {}
        self.inbox: Dict[str, str] = {}
        try:
            raw = json.loads(path.read_text())
            if isinstance(raw, dict):
                self.threads = {k: v for k, v in (raw.get("threads") or {}).items() if isinstance(v, dict)}
                self.inbox = {k: v for k, v in (raw.get("inbox") or {}).items() if isinstance(v, str)}
        except (OSError, ValueError):
            pass

    @staticmethod
    def key(channel: str, thread_ts: str) -> str:
        return f"{channel}:{thread_ts}"

    def thread(self, channel: str, thread_ts: str) -> Optional[dict]:
        return self.threads.get(self.key(channel, thread_ts))

    def has(self, iid: str) -> bool:
        return iid in self.inbox

    def target(self, iid: str) -> Optional[dict]:
        tkey = self.inbox.get(iid)
        return self.threads.get(tkey) if tkey else None

    def add(self, iid: str, channel: str, thread_ts: str, worker: str, is_dm: bool) -> None:
        tkey = self.key(channel, thread_ts)
        t = self.threads.get(tkey)
        if t is None:
            t = {"worker": worker, "channel": channel, "thread_ts": thread_ts, "dm": is_dm, "started": self.now()}
            self.threads[tkey] = t
        t["last"] = self.now()
        self.inbox[iid] = tkey

    def save(self) -> None:
        cutoff = self.now() - THREAD_TTL_S
        live = {k: v for k, v in self.threads.items() if v.get("last", 0) >= cutoff}
        if len(live) > MAX_THREADS:
            newest = sorted(live.items(), key=lambda kv: kv[1].get("last", 0))[-MAX_THREADS:]
            live = dict(newest)
        self.threads = live
        self.inbox = {i: k for i, k in self.inbox.items() if k in live}
        _write_atomic(self.path, json.dumps({"threads": self.threads, "inbox": self.inbox}, indent=1))


# ---------------------------------------------------------------- the bridge


class Bridge:
    """The bridge's decisions, with the Slack client passed in (a fake in tests).

    `web` needs two methods, as slack_sdk's WebClient spells them:
    reactions_add(channel, timestamp, name) and chat_postMessage(channel, thread_ts, text, ...).
    """

    def __init__(
        self,
        cfg: Config,
        web: Any,
        paths: Paths,
        bot_user_id: Optional[str],
        team_id: Optional[str] = None,
        workers: Optional[Callable[[], Dict[str, str]]] = None,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.cfg = cfg
        self.web = web
        self.paths = paths
        self.bot_user_id = bot_user_id
        self.team_id = team_id
        self.workers = workers or (lambda: read_workers(paths.workers))
        self.now = now
        self.sleep = sleep
        self.lock = threading.RLock()
        self.registry = Registry(paths.threads, now)
        self.attempts: Dict[str, Tuple[int, float]] = {}

    # -- inbound

    def _drop(self, reason: str, event: dict) -> None:
        LOG.info(
            "drop (%s): type=%s user=%s channel=%s",
            reason, event.get("type"), event.get("user") or "-", event.get("channel") or "-",
        )
        return None

    def route(self, text: str, channel: str, is_dm: bool) -> Tuple[Optional[str], str]:
        """Which worker a new conversation goes to, and the text it gets.

        1. A leading word: a route word, a worker key or a worker's name
           ("scribe draft the notes"); the word is taken off the text.
        2. In a DM, routes["dm"]; in a channel, routes[<channel id>].
        3. default_worker.
        """
        workers = self.workers()
        by_name = {name: key for key, name in workers.items() if name and " " not in name}
        m = re.match(r"^\s*([A-Za-z0-9_-]+)(?:[:,]?\s+(.*)|[:,]?\s*$)", text, re.S)
        if m:
            word = m.group(1).lower()
            target = (
                (self.cfg.routes.get(word) if not CHANNEL_RE.match(m.group(1)) and word != "dm" else None)
                or (word if word in workers else None)
                or by_name.get(word)
            )
            if target:
                return target, (m.group(2) or "").strip()
        if is_dm and "dm" in self.cfg.routes:
            return self.cfg.routes["dm"], text
        if not is_dm and channel in self.cfg.routes:
            return self.cfg.routes[channel], text
        return self.cfg.default_worker, text

    def handle_event(self, event: dict, team_id: Optional[str] = None) -> Optional[str]:
        """One Events API event. Returns the inbox id written, or None when dropped."""
        with self.lock:
            return self._handle(event if isinstance(event, dict) else {}, team_id)

    def _handle(self, event: dict, team_id: Optional[str]) -> Optional[str]:
        cfg = self.cfg
        etype = event.get("type")
        if etype not in ("app_mention", "message"):
            return self._drop("event type", event)
        if event.get("subtype") and event.get("subtype") not in HUMAN_SUBTYPES:
            return self._drop(f"subtype {event.get('subtype')}", event)  # edits, deletes, joins, bots
        if event.get("bot_id") or event.get("bot_profile"):
            return self._drop("bot", event)
        user, channel, ts = event.get("user"), event.get("channel"), event.get("ts")
        if not isinstance(user, str) or not isinstance(channel, str) or not isinstance(ts, str):
            return self._drop("malformed", event)
        if self.bot_user_id and user == self.bot_user_id:
            return self._drop("own message", event)
        # Addressed to the bot at all: a mention, a DM, or a reply in a thread it knows.
        raw = event.get("text") if isinstance(event.get("text"), str) else ""
        is_dm = event.get("channel_type") == "im" or channel.startswith("D")
        mentioned = etype == "app_mention" or (
            bool(self.bot_user_id) and f"<@{self.bot_user_id}" in raw
        )
        thread_ts = event.get("thread_ts") if isinstance(event.get("thread_ts"), str) else None
        known = self.registry.thread(channel, thread_ts) if thread_ts and thread_ts != ts else None
        if not (known or mentioned or is_dm):
            return self._drop("not addressed to the bot", event)

        # Then who and where, against the allow-lists.
        if cfg.team:
            team = event.get("user_team") or event.get("team") or team_id or self.team_id
            if team != cfg.team:
                return self._drop("other workspace", event)
        if user not in cfg.allow_users:
            return self._drop("user not allowed", event)
        if is_dm:
            if not cfg.allow_dms:
                return self._drop("DMs are off", event)
        elif channel not in cfg.allow_channels:
            return self._drop("channel not allowed", event)

        iid = inbox_id(team_id or self.team_id, channel, ts)
        if self.registry.has(iid):
            return self._drop("duplicate", event)  # app_mention and message.channels both fire

        text = clean_text(raw, self.bot_user_id, cfg)
        if known:
            worker, thread = known["worker"], thread_ts
        else:
            thread = thread_ts or ts
            worker, text = self.route(text, channel, is_dm)
            if not worker:
                return self._drop("no worker for it (set default_worker or a route)", event)

        files = event.get("files")
        if isinstance(files, list) and files:
            n = len(files)
            text = (text + f"\n\n({n} attached file{'s' if n != 1 else ''} not shown)").strip()
        if not text:
            return self._drop("empty", event)
        if len(text) > MAX_INBOUND:
            text = text[:MAX_INBOUND] + " (cut)"

        line = {
            "id": iid,
            "at": _dt.datetime.fromtimestamp(self.now()).astimezone().isoformat(timespec="seconds"),
            "source": "slack",
            "from": cfg.allow_users.get(user) or user,
            "channel": "dm" if is_dm else (cfg.allow_channels.get(channel) or channel),
            "thread": thread,
            "text": text,
            "delivered": False,
            "worker": worker,
            "user": user,
            "channel_id": channel,
            "ts": ts,
            "dm": is_dm,
        }
        self.registry.add(iid, channel, thread, worker, is_dm)
        try:
            self.registry.save()
            _append_line(self.paths.inbox / f"{worker}.jsonl", line)
        except OSError as e:
            LOG.error("inbox write failed for %s: %s", iid, safe_failure(e))
            return None
        LOG.info("inbox %s -> %s: user=%s channel=%s thread=%s", iid, worker, user, channel, thread)
        try:
            self.web.reactions_add(channel=channel, timestamp=ts, name="eyes")
        except Exception as e:  # the message is in; a missing reaction is cosmetic
            if _error_code(e) != "already_reacted":
                LOG.warning("eyes reaction failed on %s: %s", iid, safe_failure(e))
        return iid

    # -- outbound

    def _refuse(self, path: Path, reason: str) -> None:
        LOG.warning("refused reply %s: %s", path.name, reason)
        self.paths.refused.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(path, self.paths.refused / f"{int(self.now())}-{path.name}")
        except OSError:
            path.unlink(missing_ok=True)
        self.attempts.pop(path.name, None)

    def _place_allowed(self, target: dict) -> bool:
        if target.get("dm"):
            return self.cfg.allow_dms
        return target.get("channel") in self.cfg.allow_channels

    def flush_replies(self) -> int:
        """Posts every pending reply it may. Returns how many were posted whole."""
        with self.lock:
            try:
                files = [p for p in self.paths.replies.glob("*.json") if not p.name.startswith(".")]
            except OSError:
                return 0
            def mtime(p: Path) -> float:
                try:
                    return p.stat().st_mtime
                except OSError:
                    return 0.0

            files.sort(key=lambda p: (mtime(p), p.name))
            posted = 0
            for p in files:
                n, next_at = self.attempts.get(p.name, (0, 0.0))
                if next_at > self.now():
                    continue
                if self._post(p):
                    posted += 1
            return posted

    def _post(self, path: Path) -> bool:
        try:
            data = json.loads(path.read_text())
        except FileNotFoundError:
            return False
        except (OSError, ValueError):
            self._refuse(path, "not valid JSON")
            return False
        if not isinstance(data, dict):
            self._refuse(path, "not a JSON object")
            return False
        iid = data.get("id")
        if not isinstance(iid, str) or not ID_RE.match(iid):
            self._refuse(path, "no valid inbox id")
            return False
        # The destination is the registry's alone: any channel or thread in the file is ignored.
        target = self.registry.target(iid)
        if not target:
            self._refuse(path, f"{iid} is not from an allowed Slack message (or its thread expired)")
            return False
        if not self._place_allowed(target):
            self._refuse(path, f"{iid}: its channel is no longer allowed")
            return False
        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            self._refuse(path, f"{iid}: empty text")
            return False
        if len(text) > MAX_REPLY:
            text = text[:MAX_REPLY] + "\n\n(cut)"
        pieces = chunk(md_to_mrkdwn(text))
        done = data.get("posted_chunks", 0)
        done = done if isinstance(done, int) and 0 <= done <= len(pieces) else 0
        for i in range(done, len(pieces)):
            if i > done:
                self.sleep(CHUNK_GAP_S)
            try:
                self.web.chat_postMessage(
                    channel=target["channel"],
                    thread_ts=target["thread_ts"],
                    text=pieces[i],
                    mrkdwn=True,
                    unfurl_links=False,
                    unfurl_media=False,
                )
            except Exception as e:
                self._failed(path, data, i, e)
                return False
            if i + 1 < len(pieces):
                data["posted_chunks"] = i + 1  # a retry picks up after the last piece posted
                try:
                    _write_atomic(path, json.dumps(data, ensure_ascii=False))
                except OSError:
                    pass
        path.unlink(missing_ok=True)
        self.attempts.pop(path.name, None)
        LOG.info(
            "posted %s in channel=%s thread=%s (%d piece%s)",
            iid, target["channel"], target["thread_ts"], len(pieces), "s" if len(pieces) != 1 else "",
        )
        return True

    def _failed(self, path: Path, data: dict, done: int, error: BaseException) -> None:
        n, _ = self.attempts.get(path.name, (0, 0.0))
        n += 1
        if done:
            data["posted_chunks"] = done
            try:
                _write_atomic(path, json.dumps(data, ensure_ascii=False))
            except OSError:
                pass
        if n > len(RETRY_DELAYS):
            LOG.error("gave up on reply %s after %d tries: %s", path.name, n, safe_failure(error))
            self.paths.failed.mkdir(parents=True, exist_ok=True)
            try:
                os.replace(path, self.paths.failed / f"{int(self.now())}-{path.name}")
            except OSError:
                pass
            self.attempts.pop(path.name, None)
            return
        delay = _retry_after(error) if _error_code(error) == "ratelimited" else None
        delay = delay or RETRY_DELAYS[n - 1]
        self.attempts[path.name] = (n, self.now() + delay)
        LOG.warning("reply %s not posted (try %d), again in %ds: %s", path.name, n, delay, safe_failure(error))


# ---------------------------------------------------------------- socket mode glue


def socket_listener(bridge: Bridge, response_cls: Any) -> Callable[[Any, Any], None]:
    """The SocketModeClient listener: ack at once, then hand the event to the bridge."""

    def listener(client: Any, req: Any) -> None:
        envelope = getattr(req, "envelope_id", None)
        if envelope:
            try:
                client.send_socket_mode_response(response_cls(envelope_id=envelope))
            except Exception as e:
                LOG.warning("ack failed: %s", safe_failure(e))
        if getattr(req, "type", None) != "events_api":
            return
        payload = getattr(req, "payload", None) or {}
        try:
            bridge.handle_event(payload.get("event") or {}, payload.get("team_id"))
        except Exception as e:
            LOG.error("event failed: %s", safe_failure(e))

    return listener


# ---------------------------------------------------------------- tokens


def _keychain(service: str, run: Callable = subprocess.run, secret: bool = True) -> Optional[str]:
    argv = [SECURITY, "find-generic-password", "-s", service] + (["-w"] if secret else [])
    try:
        r = run(argv, capture_output=True, text=True, timeout=10)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return (r.stdout.strip() or None) if secret else "present"


def read_tokens(env=None, run: Callable = subprocess.run) -> Tuple[Optional[str], Optional[str]]:
    env = os.environ if env is None else env
    bot = env.get("SLACK_BOT_TOKEN") or _keychain(KEYCHAIN_BOT, run)
    app = env.get("SLACK_APP_TOKEN") or _keychain(KEYCHAIN_APP, run)
    return bot, app


def tokens_present(env=None, run: Callable = subprocess.run) -> Tuple[bool, bool]:
    """Whether each token is there, without reading a secret out of the keychain."""
    env = os.environ if env is None else env
    bot = bool(env.get("SLACK_BOT_TOKEN")) or _keychain(KEYCHAIN_BOT, run, secret=False) is not None
    app = bool(env.get("SLACK_APP_TOKEN")) or _keychain(KEYCHAIN_APP, run, secret=False) is not None
    return bot, app


# ---------------------------------------------------------------- state + status


def write_state(paths: Paths, state: str, detail: str = "") -> None:
    try:
        _write_atomic(
            paths.state,
            json.dumps({"state": state, "detail": detail, "since": time.time(), "pid": os.getpid()}),
        )
    except OSError:
        pass


def read_state(paths: Paths) -> dict:
    try:
        raw = json.loads(paths.state.read_text())
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _alive(pid_file: Path) -> Optional[int]:
    try:
        pid = int(pid_file.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


SETUP = "~/.claude/skills/colleague/bridges/slack/README.md"


def check(paths: Paths, env=None, run: Callable = subprocess.run) -> Tuple[bool, List[str]]:
    """(ready, lines): whether the bridge could start, and why not."""
    try:
        cfg = load_config(paths.config)
    except ConfigError as e:
        if str(e) == "missing":
            return False, ["not configured", "  no ~/.voicemode/call/slack.json yet", f"  setup: {SETUP}"]
        return False, ["not configured", f"  slack.json: {e}", f"  setup: {SETUP}"]
    bot, app = tokens_present(env, run)
    if not (bot and app):
        missing = " and ".join(n for n, ok in (("bot token", bot), ("app token", app)) if not ok)
        return False, [
            "not configured",
            f"  no {missing}: set SLACK_BOT_TOKEN / SLACK_APP_TOKEN, or add them to the keychain",
            f"  ({KEYCHAIN_BOT}, {KEYCHAIN_APP}; see {SETUP})",
        ]
    return True, [f"ready: {cfg.summary()}"]


def status(paths: Paths, env=None, run: Callable = subprocess.run) -> List[str]:
    ready, lines = check(paths, env, run)
    pid = _alive(paths.pid)
    if pid is None:
        if not ready:
            return [f"slack: {lines[0]}"] + lines[1:]
        last = read_state(paths)
        if last.get("state") == "error" and last.get("detail"):
            return [
                f"slack: not running, last error: {last['detail']}",
                "  log: ~/.voicemode/call/slack-bridge.log; start again with ~/.claude/skills/colleague/bin/bridge start",
            ]
        return [
            f"slack: stopped ({lines[0][len('ready: '):]})",
            "  start it with ~/.claude/skills/colleague/bin/bridge start",
        ]
    st = read_state(paths)
    state = st.get("state") or "starting"
    since = st.get("since")
    when = _dt.datetime.fromtimestamp(since).strftime("%H:%M") if isinstance(since, (int, float)) else "?"
    head = f"slack: {state} since {when} (pid {pid})"
    if st.get("detail"):
        head += f": {st['detail']}"
    out = [head]
    if not ready:
        out += ["  note: " + lines[0]] + lines[1:]
    return out


# ---------------------------------------------------------------- run


def load_sdk() -> Any:
    from slack_sdk.socket_mode import SocketModeClient  # noqa: imported only to run
    from slack_sdk.socket_mode.response import SocketModeResponse
    from slack_sdk.web import WebClient

    class Sdk:
        pass

    sdk = Sdk()
    sdk.WebClient = WebClient
    sdk.SocketModeClient = SocketModeClient
    sdk.SocketModeResponse = SocketModeResponse
    return sdk


def setup_logging(paths: Paths) -> None:
    paths.call.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(str(paths.log), maxBytes=512_000, backupCount=2)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)
    # slack_sdk logs request details at DEBUG; keep it to warnings.
    logging.getLogger("slack_sdk").setLevel(logging.WARNING)
    try:
        os.chmod(paths.log, 0o600)
    except OSError:
        pass


def serve(
    paths: Paths,
    cfg: Config,
    bot_token: str,
    app_token: str,
    sdk: Any,
    stop: threading.Event,
    poll_s: float = 1.0,
) -> int:
    """Connect, then post replies every `poll_s` until `stop` is set."""
    web = sdk.WebClient(token=bot_token)
    try:
        auth = web.auth_test()
    except Exception as e:
        write_state(paths, "error", f"auth.test failed: {safe_failure(e)}")
        LOG.error("auth.test failed: %s", safe_failure(e))
        return 4
    bot_user, team = auth.get("user_id"), auth.get("team_id")
    if cfg.team and team != cfg.team:
        write_state(paths, "error", "the bot token is for another workspace than slack.json's team")
        LOG.error("team mismatch: token team=%s, slack.json team=%s", team, cfg.team)
        return 4
    bridge = Bridge(cfg, web, paths, bot_user, team)
    sock = sdk.SocketModeClient(
        app_token=app_token, web_client=web, logger=logging.getLogger("slack_sdk.socket_mode")
    )
    sock.socket_mode_request_listeners.append(socket_listener(bridge, sdk.SocketModeResponse))
    write_state(paths, "connecting")
    LOG.info("connecting: bot=%s team=%s (%s)", bot_user, team, cfg.summary())
    try:
        sock.connect()
    except Exception as e:
        write_state(paths, "error", f"Socket Mode connect failed: {safe_failure(e)}")
        LOG.error("connect failed: %s", safe_failure(e))
        return 5
    last = "connecting"
    cfg_mtime = _mtime(paths.config)
    while not stop.is_set():
        # An edited slack.json takes effect at once, so taking someone off the list is immediate.
        mtime = _mtime(paths.config)
        if mtime != cfg_mtime:
            cfg_mtime = mtime
            try:
                fresh = load_config(paths.config)
                with bridge.lock:
                    bridge.cfg = fresh
                LOG.info("slack.json reloaded (%s)", fresh.summary())
            except ConfigError as e:
                LOG.error("slack.json not reloaded, keeping the last good one: %s", e)
        try:
            now_state = "connected" if sock.is_connected() else "connecting"
        except Exception:
            now_state = "connecting"
        if now_state != last:
            write_state(paths, now_state)
            LOG.info("%s", now_state)
            last = now_state
        try:
            bridge.flush_replies()
        except Exception as e:
            LOG.error("reply flush failed: %s", safe_failure(e))
        stop.wait(poll_s)
    try:
        sock.close()
    except Exception:
        pass
    write_state(paths, "stopped")
    LOG.info("stopped")
    return 0


def run(paths: Optional[Paths] = None) -> int:
    paths = paths or Paths.default()
    setup_logging(paths)
    try:
        cfg = load_config(paths.config)
    except ConfigError as e:
        write_state(paths, "error", "no slack.json" if str(e) == "missing" else f"slack.json: {e}")
        LOG.error("not configured: %s", e)
        return 3
    bot, app = read_tokens()
    if not bot or not app:
        write_state(paths, "error", "no tokens (environment or keychain)")
        LOG.error("not configured: tokens missing")
        return 3
    if not bot.startswith("xoxb-") or not app.startswith("xapp-"):
        write_state(paths, "error", "tokens have the wrong kind: bot is xoxb-, app is xapp-")
        LOG.error("not configured: token kinds wrong")
        return 3
    try:
        sdk = load_sdk()
    except ImportError:
        write_state(paths, "error", f"{SDK_PIN} is not installed; start it with bin/bridge start")
        LOG.error("slack_sdk missing")
        return 3
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    _write_atomic(paths.pid, f"{os.getpid()}\n")
    try:
        return serve(paths, cfg, bot, app, sdk, stop)
    finally:
        try:
            if paths.pid.read_text().strip() == str(os.getpid()):
                paths.pid.unlink()
        except OSError:
            pass


def main(argv: List[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "status"
    paths = Paths.default()
    if cmd == "run":
        return run(paths)
    if cmd == "check":
        ready, lines = check(paths)
        print("\n".join(lines))
        return 0 if ready else 3
    if cmd == "status":
        print("\n".join(status(paths)))
        return 0
    print(__doc__.split("\n\n")[1])
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
