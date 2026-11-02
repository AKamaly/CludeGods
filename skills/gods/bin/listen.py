#!/usr/bin/env python3
"""Stream the user's finished turns from the VoiceMode ears, one line each, for Monitor.

Tails ~/.voicemode/logs/conversations/heard_*.jsonl from its current end and prints:

    USER: <text>                               a turn of theirs
    USER (mid-thought, wait for more): <text>  they paused without finishing the sentence
    USER (over you): <text>                    they spoke over me; my own words removed, and
                                               my speech already cut (`call hush`)
    USER (over you, full turn): <text>         the whole turn behind a barge-in already sent
    USER (earlier, HH:MM, …): <text>           said while no listener was running (the
                                               Monitor had expired), delivered on re-arm
    EARS: down (<why>)                         the capture stopped or went silent
    EARS: muted / EARS: unmuted                they turned the mic off or on with the pill
    USER: Stop. (...)                          they pressed Stop on the pill
    PANE: ...                                  a request from the Workers pane mod
    FOCUS: on key=… name=… voice=… session=…    a worker was put on the call (`call focus`)
    FOCUS: off                                 the call is back with the main colleague
    MIC: talk (…) / MIC: open (…)              the mic mode changed (`call mode`, the pill)
    CALL: moved to another chat (…)            /gods started in another chat, which has the
                                               call now; this listener exits

USER is the label: "user_label" in ~/.voicemode/call/config.json (default USER), read when
the listener starts. The mic mode is "call": {"mic": "open"|"talk"} in the same file, read
twice a second. A missing or broken file means the defaults; other keys are not ours.

Catch-up. The Monitor that runs this expires every 30 minutes. The listener keeps a cursor
(~/.voicemode/call/listen.cursor: the log, a byte offset, the call's start, and the focus,
mute, mic mode and Stop press it last reported). Re-armed on the same call, it resumes from
the cursor, also across midnight into the next day's log, so a turn spoken while no listener
ran is delivered as `USER (earlier, …)` instead of being lost, and a Stop, mute, focus or
mode change made meanwhile is reported first. On SIGTERM (the Monitor's expiry) it writes
the cursor and exits quietly.

Talk mode ("call": {"mic": "talk"}). The mic is off between turns; `call talk` opens it for
one turn and starts `listen.py --talk-watch`, which closes it after his first turn, or when
nothing is said. His turns then go out whole (no "mid-thought": nothing more is coming),
and the ears starting and stopping for each turn is not news (no EARS lines unless they
fail).

Echo. On laptop speakers the mic hears the mouth (my lines AND the filler clips), and
there is no echo canceller. So on speakers the gate is half-duplex: a turn whose audio
STARTS while I am playing (plus a tail) is treated as my echo, my words are stripped, and
only a remainder of three words or more gets through. A turn he started before I began
keeps everything except my words. On headphones nothing is stripped (no echo there).
Timing uses the turn's real audio span (capture start + t0/t1), not when the slower
transcription finished, so a late transcript cannot slip past the window.

Barge-in. While one of my lines is playing, each mic partial (about 2 s of audio, decoded)
is checked at once. On headphones any partial of two words or more is him: `call hush` runs
and `USER (over you): <words>` goes out without waiting for the turn to end. On speakers the
partial must carry two content words (not stopwords, not backchannels) that are not in the
line(s) the mic could be hearing, matched loosely (digits as words, near spellings, split
compounds) because the echo comes back garbled. The turn that follows a barge-in is sent as
`USER (over you, full turn)` if it adds words, and dropped if it adds nothing.

    listen.py                       live, for Monitor
    listen.py --replay FILE [--since HH:MM:SS] [--speakers|--headphones]
                                    run a past log through the gate, print every decision
                                    (HUSH lines are barge-ins: the mouth cut, his words sent)
    listen.py --selftest            synthetic logs: barge-in hushes and emits, echo does not
    listen.py --status              how the ears are doing: last heartbeat, last turn, how far
                                    behind the transcripts land, the label, the listener
    listen.py --worker NAME         a worker by exact key or exact name: key, name, voice,
                                    session, god (tab-separated); exit 1 if there is none
    listen.py --receipt --start EPOCH [--stop EPOCH]
                                    the call receipt: his turns (through the same echo gate)
                                    and the spoken replies, as a page in the Spaces "calls"
                                    space (~/.voicemode/call/spaces/calls/<date-time>.md)
    listen.py --replay-rearm FILE [--every S] [--gap S,S] [--stale] [--speakers|--headphones]
                                    replay a real log as if the Monitor expired every S
                                    seconds (default 1800) and was re-armed after each gap
                                    (default 5,30,120): every turn the gate passes must reach
                                    the call exactly once, compared with one listener that
                                    never expired (--stale: the cursor a second behind)
    listen.py --talk-watch TOKEN    close the mic after one talk turn (`call talk` runs it)
    listen.py --set-mic open|talk   write "call": {"mic": …} into config.json, keeping every
                                    other key (`call mode` runs it)

Standard library only.
"""

import argparse
import difflib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

LOG_DIR = Path.home() / ".voicemode" / "logs" / "conversations"
CALL_DIR = Path.home() / ".voicemode" / "call"
PY = Path(os.environ.get("VOICEMODE_PY") or Path.home() / ".local/share/uv/tools/voice-mode/bin/python")

LEAD_S = 0.3              # my audio may reach the mic a hair before 'saying' is logged
TAIL_S = 1.5              # room and device tail after a line ends
MIN_OVER_WORDS = 3        # what must survive echo stripping for a turn that began over me
MIN_OVER_CONTENT = 2      # ...of which this many are real words, not "and I was"
STT_LATENCY_S = 0.3       # the fastest a partial can land after its chunk ends
BARGE_MIN_WORDS = 2       # headphones: a partial this long while I speak is him, cut at once
BARGE_MIN_CONTENT = 2     # speakers: content words of his, not in my line, to cut
ECHO_SHARE = 0.6          # speakers: a partial this much my line needs one more word of his
BARGE_SLACK_S = 2.0       # speakers: my line's echo can still be in a partial this much later
BARGE_LINK_S = 20.0       # a barge-in with no turn covering it is forgotten after this
OPEN_MAX_S = 180.0        # a 'saying' with no 'said' after this long is stale, not playing
ECHO_TEXT_SHARE = 0.8     # speakers: a mic line this much one recent line of mine is my echo,
ECHO_TEXT_MIN = 3         # ...whatever its timing, if it has at least this many words
ECHO_RECENT_S = 60.0      # how long a line of mine can still come back through a slow STT
ECHO_RUN = 2              # his words around an echo come as a run of at least this many;
                          # single survivors scattered through my line are garble ("2nd", "92")
ECHO_CHARS = 0.58         # speakers: a partial whose letters match a stretch of my line this
                          # well is my echo, however garbled its words ("Gin's tuna" heard over
                          # "...questions to a..."). On two days of real calls, every barge-in
                          # candidate of his scored 0.27-0.54 and the echoes 0.59-0.62. A miss
                          # here only delays the cut to the end of his turn.
ECHO_CHARS_TURN = 0.62    # ...and a turn's leftover over me: stricter, a miss here drops words
ECHO_CHARS_MIN = 8        # ...judged only on partials with at least this many letters
CATCHUP_MAX_S = 3600.0    # a cursor older than this is not resumed
CATCHUP_MAX_LINES = 10    # at most this many earlier turns are delivered on re-arm
FRESH_S = 60.0            # a caught-up turn younger than this goes out as a normal turn
START_WINDOW_S = 120.0    # a listener armed this soon after `call start` hears the whole call
EARS_GRACE_S = 10.0       # after starting, how long before "the ears are not running" is said
TALK_START_S = 15.0       # talk: the ears must be up this soon after the press
TALK_WAIT_S = float(os.environ.get("CALL_TALK_WAIT_S") or 10)  # talk: open this long with
                                                                # nothing said closes the mic
TALK_MAX_S = float(os.environ.get("CALL_TALK_MAX_S") or 90)    # talk: one turn at most this long
MIC_MODES = ("open", "talk")
CALL = Path(__file__).resolve().parent / "call"
CONFIG = CALL_DIR / "config.json"
CURSOR = CALL_DIR / "listen.cursor"
DEFAULT_LABEL = "USER"
STOPWORDS = set("a an the and or but so i you he she we they it is was are be been to of in on "
                "at as for with that this my me your just um uh".split())
BARGE_STOPWORDS = STOPWORDS | set(
    "yeah yes yep yup ok okay mm mmm mhm hmm ah oh right sure cool nice great good thanks thank "
    "not do does did have has had will would can could there here what like well got see "
    "all its im".split())
NUMBERS = dict(zip("0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20".split(),
                   "zero one two three four five six seven eight nine ten eleven twelve thirteen "
                   "fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()))
HEARTBEAT_LIMIT_S = 150   # ears heartbeat every 60 s; two missed means down
NOISE = re.compile(r"^[\W_]*$|^\[?blank_audio\]?$", re.I)
CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")
CONTRACTIONS = [("n't", " not"), ("'re", " are"), ("'ll", " will"), ("'ve", " have"),
                ("'m", " am"), ("'d", " would"), ("'s", " is")]
HEADPHONES = re.compile(r"airpods|headphone|headset|buds|beats", re.I)

# Workers (~/.voicemode/call/workers.json, registry v2). A worker's voice is its "voice", else
# its god's default; its god is "god", else derived from the "avatar" colour.
GOD_VOICE = {"colleague": "af_heart", "research": "af_nicole", "scribe": "bf_emma",
             "scout": "am_adam", "sales": "am_michael", "herald": "bm_george"}
AVATAR_GOD = [("purple", "research"), ("violet", "research"), ("blue", "scribe"),
              ("green", "scout"), ("orange", "sales"), ("red", "sales"), ("yellow", "herald")]


def load_config(path=None):
    """~/.voicemode/call/config.json as a dict; missing, unreadable or not an object is {}.
    Shared with other parts (their keys, e.g. "approvals" and "workers", are not read here)."""
    try:
        data = json.loads((path or CONFIG).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def user_label(cfg=None):
    """The label his lines start with: config "user_label", else USER. Colons, brackets and
    line breaks are taken out (they delimit the label), and it is at most 32 characters."""
    v = (load_config() if cfg is None else cfg).get("user_label")
    if not isinstance(v, str):
        return DEFAULT_LABEL
    v = re.sub(r"[\s:()\[\]]+", " ", v).strip()[:32].strip()
    return v or DEFAULT_LABEL


def mic_mode(cfg=None):
    """The mic mode: config "call": {"mic": "talk"} is push to talk, anything else "open"."""
    c = (load_config() if cfg is None else cfg).get("call")
    m = c.get("mic") if isinstance(c, dict) else None
    return m if m in MIC_MODES else "open"


def set_mic(mode, path=None):
    """Write "call": {"mic": mode} into config.json, keeping every other key (and every other
    key under "call"). A file that is not a JSON object is left alone: returns an error text,
    or None when written."""
    path = path or CONFIG
    if mode not in MIC_MODES:
        return f"unknown mic mode '{mode}' (open or talk)"
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError) as e:
        return f"{path.name} is not readable JSON ({e}); fix it first, nothing was changed"
    if not isinstance(data, dict):
        return f"{path.name} is not a JSON object; nothing was changed"
    call = data.get("call") if isinstance(data.get("call"), dict) else {}
    data["call"] = {**call, "mic": mode}
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(f".{path.name}.part")
    part.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    part.replace(path)
    return None


def mic_line(mode):
    if mode == "talk":
        return ("MIC: talk (push to talk: the mic opens only when they press talk, and each of "
                "their lines arrives as a whole turn)")
    return "MIC: open (the mic is always on again)"


def load_workers(call_dir=None):
    try:
        data = json.loads(((call_dir or CALL_DIR) / "workers.json").read_text())
    except (OSError, ValueError):
        return []
    ws = data.get("workers") if isinstance(data, dict) else None
    return [w for w in ws or [] if isinstance(w, dict) and w.get("key")]


def god_of(w):
    if w.get("god") in GOD_VOICE:
        return w["god"]
    avatar = str(w.get("avatar") or "").lower()
    for colour, god in AVATAR_GOD:
        if colour in avatar:
            return god
    return "colleague"


def voice_of(w):
    v = w.get("voice")
    return v.strip() if isinstance(v, str) and v.strip() else GOD_VOICE[god_of(w)]


def transcript_stem(w):
    name = os.path.basename(str(w.get("transcript") or "").strip())
    return name[:-6] if name.endswith(".jsonl") else name


def find_worker(text, workers):
    """The worker whose key is exactly `text`, else whose name is exactly `text` (any case).
    Never a near match: a wrong worker on the call is worse than asking."""
    text = (text or "").strip()
    for w in workers:
        if w["key"] == text:
            return w
    for w in workers:
        if str(w.get("name") or "").strip().lower() == text.lower() and text:
            return w
    return None


def read_focus(call_dir=None):
    try:
        return ((call_dir or CALL_DIR) / "focus").read_text().strip()
    except OSError:
        return ""


def focus_line(key, workers):
    if not key:
        return "FOCUS: off (the call is back with you, the main colleague)"
    w = find_worker(key, workers)
    if not w or w["key"] != key:
        return f"FOCUS: on key={key} (not in the registry)"
    return (f"FOCUS: on key={key} name={w.get('name') or key} voice={voice_of(w)} "
            f"session={w.get('session') or ''}")


def ts(rec):
    return datetime.fromisoformat(rec["ts"]).timestamp()


def words(text):
    text = text.lower().replace("’", "'")
    for short, full in CONTRACTIONS:
        text = text.replace(short, full)
    return re.findall(r"[^\W_]+", text)


def strip_echo(text, lines):
    """Drop every run of two or more words that also appears in one of my lines, then any
    stray leftover word those lines contain. What survives is his."""
    heard = words(text)
    keep = [True] * len(heard)
    said_all = set()
    for line in lines:
        said = words(line)
        said_all.update(said)
        sm = difflib.SequenceMatcher(None, heard, said, autojunk=False)
        for block in sm.get_matching_blocks():
            if block.size >= 2:
                for i in range(block.a, block.a + block.size):
                    keep[i] = False
    if not all(keep):
        keep = [k and w not in said_all for w, k in zip(heard, keep)]
    return " ".join(w for w, k in zip(heard, keep) if k), not all(keep)


def spoken(text):
    """words(), with digits read out the way whisper may spell them back ("2" -> "two")."""
    return [NUMBERS.get(w, w) for w in words(text)]


def mine_word(w, said, joined):
    """Is this heard word plausibly my own line coming back through the mic? Loose on
    purpose: on speakers the echo comes back garbled ("Mike Goff" for "Mic off")."""
    if w in said:
        return True
    if len(w) >= 4 and w in joined:           # "voice mode" heard for "VoiceMode"
        return True
    if len(w) < 3:
        return False
    for s in said:
        if len(s) < 3:
            continue
        if w.startswith(s[:4]) and s.startswith(w[:4]) and min(len(w), len(s)) >= 4:
            return True                        # "filters" for "filtering"
        if abs(len(w) - len(s)) <= 1 and (s in w or w in s):
            return True                        # "goff" for "off", "used" for "use"
        if difflib.SequenceMatcher(None, w, s).ratio() >= 0.8:
            return True                        # "mike" for "mic"
    return False


def mine_flags(heard, said, joined):
    """mine_word() for each heard word, plus a word the STT split in two ("out box" for
    "outbox", "voice mode" for "VoiceMode"): both halves are mine when they join into one of
    my words. A stopword between two words of his stays his ("what about item three")."""
    flags = [mine_word(w, said, joined) for w in heard]
    for i in range(len(heard) - 1):
        pair = heard[i] + heard[i + 1]
        if pair in said or (len(pair) >= 6 and pair in joined):
            flags[i] = flags[i + 1] = True
    for i in range(1, len(heard) - 1):
        if flags[i] and heard[i] in STOPWORDS and not flags[i - 1] and not flags[i + 1]:
            flags[i] = False
    return flags


def his_runs(heard, flags, run=ECHO_RUN):
    """His words in a heard line that mixes his speech and my echo: only runs of `run` or
    more consecutive words that are not mine. He talks before or after my line comes back,
    not one word at a time inside it; lone survivors are the echo garbled."""
    out, cur = [], []
    for w, f in zip(heard + [None], flags + [True]):
        if f:
            if len(cur) >= run:
                out.extend(cur)
            cur = []
        else:
            cur.append(w)
    return out


def letters(text):
    return re.sub(r"[^a-z0-9]", "", text.lower())


def char_echo(text, lines, enough=1.0):
    """How well the heard text's letters match the best stretch of one of my lines (0..1).
    Catches an echo whose words come back wrong but whose sounds come back right. Stops
    early once `enough` is reached."""
    h = letters(text)
    if not h:
        return 0.0
    n, best = len(h), 0.0
    for line in lines:
        if best >= enough:
            break
        s = letters(line)
        for i in range(0, max(1, len(s) - n + 1)):
            for w in (n - 2, n, n + 3):
                sm = difflib.SequenceMatcher(None, h, s[i:i + max(1, w)], autojunk=False)
                if sm.quick_ratio() > best:
                    best = max(best, sm.ratio())
            if best >= enough:
                break
    return best


def his_words(text, lines):
    """His content words in a partial heard while I spoke, or [] if it is my echo. A
    partial that is mostly my line (a garbled echo keeps most of its words) must carry
    one more word of his than usual to count."""
    said, joined = set(), ""
    for line in lines:
        ws = spoken(line)
        said.update(ws)
        joined += "".join(ws) + " "
    heard = spoken(text)
    flags = mine_flags(heard, said, joined)
    his = [w for w, f in zip(heard, flags) if not f]
    content = [w for w in his if w not in BARGE_STOPWORDS]
    need = BARGE_MIN_CONTENT + (1 if heard and 1 - len(his) / len(heard) >= ECHO_SHARE else 0)
    if len(content) < need:
        return []
    if len(letters(text)) >= ECHO_CHARS_MIN and char_echo(text, lines, ECHO_CHARS) >= ECHO_CHARS:
        return []
    return his


def filler_text():
    try:
        return json.loads((CALL_DIR / "fillers" / "index.json").read_text())
    except (OSError, ValueError):
        return {}


def on_headphones():
    """Headphones keep the mouth out of the mic, so there is no echo to strip."""
    try:
        name = (CALL_DIR / "device").read_text()
    except OSError:
        return False
    return HEADPHONES.search(name) is not None


def play_filler():
    """A short 'Mm-hm.' / 'Okay, let me see.' the moment his turn lands, pre-rendered so it
    plays before the model has even started, queued through the mouth so the reply follows."""
    clips = sorted((CALL_DIR / "fillers").glob("*.wav"))
    if not clips:
        return
    clip = clips[int(time.time() * 1000) % len(clips)]
    device = (CALL_DIR / "device").read_text().strip()
    subprocess.Popen([str(PY), "-m", "voice_mode.mouth", "play", "--device", device, str(clip)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Gate:
    """Everything the heard log tells us, and the decision for each of his turns."""

    def __init__(self, headphones, label=DEFAULT_LABEL, talk=lambda: False):
        self.headphones = headphones   # a callable, so a device switch mid-call is honoured
        self.label = label             # what his lines start with (config "user_label")
        self.talk = talk               # a callable: push to talk, so every turn is whole
        self.capture_start = None
        self.live_events = False       # set once the initial catch-up read is done
        self.offsets = []              # wall ts minus capture time, from recent partials
        self.anchors = []              # capture-to-wall shifts measured from my own echo
        self.mouth = {}                # utt -> {"text", "start", "end"}
        self.fillers = filler_text()
        self.barged_utts = set()       # lines a barge-in already cut
        self.barge = None              # the last barge-in, until its turn arrives

    def feed(self, rec, now=None):
        """Returns ("emit", line, ack) / ("drop", why) / ("down", why) / None."""
        kind, source = rec.get("kind"), rec.get("source")

        if source == "mouth":
            utt = rec.get("utt")
            if kind == "saying":
                text = rec.get("text") or ""
                clip = re.match(r"\[sound (.+?)\]", text)
                if clip:  # a filler clip: give the gate its words
                    text = self.fillers.get(Path(clip.group(1)).name, "")
                self.mouth[utt] = {"text": text, "start": ts(rec), "end": None}
            elif kind == "said" and utt in self.mouth:
                self.mouth[utt]["end"] = ts(rec)
            for old in list(self.mouth)[:-12]:
                self.mouth.pop(old)
            return None

        if kind == "event":
            if rec.get("event") == "listen-started":
                restarted = self.capture_start is not None
                self.capture_start = ts(rec)
                self.offsets = []
                self.anchors = []
                if restarted and (CALL_DIR / "muted").exists() is False and self.live_events:
                    return ("up",)
            elif rec.get("event") == "listen-stopped":
                return ("down", rec.get("reason", "stopped"))
            return None

        if kind == "partial" and source == "mic" and self.capture_start and "t1" in rec:
            # capture time lags wall time by a steady offset (audio starts flowing after
            # listen-started is logged); a partial lands one STT pass after its chunk ends
            self.offsets = (self.offsets + [ts(rec) - (self.capture_start + rec["t1"])])[-30:]
            if not self.headphones():
                rest = self.text_echo(rec)
                if rest is not None and not self.enough(rest):
                    return None    # my own line coming back, however late the STT is
            return self.check_barge(rec, now)

        if kind != "turn" or source != "mic" or rec.get("via") == "converse":
            return None

        out = self.judge_turn(rec, now)
        return self.after_barge(rec, out)

    def text_echo(self, rec):
        """Is this mic text one of my recent lines coming back, judged by its words alone?
        Timing can't be trusted at the start of a call: the STT's first passes land 15 s
        or more late, so the offset learned from partials runs far ahead of the truth.
        A match also measures the real capture-to-wall shift (self.anchors). Returns None,
        or the words left once mine are taken out (his, if enough survive: "What about item
        3?" in front of a whole echoed line of mine)."""
        heard = spoken(rec.get("text") or "")
        if len(heard) < ECHO_TEXT_MIN:
            return None
        at = ts(rec)
        for utt, m in reversed(list(self.mouth.items())):
            if m["start"] > at + LEAD_S or at - m["start"] > ECHO_RECENT_S:
                continue
            said = spoken(m["text"])
            flags = mine_flags(heard, set(said), "".join(said) + " ")
            if sum(flags) / len(heard) < ECHO_TEXT_SHARE:
                continue
            rest = his_runs(heard, flags)
            if self.capture_start is not None and "t0" in rec and said:
                # where in my line the heard words start, and so when that audio played
                block = next((b for b in difflib.SequenceMatcher(None, heard, said, autojunk=False)
                              .get_matching_blocks() if b.size), None)
                frac = block.b / len(said) if block else 0.0
                dur = (m["end"] - m["start"]) if m["end"] else 0.35 * len(said)
                self.anchors = (self.anchors + [m["start"] + frac * dur
                                                - (self.capture_start + rec["t0"])])[-10:]
            return rest
        return None

    @staticmethod
    def enough(rest):
        """Do the words left after my echo come out stand as a turn of his?"""
        return (rest is not None and len(rest) >= MIN_OVER_WORDS
                and len([w for w in rest if w not in STOPWORDS]) >= MIN_OVER_CONTENT)

    def audio_span(self, rec):
        """The wall-clock span of a turn's or partial's audio. The latency-based shift is an
        upper bound (a partial can't land sooner than STT_LATENCY_S after its chunk); my own
        echo, when heard, pins the real shift, so the smaller of the two wins."""
        if self.capture_start is not None and self.offsets and "t0" in rec and "t1" in rec:
            shift = min(self.offsets) - STT_LATENCY_S
            if self.anchors:
                shift = min(shift, sorted(self.anchors)[len(self.anchors) // 2])
            shift += self.capture_start
            return shift + rec["t0"], shift + rec["t1"]
        a1 = ts(rec) - 0.7
        return a1 - (rec.get("t1", 0) - rec.get("t0", 0)), a1

    def check_barge(self, rec, now=None):
        """A partial while I am speaking: is it him asking for the floor? Returns
        ("barge", line) and remembers it, so the turn that follows is not sent twice."""
        now = now if now is not None else time.time()
        text = (rec.get("text") or "").strip()
        if not text or NOISE.match(text) or CJK.search(text):
            return None
        open_lines = {u: m for u, m in self.mouth.items()
                      if m["end"] is None and now - m["start"] < OPEN_MAX_S
                      and u not in self.barged_utts}
        if not open_lines:
            return None
        a0, a1 = self.audio_span(rec)
        # his audio must reach into a line that is playing, not be the tail of the
        # turn that I am now answering
        if not any(a1 >= m["start"] - LEAD_S for m in open_lines.values()):
            return None
        if self.headphones():
            said = words(text)
            if len(said) < BARGE_MIN_WORDS:
                return None
        else:
            lines = [m["text"] for m in self.mouth.values()
                     if m["start"] - LEAD_S <= a1
                     and (m["end"] or min(now, m["start"] + OPEN_MAX_S)) + TAIL_S + BARGE_SLACK_S >= a0]
            if not his_words(text, lines):
                return None
        self.barged_utts.update(open_lines)
        fresh = self.barge is None or now - self.barge["at"] > BARGE_LINK_S
        if fresh:
            self.barge = {"at": now, "a0": a0, "a1": a1, "words": set(words(text))}
        else:  # still the same barge-in: cut the new line, do not send his words twice
            self.barge["words"].update(words(text))
            self.barge["a1"] = max(self.barge["a1"], a1)
        # his words as heard, not echo-stripped: stripping can drop his "not" when my line
        # had one, and the turn that follows is stripped properly anyway
        return ("barge", f"{self.label} (over you): {text}" if fresh else None)

    def after_barge(self, rec, out):
        """The turn behind a barge-in (its audio covers the barge partial): send what it
        adds, or nothing if it adds nothing. Earlier turns pass by untouched."""
        b = self.barge
        if not b:
            return out
        t0, t1 = self.audio_span(rec)
        if t1 < b["a0"] - 1.0 or (out and out[1] == "noise"):
            if ts(rec) - b["at"] > BARGE_LINK_S:
                self.barge = None
            return out             # an earlier turn of his, or a stray: the barge's turn is next
        self.barge = None
        if t0 > b["a1"] + 1.0 or not out or out[0] != "emit":
            return out             # not the turn he barged with
        label, text = out[1].split(": ", 1)
        extra = [w for w in words(text) if w not in b["words"] and w not in STOPWORDS]
        if not extra:
            return ("drop", "already sent as barge-in")
        wait = ", mid-thought, wait for more" if "mid-thought" in label else ""
        return ("emit", f"{self.label} (over you, full turn{wait}): {text}", False)

    def judge_turn(self, rec, now=None):
        text = (rec.get("text") or "").strip()
        if NOISE.match(text) or CJK.search(text):
            return ("drop", "noise")

        if not self.headphones():
            rest = self.text_echo(rec)
            if rest is not None:
                if not self.enough(rest):
                    return ("drop", "echo of me (by its words)")
                return ("emit", f"{self.label}: {' '.join(rest)}", True)

        a0, a1 = self.audio_span(rec)  # the turn's real audio span

        if not self.headphones():
            now = now if now is not None else time.time()
            windows = [(m["start"] - LEAD_S, (m["end"] if m["end"] else now) + TAIL_S, m["text"])
                       for m in self.mouth.values()]
            overlapping = [w for w in windows if w[0] <= a1 and w[1] >= a0]
            if overlapping:
                lines = [w[2] for w in overlapping]
                rest, echoed = strip_echo(text, lines)
                began_over_me = any(w[0] <= a0 <= w[1] for w in overlapping)
                if began_over_me:
                    # a garbled echo matches no two-word run ("Hmm, okay." -> "It was
                    # okay."), so here every word I said in that window comes out too
                    mine = {w for line in lines for w in words(line)}
                    rest = " ".join(w for w in rest.split() if w not in mine)
                    content = [w for w in rest.split() if w not in STOPWORDS]
                    if len(rest.split()) < MIN_OVER_WORDS or len(content) < MIN_OVER_CONTENT:
                        return ("drop", "echo of me")
                    if (len(letters(rest)) >= ECHO_CHARS_MIN
                            and char_echo(rest, lines, ECHO_CHARS_TURN) >= ECHO_CHARS_TURN):
                        return ("drop", "echo of me (garbled)")
                    return ("emit", f"{self.label} (over you): {rest}", False)
                if echoed:
                    if not rest:
                        return ("drop", "echo of me")
                    text = rest

        if self.talk() or (re.search(r"[.?!]['\"]?$", text) and not text.endswith(("...", "…"))):
            # push to talk: the mic closed after this turn, so no more is coming
            return ("emit", f"{self.label}: {text}", True)
        return ("emit", f"{self.label} (mid-thought, wait for more): {text}", False)


def mtime(path):
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def newest_log(log_dir=None):
    logs = sorted((log_dir or LOG_DIR).glob("heard_*.jsonl"))
    return logs[-1] if logs else None


def hush():
    subprocess.Popen([str(CALL), "hush"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def barge_in(line, cut=hush, say=print, mark=lambda: (CALL_DIR / "accepted").touch()):
    """He spoke over me: cut the mouth first (non-blocking), then hand the call his words."""
    cut()
    if line:
        mark()
        say(line, flush=True)


def deliver(out, label, cut=hush, say=print, mark=lambda: (CALL_DIR / "accepted").touch()):
    """Hand one of the gate's verdicts to the call. A turn that began over me cuts my speech
    too, so the call never has to run `call hush` itself; the full turn behind a barge-in does
    not (the call may already be answering the barge-in)."""
    if out[0] == "barge":
        barge_in(out[1], cut, say, mark)
    elif out[0] == "emit":
        if out[1].startswith(f"{label} (over you)") and \
                not out[1].startswith(f"{label} (over you, full turn"):
            cut()
        mark()  # the pill's Thinking follows this, not raw mic turns
        say(out[1], flush=True)


def call_id(call_dir=None):
    """The running call's start stamp (`call start` writes it, `call stop` removes it)."""
    try:
        return ((call_dir or CALL_DIR) / "started").read_text().strip()
    except OSError:
        return ""


def read_cursor(path=None):
    try:
        cur = json.loads((path or CURSOR).read_text())
    except (OSError, ValueError):
        return None
    return cur if isinstance(cur, dict) else None


def write_cursor(log, offset, call, path=None, now=None, state=None):
    """Where this listener is: the log, the byte offset of everything it has handled, the call,
    and (`state`) the focus, mute, mic mode and Stop press it last reported."""
    path = path or CURSOR
    cur = {"log": str(log), "offset": offset, "call": call,
           "at": now if now is not None else time.time()}
    if state is not None:
        cur["state"] = state
    try:
        part = path.with_name(path.name + ".part")
        part.write_text(json.dumps(cur))
        part.replace(path)
    except OSError:
        pass


def resume_offset(cursor, log, call, now=None):
    """Where in `log` the last listener of this call stopped (a byte offset), or None: no
    cursor, another call, another log (a new day), too old, or past the end of the file."""
    if not cursor or not call or cursor.get("call") != call or str(cursor.get("log")) != str(log):
        return None
    try:
        at, off = float(cursor.get("at") or 0), int(cursor.get("offset"))
        size = Path(log).stat().st_size
    except (TypeError, ValueError, OSError):
        return None
    if (now if now is not None else time.time()) - at > CATCHUP_MAX_S or not 0 <= off <= size:
        return None
    return off


def resume_logs(cursor, newest, call, now=None):
    """The logs a re-armed listener of this call reads, oldest first, as (log, offset): the
    cursor's own log from its offset, and when the day rolled over while no listener ran,
    first the rest of yesterday's log and then today's from its start. [] if nothing resumes."""
    if newest is None:
        return []
    newest = Path(newest)
    off = resume_offset(cursor, newest, call, now)
    if off is not None:
        return [(newest, off)]
    if not cursor or not call or cursor.get("call") != call:
        return []
    old = Path(str(cursor.get("log") or ""))
    if not old.name.startswith("heard_") or old.name >= newest.name:
        return []
    off = resume_offset(cursor, old, call, now)
    return [(old, off), (newest, 0)] if off is not None else []


def next_line(fh):
    """The next whole line of a log opened in binary mode, or None at the end. A line the
    ears are still writing (no newline yet) is left for the next read."""
    pos = fh.tell()
    raw = fh.readline()
    if not raw:
        return None
    if not raw.endswith(b"\n"):
        fh.seek(pos)
        return None
    return raw


def catch_up(fh, gate, label, offset=None, since=None, now=None):
    """Read the log to its end. Records up to `offset` (a byte offset) and before `since` (an
    epoch) only build the gate's state (the capture start, my recent lines, a barge-in in
    flight), at their own time, as the listener that saw them did; the ones after are judged,
    because no listener saw them. Returns his turns from that stretch, oldest first: as the
    gate says them if under FRESH_S old, else as `<label> (earlier, HH:MM, ...)`.
    With neither set, everything is read silently (a fresh listener follows from the end)."""
    now = now if now is not None else time.time()
    lines = []
    while True:
        raw = next_line(fh)
        if raw is None:
            break
        try:
            rec = json.loads(raw)
            missed = ((offset is not None and fh.tell() > offset)
                      or (since is not None and ts(rec) >= since))
            out = gate.feed(rec, now=ts(rec))
        except (ValueError, KeyError, TypeError):
            continue
        if not missed:
            continue
        if out and out[0] in ("barge", "emit") and out[1]:
            if now - ts(rec) <= FRESH_S:
                lines.append(out[1])
            else:
                lines.append(f"{label} (earlier, {datetime.fromtimestamp(ts(rec)):%H:%M}, said "
                             f"while no listener was running): {out[1].split(': ', 1)[1]}")
    return lines[-CATCHUP_MAX_LINES:]


def start_point(cursor, log, call, now=None):
    """(offset, since) for catch_up: resume this call's cursor; else, for a call that started
    in the last START_WINDOW_S (the greeting plays before the listener is armed), its start;
    else (None, None)."""
    now = now if now is not None else time.time()
    off = resume_offset(cursor, log, call, now)
    if off is not None:
        return off, None
    try:
        began = float(call)
    except ValueError:
        return None, None
    return (None, began) if 0 <= now - began <= START_WINDOW_S else (None, None)


def catch_up_all(gate, label, cursor, newest, call, now=None):
    """Open the newest log and read it to its end through catch_up: resuming this call's
    cursor (yesterday's log first if the day rolled over meanwhile), else from the call's
    start, else silently. Returns (lines, fh on the newest log, resumed)."""
    now = now if now is not None else time.time()
    plan = resume_logs(cursor, newest, call, now)
    if plan:
        lines = []
        for log, off in plan[:-1]:
            with open(log, "rb") as old:
                lines += catch_up(old, gate, label, off, None, now)
        fh = open(plan[-1][0], "rb")
        lines += catch_up(fh, gate, label, plan[-1][1], None, now)
        return lines[-CATCHUP_MAX_LINES:], fh, True
    fh = open(newest, "rb")
    offset, since = start_point(None, newest, call, now)
    return catch_up(fh, gate, label, offset, since, now), fh, False


def ears_alive(call_dir=None):
    try:
        os.kill(int(((call_dir or CALL_DIR) / "ears.pid").read_text()), 0)
        return True
    except (OSError, ValueError):
        return False


MUTED_LINE = "EARS: muted (the user turned the mic off on the pill; do not restart it)"


def stop_line(label, earlier=False):
    when = " while no listener was running" if earlier else ""
    return (f"{label}: Stop. (The user pressed Stop on the pill{when}: halt the current work and "
            "any helper agents now, then say in a few words that you stopped.)")


def call_state(call_dir=None, mic=None):
    """What the pill, the pane and `call` can change while no listener runs."""
    d = call_dir or CALL_DIR
    return {"focus": read_focus(d), "muted": (d / "muted").exists(),
            "mic": mic or mic_mode(load_config(d / "config.json")), "stop": mtime(d / "stop-request")}


def state_news(before, now, label, workers=None):
    """What changed since the last listener reported `before`, as the lines a live listener
    would have printed: a Stop press first (it halts work), then focus, mic mode, mute."""
    if not isinstance(before, dict):
        return []
    out = []
    try:
        if "stop" in before and now["stop"] > float(before["stop"]):
            out.append(stop_line(label, earlier=True))
    except (TypeError, ValueError):
        pass
    if "focus" in before and now["focus"] != before["focus"]:
        out.append(focus_line(now["focus"], load_workers() if workers is None else workers))
    if "mic" in before and now["mic"] != before["mic"]:
        out.append(mic_line(now["mic"]))
    if "muted" in before and now["muted"] != before["muted"]:
        out.append(MUTED_LINE if now["muted"] else "EARS: unmuted")
    return out


def read_owner(call_dir=None):
    try:
        return ((call_dir or CALL_DIR) / "session").read_text().strip()
    except OSError:
        return ""


def moved(me, owner):
    """The call belongs to another chat now: /gods ran there (`call start` records the
    session). A listener that does not know its own session never decides this."""
    return bool(me) and bool(owner) and owner != me


MOVED_LINE = ("CALL: moved to another chat (/gods started there, and that chat has the call now). "
              "This chat is off the call: do not re-arm the listener, do not speak, and do not "
              "run `call stop`.")


def live():
    label = user_label()
    mode = {"mic": mic_mode()}
    gate = Gate(on_headphones, label, talk=lambda: mode["mic"] == "talk")
    me = os.environ.get("CLAUDE_CODE_SESSION_ID", "").strip()
    if moved(me, read_owner()):   # a listener re-armed in the chat the call moved away from
        print(MOVED_LINE, flush=True)
        return
    path, fh, resumed = newest_log(), None, False
    cursor, call = read_cursor(), call_id()
    lines = []
    if path:
        # a re-arm on the same call resumes where the last listener stopped, so nothing he
        # said in between is lost; otherwise read history silently and follow from the end
        lines, fh, resumed = catch_up_all(gate, label, cursor, path, call)
        path = Path(fh.name)
    state = call_state(mic=mode["mic"])
    if resumed:  # what was pressed or switched meanwhile, then what he said
        lines = state_news((cursor or {}).get("state"), state, label) + lines
    for line in lines:
        print(line, flush=True)
    focus, last_stop = state["focus"], state["stop"]
    # "EARS: unmuted" only follows a mute the call was told about; a stop that is not a mute
    # (a mute undone at once, a mode switch) is checked again a moment later, not reported
    ears = {"muted_said": state["muted"], "down_check": 0.0}
    pos = {"at": fh.tell() if fh else 0}   # everything before this byte has been handled

    def snapshot():
        return {"focus": focus, "muted": muted_file.exists(), "mic": mode["mic"], "stop": last_stop}

    def save():
        if path:
            write_cursor(path, pos["at"], call_id(), state=snapshot())

    def on_term(signum, frame):
        # the Monitor's expiry: leave the cursor exactly where we are, and go quietly
        save()
        os._exit(0)

    gate.live_events = True
    started = last_seen = last_cursor = time.time()
    ears_checked = False
    stop_file, muted_file = CALL_DIR / "stop-request", CALL_DIR / "muted"
    save()
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, on_term)
    requests_dir = CALL_DIR / "requests"
    next_scan = 0.0

    def refresh_mode():
        """Re-read the mic mode; say so if it changed. True if it just changed."""
        new = mic_mode()
        if new == mode["mic"]:
            return False
        mode["mic"] = new
        print(mic_line(new), flush=True)
        return True

    while True:
        stop_at = mtime(stop_file)
        if stop_at > last_stop:
            last_stop = stop_at
            print(stop_line(label), flush=True)
        if time.time() >= next_scan:  # the Workers pane's requests, twice a second
            next_scan = time.time() + 0.5
            if moved(me, read_owner()):
                print(MOVED_LINE, flush=True)
                return
            refresh_mode()
            now_focus = read_focus()
            if now_focus != focus:  # `call focus` from this session, the pane or the pill
                focus = now_focus
                print(focus_line(focus, load_workers()), flush=True)
            for req in sorted(requests_dir.glob("*.json")):
                try:
                    r = json.loads(req.read_text())
                    if r.get("type") == "model":
                        print(f"PANE: switch model key={r.get('key')} session={r.get('session')} "
                              f"model={r.get('model')}", flush=True)
                    elif r.get("type") == "delete":
                        print(f"PANE: delete worker key={r.get('key')} session={r.get('session')}",
                              flush=True)
                except (OSError, ValueError):
                    pass
                req.unlink(missing_ok=True)
            if path and time.time() - last_cursor >= 1.0:
                save()
                last_cursor = time.time()
        talk = mode["mic"] == "talk"   # the ears are off between talk turns: that is not news
        if ears["down_check"] and time.time() >= ears["down_check"]:
            ears["down_check"] = 0.0
            if not ears_alive() and not muted_file.exists() and mode["mic"] != "talk":
                print("EARS: down (stopped)", flush=True)
        if not ears_checked and time.time() - started > EARS_GRACE_S:
            ears_checked = True  # said at once, not after the 150 s heartbeat limit
            if not ears_alive() and not muted_file.exists() and not talk:
                print("EARS: down (the ears are not running)", flush=True)
                last_seen = time.time()
        raw = next_line(fh) if fh else None
        if raw is None:
            newer = newest_log()
            if newer and newer != path:  # midnight roll
                path, fh = newer, open(newer, "rb")
                pos["at"] = 0
                continue
            if time.time() - last_seen > HEARTBEAT_LIMIT_S:
                if not muted_file.exists() and not talk:
                    print("EARS: down (no heartbeat)", flush=True)
                last_seen = time.time()
            time.sleep(0.1)
            continue
        last_seen = time.time()
        try:
            out = gate.feed(json.loads(raw))
        except (KeyError, ValueError, TypeError):
            out = None
        if out and out[0] in ("down", "up"):
            # a mode switch stops or starts the ears itself: say the switch, not the ears
            switched = refresh_mode()
            if out[0] == "down":
                if switched or (mode["mic"] == "talk" and out[1] in ("stop", "ceiling")):
                    pass   # a talk turn closing, or the switch to talk
                elif muted_file.exists():
                    if not ears["muted_said"]:
                        print(MUTED_LINE, flush=True)
                    ears["muted_said"] = True
                elif out[1] == "stop":
                    ears["down_check"] = time.time() + 3.0   # asked to stop: a restart may follow
                else:
                    print(f"EARS: down ({out[1]})", flush=True)
            else:
                ears["down_check"] = 0.0
                if ears["muted_said"] and not switched and mode["mic"] != "talk":
                    print("EARS: unmuted", flush=True)
                ears["muted_said"] = False
        elif out and out[0] in ("barge", "emit"):
            if out[0] == "emit" and out[2] and os.environ.get("CALL_FILLERS") == "on":
                play_filler()  # off by default: they sound canned
            deliver(out, label)
        pos["at"] = fh.tell()
        if out and out[0] in ("barge", "emit"):
            save()
            last_cursor = time.time()


class TalkWatch:
    """One push-to-talk turn: when to close the mic again. Fed the heard log from the press
    on: the mic closes after his first turn, when the ears stop by themselves, when the ears
    never come up, when the mic has been open TALK_WAIT_S with nothing said, or after
    TALK_MAX_S in all."""

    def __init__(self, armed_at, wait_s=None, start_s=TALK_START_S, max_s=None):
        self.armed_at = armed_at
        self.wait_s = TALK_WAIT_S if wait_s is None else wait_s
        self.start_s = start_s
        self.max_s = TALK_MAX_S if max_s is None else max_s
        self.live_at = None   # the capture this press started
        self.spoke = False

    def feed(self, rec):
        """A heard-log record; returns why the turn is over, or None."""
        try:
            t = ts(rec)
        except (ValueError, KeyError, TypeError):
            return None
        if t < self.armed_at or rec.get("source") != "mic":
            return None   # before the press: the previous capture
        kind, ev = rec.get("kind"), rec.get("event")
        if kind == "event" and ev == "listen-started":
            self.live_at = t
            return None
        if self.live_at is None or t < self.live_at:
            return None   # the previous capture's tail
        if kind == "event" and ev == "listen-stopped":
            return "stopped"
        text = (rec.get("text") or "").strip()
        if kind == "partial" and text and not NOISE.match(text):
            self.spoke = True
        if kind == "turn":
            return "turn"
        return None

    def tick(self, now):
        if now - self.armed_at > self.max_s:
            return "too long"
        if self.live_at is None:
            return "ears did not start" if now - self.armed_at > self.start_s else None
        if not self.spoke and now - max(self.live_at, self.armed_at) > self.wait_s:
            return "nothing said"
        return None


def end_talk(token, why, call_dir=None):
    """Close the mic after a talk turn, unless another press or a mode switch already took
    over (the talk file no longer holds this press's token)."""
    d = call_dir or CALL_DIR
    talk = d / "talk"
    try:
        if talk.read_text().strip() != token:
            return False
        talk.unlink()
    except OSError:
        return False
    if why != "stopped":
        (d / "ears.stop").touch()
    return True


def talk_watch(token, call_dir=None, log_dir=None, clock=time.time, nap=0.1):
    """`call talk` runs this in the background: follow the heard log from the press and close
    the mic when TalkWatch says the turn is over. Exits at once if the press is superseded."""
    d = call_dir or CALL_DIR
    try:
        watch = TalkWatch(float(token))
    except ValueError:
        return 2
    path = fh = None
    while True:
        try:
            if (d / "talk").read_text().strip() != token:
                return 0
        except OSError:
            return 0   # a second press, a mode switch or a hang-up ended it
        newer = newest_log(log_dir)
        if newer and newer != path:
            if fh:
                fh.close()
            first = path is None
            path, fh = newer, open(newer, "rb")
            if first:   # the press came a moment ago: its records are near the end
                fh.seek(max(0, newer.stat().st_size - 65536))
        why = None
        while fh and why is None:
            raw = next_line(fh)
            if raw is None:
                break
            try:
                why = watch.feed(json.loads(raw))
            except ValueError:
                continue
        why = why or watch.tick(clock())
        if why:
            end_talk(token, why, d)
            return 0
        time.sleep(nap)


def norm(line):
    """His words in a line for the call, whatever its label says."""
    return line.split(": ", 1)[1] if ": " in line else line


def rearm_simulation(lines, every, gap, headphones=False, stale=False, label=DEFAULT_LABEL,
                     tmp=None):
    """Replay a heard log (its raw lines, as bytes) twice: through one listener that never
    expires, and through a chain of listeners each killed `every` s after it was armed and
    re-armed `gap` s later, through the live code path (write_cursor at the kill, then
    catch_up_all on the log as it stood at the re-arm). `stale`: the cursor as of a second
    before the kill (no SIGTERM handler). Returns (ref, got, notes): his lines, normalized,
    as each would reach the call, and what happened at each re-arm."""
    recs, pos = [], 0
    for raw in lines:
        pos += len(raw)
        try:
            rec = json.loads(raw)
            t = ts(rec)
        except (ValueError, KeyError, TypeError):
            continue
        recs.append((pos, t, rec))
    if not recs:
        return [], [], []
    blob = b"".join(lines)
    ref = []
    g = Gate(lambda: headphones, label)
    for _, t, rec in recs:
        out = g.feed(rec, now=t)
        if out and out[0] in ("barge", "emit") and out[1]:
            ref.append(norm(out[1]))

    def upto(t):
        """Index just past the last record (in file order) written by time t."""
        j = 0
        for k, (_, rt, _) in enumerate(recs):
            if rt <= t:
                j = k + 1
        return j

    own_tmp = tmp is None
    tmp = Path(tempfile.mkdtemp(prefix="rearm-")) if own_tmp else tmp
    log = tmp / f"heard_{datetime.fromtimestamp(recs[0][1]).date().isoformat()}.jsonl"
    cur = tmp / "listen.cursor"
    call = str(int(recs[0][1]))
    got, notes = [], []
    arm, i, gate, first = recs[0][1] - 1, 0, None, True
    while True:
        kill = arm + every
        gate = Gate(lambda: headphones, label)
        if not first:
            i = upto(arm)
            log.write_bytes(blob[:recs[i - 1][0]] if i else b"")
            caught, fh, resumed = catch_up_all(gate, label, read_cursor(cur), log, call, now=arm)
            fh.close()
            got += [norm(x) for x in caught]
            earlier = sum(1 for x in caught if "(earlier," in x)
            notes.append(f"{datetime.fromtimestamp(arm):%H:%M:%S} re-armed after {gap:g} s: "
                         f"{'resumed' if resumed else 'NOT RESUMED'}, {len(caught)} caught up"
                         + (f" ({earlier} as earlier)" if earlier else ""))
        first = False
        last_emit = recs[i - 1][0] if i else 0
        end = upto(kill)
        while i < end:
            off, t, rec = recs[i]
            out = gate.feed(rec, now=t)
            if out and out[0] in ("barge", "emit") and out[1]:
                got.append(norm(out[1]))
                last_emit = off
            i += 1
        if i >= len(recs):
            break
        consumed = recs[i - 1][0] if i else 0
        if stale:
            j = upto(kill - 1.0)
            consumed = max(last_emit, recs[j - 1][0] if j else 0)
        write_cursor(log, consumed, call, path=cur, now=kill)
        arm = kill + gap
    if own_tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    return ref, got, notes


def rearm_report(ref, got):
    """(lost, duplicated) lines: in the reference but never delivered, delivered too often."""
    from collections import Counter
    r, g = Counter(ref), Counter(got)
    return sorted((r - g).elements()), sorted((g - r).elements())


def replay_rearm(path, every, gaps, headphones, stale=False):
    lines = [raw for raw in open(path, "rb").read().splitlines(keepends=True) if raw.endswith(b"\n")]
    problems = 0
    for gap in gaps:
        ref, got, notes = rearm_simulation(lines, every, gap, headphones, stale)
        lost, dup = rearm_report(ref, got)
        problems += len(lost) + len(dup)
        print(f"every {every:g} s, re-armed after {gap:g} s"
              f"{', cursor a second stale' if stale else ''}: {len(notes)} expiries, "
              f"{len(ref)} lines from one listener, {len(got)} delivered, "
              f"{len(lost)} lost, {len(dup)} duplicated")
        for n in notes:
            print("   ", n)
        for x in lost:
            print(f"    LOST  {x[:70]!r}")
        for x in dup:
            print(f"    DUP   {x[:70]!r}")
    return problems


def ago(s):
    s = max(0, int(s))
    return f"{s} s ago" if s < 120 else f"{s // 60} min ago" if s < 7200 else f"{s // 3600} h ago"


def ears_report(recs, now):
    """What the heard log says about the call right now, as short lines for `call status`."""
    started = stopped = beat = turn = said = None
    lags, drift = [], 0.0
    for r in recs:
        try:
            t = ts(r)
        except (ValueError, KeyError, TypeError):
            continue
        kind, ev = r.get("kind"), r.get("event")
        if kind == "event" and ev == "listen-started":
            started, stopped, lags, drift = r, None, [], 0.0
        elif kind == "event" and ev == "listen-stopped":
            stopped = r
        elif kind == "event" and ev == "heartbeat":
            beat = t
            if started is not None and "stream_s" in r:
                # stream time falls behind the wall clock over a long capture; the heartbeat
                # says by how much, so a partial's lag is measured from its real audio end
                drift = t - (ts(started) + r["stream_s"])
        elif kind == "turn" and r.get("source") == "mic":
            turn = t
        elif kind == "said" and r.get("source") == "mouth" and r.get("device") != "null":
            said = r
        if kind == "partial" and started is not None and "t1" in r:
            lags = (lags + [t - (ts(started) + r["t1"]) - drift])[-20:]
    out = []
    if started is None:
        return ["heard: nothing in today's log yet"]
    if stopped is not None:
        why = stopped.get("error") or stopped.get("reason") or "stopped"
        out.append(f"heard: capture stopped {ago(now - ts(stopped))} ({why})")
    else:
        bits = [f"capture up since {datetime.fromtimestamp(ts(started)):%H:%M}"]
        if beat:
            bits.append(f"last heartbeat {ago(now - beat)}")
        out.append("heard: " + ", ".join(bits))
    if turn:
        out.append(f"your last turn: {ago(now - turn)}")
    if lags:
        lag = sorted(lags)[len(lags) // 2]
        note = "  (slow: Whisper is busy or still loading)" if lag > 3 else ""
        out.append(f"transcripts land about {lag:.1f} s after you stop speaking{note}")
    if said is not None and said.get("reason") not in (None, "done"):
        out.append(f"last line: {said.get('reason')} {ago(now - ts(said))}"
                   + (f" ({said.get('detail')})" if said.get("detail") else ""))
    return out


def status():
    """`call status`'s view from the listener side: the heard log, the label, the listener."""
    path, recs = newest_log(), []
    if path:
        try:
            with open(path, "rb") as fh:
                fh.seek(max(0, path.stat().st_size - 400_000))
                for raw in fh.read().splitlines():
                    try:
                        recs.append(json.loads(raw))
                    except ValueError:
                        continue
        except OSError:
            pass
    for line in ears_report(recs, time.time()):
        print(line)
    print(f"label: {user_label()}  (config.json \"user_label\")")
    try:
        running = subprocess.run(["pgrep", "-f", r"listen\.py$"], capture_output=True,
                                 text=True).stdout.split()
    except OSError:
        running = []
    if running:
        print("listener: running")
    elif ears_alive():
        print("listener: NOT running while the ears are up. Re-arm the Monitor (`call listen`); "
              "it delivers what was said in between")
    else:
        print("listener: not running")


def replay(path, since, headphones):
    gate = Gate(lambda: headphones)
    for line in open(path):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        out = gate.feed(rec, now=ts(rec))
        if out and out[0] == "barge" and rec["ts"][11:19] >= since:
            print(f"{rec['ts'][11:19]}  {rec.get('text', '')[:60]!r:64} -> HUSH + "
                  f"{out[1] or '(same barge-in, no emit)'}")
        if rec.get("kind") == "turn" and out and rec["ts"][11:19] >= since:
            verdict = out[1] if out[0] == "emit" else f"DROP ({out[1]})"
            print(f"{rec['ts'][11:19]}  {rec.get('text', '')[:60]!r:64} -> {verdict}")


def heard_records(start, stop, log_dir=None):
    """Heard-log records from start to stop (epoch seconds), across midnight if need be."""
    log_dir = log_dir or LOG_DIR
    day, last = datetime.fromtimestamp(start).date(), datetime.fromtimestamp(stop).date()
    while day <= last:
        try:
            with open(log_dir / f"heard_{day.isoformat()}.jsonl") as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                        t = ts(rec)
                    except (ValueError, KeyError, TypeError):
                        continue
                    if start <= t <= stop:
                        yield rec
        except OSError:
            pass
        day += timedelta(days=1)


def receipt_entries(recs, workers, device=""):
    """(entries, steps): entries are (ts, who, text) for his turns ("You", as the live gate
    would have passed them, so my echo stays out) and every spoken line that played ("Claude"
    or the worker's name, from the line's agent tag or its session). Narrated steps (agent
    "step" or "<key>:step") are only counted."""
    by_key = {w["key"]: w for w in workers}
    by_stem = {transcript_stem(w): w for w in workers if w.get("transcript")}
    out_dev = {"name": device}
    gate = Gate(lambda: HEADPHONES.search(out_dev["name"]) is not None)
    entries, steps, saying = [], 0, {}
    for rec in recs:
        try:
            t = ts(rec)
        except (ValueError, KeyError, TypeError):
            continue
        if rec.get("source") == "mouth":
            if rec.get("device") and rec["device"] != "null":
                out_dev["name"] = rec["device"]
            if rec.get("kind") == "saying":
                saying[rec.get("utt")] = rec.get("text") or ""
        out = gate.feed(rec, now=t)
        if out and out[0] in ("barge", "emit") and out[1]:
            entries.append((t, "You", out[1].split(": ", 1)[1]))
        if rec.get("kind") != "said" or rec.get("source") != "mouth":
            continue
        text = (rec.get("text_played_est") or "").strip()
        if rec.get("device") == "null" or rec.get("file") or not text or text.startswith("[sound"):
            continue  # the silent warm-up, a sound clip, or a line that never played
        agent = str(rec.get("agent") or "")
        if agent == "step" or agent.endswith(":step"):
            steps += 1
            continue
        w = by_key.get(agent) or by_stem.get(str(rec.get("session") or ""))
        full = saying.get(rec.get("utt"), text)
        if rec.get("cut") and len(text) < len(full):
            text += " (cut off)"
        entries.append((t, (w.get("name") or w["key"]) if w else "Claude", text))
    return sorted(entries, key=lambda e: e[0]), steps


def plural(n, one, many):
    return f"{n} {one if n == 1 else many}"


def receipt_markdown(entries, steps, start, stop):
    """The receipt page (Spaces front matter, by "colleague"), or None if he never spoke."""
    turns = sum(1 for _, who, _ in entries if who == "You")
    if not turns:
        return None
    s = datetime.fromtimestamp(start).astimezone()
    e = datetime.fromtimestamp(stop).astimezone()
    mins = int(round((stop - start) / 60))
    dur = ("under a minute" if mins < 1 else f"{mins} min" if mins < 60
           else f"{mins // 60} h {mins % 60} min")
    title = f"Call, {s:%a} {s.day} {s:%b}, {s:%H:%M}"
    voices = sorted({who for _, who, _ in entries if who != "You"}, key=lambda w: (w != "Claude", w))
    replies = len(entries) - turns
    summary = (f"{s:%H:%M} to {e:%H:%M}, {dur}. {plural(turns, 'turn', 'turns')} from you, "
               f"{plural(replies, 'spoken reply', 'spoken replies')}"
               + (f" ({', '.join(voices)})" if voices else "") + "."
               + (f" {plural(steps, 'narrated step', 'narrated steps')} not shown." if steps else ""))
    lines = ["---", f"title: {title}", f"created: {s.isoformat(timespec='seconds')}",
             f"updated: {e.isoformat(timespec='seconds')}", "by: colleague", "---", "",
             f"# {title}", "", summary, ""]
    for t, who, text in entries:
        lines += [f"**{datetime.fromtimestamp(t):%H:%M} {who}:** {text}", ""]
    return "\n".join(lines)


def write_receipt(start, stop, call_dir=None, log_dir=None):
    """Write the call's receipt into spaces/calls/; returns its path, or None (no turns)."""
    call_dir = call_dir or CALL_DIR
    try:
        device = (call_dir / "device").read_text().strip()
    except OSError:
        device = ""
    entries, steps = receipt_entries(heard_records(start, stop, log_dir), load_workers(call_dir),
                                     device)
    md = receipt_markdown(entries, steps, start, stop)
    if md is None:
        return None
    space = call_dir / "spaces" / "calls"
    space.mkdir(parents=True, exist_ok=True)
    meta = space / "space.json"
    if not meta.exists():
        meta.write_text(json.dumps({"name": "Calls", "created": datetime.now().astimezone()
                                    .isoformat(timespec="seconds")}, indent=2) + "\n")
    slug = datetime.fromtimestamp(start).strftime("%Y-%m-%d-%H%M")
    path, n = space / f"{slug}.md", 2
    while path.exists():
        path, n = space / f"{slug}-{n}.md", n + 1
    part = space / f".{path.name}.part"
    part.write_text(md)
    part.rename(path)
    return path


def selftest():
    """Synthetic logs: a barge partial during a 'saying' must hush and emit; an echo must
    not; nothing changes while I am silent. Prints each check, returns the failure count."""
    base = datetime.fromisoformat("2026-01-01T12:00:00+00:00").timestamp()

    def at(sec):
        return datetime.fromtimestamp(base + sec).astimezone().isoformat(timespec="milliseconds")

    def run(recs, headphones):
        gate, outs = Gate(lambda: headphones), []
        for r in recs:
            outs.append(gate.feed(r, now=ts(r)))
        return outs

    def ears():
        # capture starts at wall 0; partials land 0.6 s after their chunk ends
        recs = [{"ts": at(0), "kind": "event", "source": "mic", "event": "listen-started"}]
        for k in range(3):
            recs.append({"ts": at(2.6 + 2 * k), "kind": "partial", "source": "mic",
                         "text": "", "t0": 2.0 * k, "t1": 2.0 + 2 * k})
        return recs

    def saying(sec, utt, text):
        return {"ts": at(sec), "kind": "saying", "source": "mouth", "utt": utt, "text": text}

    def said(sec, utt):
        return {"ts": at(sec), "kind": "said", "source": "mouth", "utt": utt}

    def partial(sec, text, dur=1.8):
        t1 = sec - 0.6
        return {"ts": at(sec), "kind": "partial", "source": "mic", "text": text,
                "t0": t1 - dur, "t1": t1}

    def turn(sec, text, t0, t1):
        return {"ts": at(sec), "kind": "turn", "source": "mic", "text": text,
                "t0": t0, "t1": t1}

    line = "Opening it on the right now. Heads up, Opus is still polishing it, so this is a work in progress."
    garble_line = "At the top there's a state switcher: Listening, You, Thinking, Claude, and Mic off."
    fails, checks = 0, 0

    def check(name, got, want):
        nonlocal fails, checks
        checks += 1
        ok = got == want
        fails += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"\n      got  {got!r}\n      want {want!r}"))

    def barges(outs):
        return [o for o in outs if o and o[0] == "barge"]

    # 1. headphones: two words over a playing line cut at once and go out as his turn
    recs = ears() + [saying(10, "u1", line), partial(12.5, "wait hold on")]
    outs = run(recs, headphones=True)
    check("headphones: barge partial during saying -> barge", barges(outs),
          [("barge", "USER (over you): wait hold on")])
    cut, said_lines = [], []
    barge_in(outs[-1][1] if outs[-1] else None, cut=lambda: cut.append(1),
             say=lambda l, flush=True: said_lines.append(l), mark=lambda: None)
    check("headphones: barge_in runs hush once and emits the line",
          (len(cut), said_lines), (1, ["USER (over you): wait hold on"]))

    # 2. headphones: one word is not enough; nothing once the line has ended
    outs = run(ears() + [saying(10, "u1", line), partial(12.5, "hmm")], headphones=True)
    check("headphones: one-word partial -> no barge", barges(outs), [])
    outs = run(ears() + [saying(10, "u1", line), said(12, "u1"), partial(14, "so what next")],
               headphones=True)
    check("headphones: partial after 'said' (I am silent) -> no barge", barges(outs), [])

    # 3. speakers: my own line coming back, clean and garbled, is not a barge
    outs = run(ears() + [saying(10, "u1", line), partial(12.5, "Heads up, Opus is still polishing it")],
               headphones=False)
    check("speakers: clean echo of my line -> no barge", barges(outs), [])
    outs = run(ears() + [saying(10, "u2", garble_line), partial(13, "Claude and Mike Goff.")],
               headphones=False)
    check("speakers: garbled echo ('Mike Goff' for 'Mic off') -> no barge", barges(outs), [])
    outs = run(ears() + [saying(10, "u1", line), partial(12.5, "polishing it so this is a work in progress")],
               headphones=False)
    check("speakers: echo with only stopwords left -> no barge", barges(outs), [])

    # 4. speakers: two content words of his, not in my line, cut it
    outs = run(ears() + [saying(10, "u1", line), partial(12.5, "No wait, switch projects")],
               headphones=False)
    check("speakers: 2 content words not in line -> barge", barges(outs),
          [("barge", "USER (over you): No wait, switch projects")])
    outs = run(ears() + [saying(10, "u1", line), partial(12.5, "Opus still progress")],
               headphones=False)
    check("speakers: content words that are all mine -> no barge", barges(outs), [])

    # 5. the turn that follows a barge-in: sent once as the full turn, or dropped if nothing new
    recs = ears() + [saying(10, "u1", line), partial(12.5, "No wait, switch projects"),
                     said(12.7, "u1"),
                     turn(15, "No wait, switch projects to the Atlas one first.", 10.3, 13.9)]
    outs = run(recs, headphones=False)
    check("speakers: barge then its turn -> full turn emitted once", [o for o in outs if o][-1],
          ("emit", "USER (over you, full turn): no wait switch projects to atlas one first", False))
    recs = ears() + [saying(10, "u1", line), partial(12.5, "wait hold on"), said(12.7, "u1"),
                     turn(14, "Wait, hold on.", 10.3, 11.9)]
    outs = run(recs, headphones=True)
    check("headphones: turn adding nothing to the barge -> dropped as duplicate",
          [o for o in outs if o][-1], ("drop", "already sent as barge-in"))

    # 6. one barge-in per line, and one emit per barge-in
    recs = ears() + [saying(10, "u1", line), partial(12.5, "wait hold on"),
                     partial(14.3, "I need to change this")]
    outs = run(recs, headphones=True)
    check("headphones: second partial of the same barge -> no second emit",
          barges(outs), [("barge", "USER (over you): wait hold on")])

    # 7. silent: no saying open, turns behave exactly as before
    recs = ears() + [partial(9, "Can you check the quote"), turn(10, "Can you check the quote?", 6.5, 9.0)]
    for hp in (True, False):
        outs = run(recs, headphones=hp)
        check(f"{'headphones' if hp else 'speakers'}: silent, partial -> nothing; turn -> plain USER",
              (barges(outs), outs[-1]), ([], ("emit", "USER: Can you check the quote?", True)))

    # 8. a stale 'saying' (no 'said' for minutes) is not a line playing
    outs = run(ears() + [saying(10, "u1", line), partial(10 + OPEN_MAX_S + 5, "wait hold on")],
               headphones=True)
    check("headphones: stale saying -> no barge", barges(outs), [])

    # 9. workers: exact key or exact name only, and each one's voice
    workers = [{"key": "scribe", "name": "Scribe", "god": "scribe", "transcript": "s-scribe.jsonl"},
               {"key": "sales", "name": "Sales", "avatar": "blue"},
               {"key": "deep", "name": "Deep Research", "voice": "bm_lewis", "avatar": "purple"},
               {"key": "plain", "name": "Plain"}]
    check("workers: exact key, exact name any case, never a near match",
          [(find_worker(q, workers) or {}).get("key") for q in
           ("scribe", "Scribe", "deep research", "Scrib", "Research", "", "sales ")],
          ["scribe", "scribe", "deep", None, None, None, "sales"])
    check("workers: voice from registry, god default, avatar colour, else af_heart",
          [voice_of(w) for w in workers], ["bf_emma", "bf_emma", "bm_lewis", "af_heart"])
    check("focus lines", [focus_line("", workers), focus_line("scribe", workers),
                          focus_line("Scribe", workers)],
          ["FOCUS: off (the call is back with you, the main colleague)",
           "FOCUS: on key=scribe name=Scribe voice=bf_emma session=",
           "FOCUS: on key=Scribe (not in the registry)"])

    # 10. the call receipt: his turns through the echo gate, every line that played, by speaker
    def spoke(sec, utt, text, dur=2.0, **kw):
        common = {"source": "mouth", "utt": utt, "device": "MacBook Air Speakers", **kw}
        return [{"ts": at(sec), "kind": "saying", "text": text, **common},
                {"ts": at(sec + dur), "kind": "said", "text_played_est": text, "cut": False,
                 **common}]

    call = (ears()
            + [turn(12, "Can you check the quote?", 8.0, 11.0)]
            + spoke(13, "u1", "Sure, checking it now.", agent="mouth", session="s-call")
            + [turn(16.5, "Sure, checking it now.", 12.6, 14.6)]          # my echo on speakers
            + spoke(20, "u2", "Reading the CI log.", agent="colleague:step")
            + spoke(24, "u3", "[sound mmhm.wav]", file="/x/mmhm.wav")
            + spoke(27, "u4", "Ready.", device="null")
            + spoke(30, "u5", "Scribe here. The draft is in your outbox.", agent="scribe")
            + spoke(35, "u6", "One more thing from me.", agent="mouth", session="s-scribe")
            + [turn(42, "Thanks, that's it.", 38.5, 41.0)])
    entries, steps = receipt_entries(call, workers, "MacBook Air Speakers")
    check("receipt: turns, replies by speaker; echo, steps, clips, warm-up left out",
          ([(round(t - base), who, text) for t, who, text in entries], steps),
          ([(12, "You", "Can you check the quote?"), (15, "Claude", "Sure, checking it now."),
            (32, "Scribe", "Scribe here. The draft is in your outbox."),
            (37, "Scribe", "One more thing from me."), (42, "You", "Thanks, that's it.")], 1))
    md = receipt_markdown(entries, steps, base, base + 300)
    s0 = datetime.fromtimestamp(base).astimezone()
    s1 = datetime.fromtimestamp(base + 300).astimezone()
    title = f"Call, {s0:%a} {s0.day} {s0:%b}, {s0:%H:%M}"
    check("receipt: front matter by colleague, summary line",
          md.splitlines()[:11] if md else md,
          ["---", f"title: {title}", f"created: {s0.isoformat(timespec='seconds')}",
           f"updated: {s1.isoformat(timespec='seconds')}", "by: colleague", "---", "",
           f"# {title}", "",
           f"{s0:%H:%M} to {s1:%H:%M}, 5 min. 2 turns from you, 3 spoken replies "
           "(Claude, Scribe). 1 narrated step not shown.", ""])
    no_turns = receipt_entries(ears() + spoke(13, "u1", "Hello?"), workers)
    check("receipt: a call with no turns -> no receipt",
          receipt_markdown(no_turns[0], no_turns[1], base, base + 60), None)
    tmp = Path(tempfile.mkdtemp(prefix="receipt-test-"))
    (tmp / "workers.json").write_text(json.dumps({"workers": workers}))
    day = datetime.fromtimestamp(base).date().isoformat()
    (tmp / f"heard_{day}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in call))
    first = write_receipt(base, base + 300, call_dir=tmp, log_dir=tmp)
    second = write_receipt(base, base + 300, call_dir=tmp, log_dir=tmp)
    space = json.loads((tmp / "spaces" / "calls" / "space.json").read_text())
    check("receipt: written to spaces/calls, space created, a second one does not overwrite",
          (first and first.name, second and second.name, space["name"],
           first and first.read_text() == md),
          (f"{datetime.fromtimestamp(base):%Y-%m-%d-%H%M}.md",
           f"{datetime.fromtimestamp(base):%Y-%m-%d-%H%M}-2.md", "Calls", True))
    shutil.rmtree(tmp, ignore_errors=True)

    # 11. speakers, cold STT: the first passes land ~16 s late, so the partial-based offset
    # puts my own echo on top of the NEXT line (Sales speaking) and it used to cut it. My
    # words are caught by their text instead, and his words in front of an echo survive.
    long = ("Two decisions from you. One, approve the switches for the workers in the app. "
            "Two, say yes or no to moving the workers into the workers section.")
    cold = [{"ts": at(0), "kind": "event", "source": "mic", "event": "listen-started"},
            saying(10, "c1", "Test call. This is Claude. I'm putting Sales on for a moment."),
            said(14, "c1"),
            saying(26, "c2", "Hi, this is Sales. Voice check done, back on standby."),
            {"ts": at(28), "kind": "partial", "source": "mic", "text": "Test call. This is Claude.",
             "t0": 10.2, "t1": 12.0},
            turn(30, "Test call. This is Claude. I'm putting sales on for a moment", 10.2, 13.8),
            said(31, "c2"),
            saying(40, "c3", long), said(48, "c3"),
            turn(52, "What about item 3? " + long, 36.0, 48.5)]
    outs = run(cold, headphones=False)
    check("cold STT: my own late echo does not cut the line playing", barges(outs), [])
    check("cold STT: the late echo turn is dropped by its words", outs[5],
          ("drop", "echo of me (by its words)"))
    check("cold STT: his words in front of my echoed line survive", outs[-1],
          ("emit", "USER: what about item three", True))

    # 12. the label: config "user_label", sanitized; missing or broken config means USER
    tmp = Path(tempfile.mkdtemp(prefix="label-test-"))
    cfg = tmp / "config.json"
    labels = [user_label(load_config(cfg))]                              # missing file
    for body in ("{not json", "[1, 2]", '{"user_label": 7}', '{"user_label": "  "}',
                 '{"user_label": "Sam"}', '{"user_label": "Dr: Sam (CEO)\\nX"}',
                 '{"user_label": "' + "A" * 40 + '", "approvals": {"x": 1}, "workers": []}'):
        cfg.write_text(body)
        labels.append(user_label(load_config(cfg)))
    check("label: missing, broken, wrong type or blank -> USER; colons, brackets, newlines out",
          labels, ["USER", "USER", "USER", "USER", "USER", "Sam", "Dr Sam CEO X", "A" * 32])
    gate = Gate(lambda: True, "Sam")
    outs = [gate.feed(r, now=ts(r)) for r in ears() + [
        saying(10, "u1", line), partial(12.5, "wait hold on"), said(12.7, "u1"),
        turn(14, "Wait, hold on. Not that one, the other file.", 10.3, 13.0),
        turn(20, "And then", 17.0, 18.0)]]
    check("label: every line of his starts with it",
          [o[1] for o in outs if o and o[0] in ("barge", "emit")],
          ["Sam (over you): wait hold on",
           "Sam (over you, full turn): Wait, hold on. Not that one, the other file.",
           "Sam (mid-thought, wait for more): And then"])

    # 13. speakers: the STT splits my word in two ("outbox" -> "out Box") and garbles the next
    # ("dir" -> "Dyer"): still my narrated step coming back, not a barge-in
    step = "Next, I'll check outbox dir and make scratchpad."
    outs = run(ears() + [saying(10, "s1", step), partial(13, "Next, I'll check out Box Dyer and make")],
               headphones=False)
    check("speakers: split compound + garbled word in my line -> no barge", barges(outs), [])
    check("char_echo: my line garbled scores high, his barge-ins low",
          [char_echo(t, [l]) >= ECHO_CHARS for t, l in
           [("Claude and Mike Goff.", garble_line), ("No wait, switch projects", line),
            ("Stop, stop, don't talk.", step)]], [True, False, False])
    outs = run(ears() + [saying(10, "s1", step), partial(12.5, "No wait, open the pill instead")],
               headphones=False)
    check("speakers: his real barge-in over the same line still cuts it", barges(outs),
          [("barge", "USER (over you): No wait, open the pill instead")])

    # 14. speakers: a turn that began over me whose leftover is my line garbled is dropped;
    # his own words over me still go out
    brief = "From now on I'll send the hard questions to a helper, and keep my replies short."
    outs = run(ears() + [saying(10, "b1", brief), said(16, "b1"),
                         turn(17, "Questions to a helmet, keep the reply sport.", 12.0, 15.5)],
               headphones=False)
    check("speakers: garbled echo turn over me -> dropped", outs[-1][0], "drop")
    outs = run(ears() + [saying(10, "b1", brief), said(16, "b1"),
                         turn(17, "Actually wait, use the bigger model for this one.", 12.0, 15.5)],
               headphones=False)
    check("speakers: his own turn over me -> emitted, my words out", outs[-1],
          ("emit", "USER (over you): actually wait use bigger model for this one", False))

    # 15. speakers: a long echo of my line whose only survivors are scattered numbers is
    # dropped, not sent as "2nd 92 31st"
    numbers = ("Runway is ninety two days to February second, and the October thirty first "
               "session result is not in the mail yet, so check it today.")
    outs = run([{"ts": at(0), "kind": "event", "source": "mic", "event": "listen-started"},
                saying(10, "n1", numbers), said(19, "n1"),
                turn(30, "Runway is 92 days to February 2nd, and the October 31st session result "
                         "is not in the mail yet, so check it today.", 10.5, 19.0)], headphones=False)
    check("speakers: scattered survivors of a long echo -> dropped", outs[-1],
          ("drop", "echo of me (by its words)"))

    # 16. deliver: a turn that began over me cuts my speech; the full turn behind a barge-in
    # and a plain turn do not
    calls = []
    for o in [("emit", "USER (over you): no not that", False),
              ("emit", "USER (over you, full turn): no not that one", False),
              ("emit", "USER: next", True), ("barge", "USER (over you): wait")]:
        cut, said_lines = [], []
        deliver(o, "USER", cut=lambda: cut.append(1),
                say=lambda l, flush=True: said_lines.append(l), mark=lambda: None)
        calls.append((len(cut), said_lines))
    check("deliver: over-you turn and barge-in hush; full turn and plain turn do not", calls,
          [(1, ["USER (over you): no not that"]), (0, ["USER (over you, full turn): no not that one"]),
           (0, ["USER: next"]), (1, ["USER (over you): wait"])])

    # 17. catch-up: a listener re-armed on the same call delivers what no listener saw
    log = tmp / "heard.jsonl"
    early = ears() + [turn(10, "First thing, check the build.", 7.0, 9.0)]
    gap = [turn(400, "Also look at the release notes.", 397.0, 399.0)]
    recent = [turn(470, "And tell me when it's done.", 467.0, 469.0)]
    half = b'{"ts": "half a line'                                     # the ears are mid-write
    log.write_bytes(b"".join(json.dumps(r).encode() + b"\n" for r in early))
    mid = log.stat().st_size
    with open(log, "ab") as fh:
        fh.write(b"".join(json.dumps(r).encode() + b"\n" for r in gap + recent) + half)
    call = str(int(base))
    cur = tmp / "listen.cursor"
    write_cursor(log, mid, call, path=cur, now=base + 300)
    off, since = start_point(read_cursor(cur), log, call, now=base + 480)
    with open(log, "rb") as fh:
        got = catch_up(fh, Gate(lambda: True), "USER", off, since, now=base + 480)
        stopped_at = fh.tell()
    t400 = datetime.fromtimestamp(base + 400)
    check("catch-up: turns after the cursor; old ones marked earlier, fresh ones as they are",
          (off == mid, since, got),
          (True, None, [f"USER (earlier, {t400:%H:%M}, said while no listener was running): "
                        "Also look at the release notes.", "USER: And tell me when it's done."]))
    check("catch-up: a half-written last line is left for the next read",
          stopped_at, log.stat().st_size - len(half))
    check("catch-up: another call, another log, a stale or broken cursor -> follow from the end",
          [start_point(read_cursor(cur), log, "123", now=base + 480),
           start_point(read_cursor(cur), tmp / "other.jsonl", call, now=base + 480),
           start_point(read_cursor(cur), log, call, now=base + 300 + CATCHUP_MAX_S + 1),
           start_point({"call": call, "log": str(log), "offset": "x", "at": base}, log, call,
                       now=base + 480)],
          [(None, None)] * 4)
    check("catch-up: no cursor, call started under 2 min ago -> from the call's start",
          [start_point(None, log, call, now=base + 60), start_point(None, log, call, now=base + 600)],
          [(None, base), (None, None)])
    with open(log, "rb") as fh:
        silent = catch_up(fh, Gate(lambda: True), "USER")
    check("catch-up: a fresh listener reads history silently", silent, [])

    # 18. status: the transcripts' lag is measured against the stream clock the heartbeat
    # reports, so a long capture whose stream fell behind does not read as a slow Whisper
    recs = [{"ts": at(0), "kind": "event", "source": "mic", "event": "listen-started"},
            {"ts": at(600), "kind": "event", "source": "mic", "event": "heartbeat", "stream_s": 480.0},
            {"ts": at(700.8), "kind": "partial", "source": "mic", "text": "x", "t0": 578.0, "t1": 580.0},
            {"ts": at(702), "kind": "turn", "source": "mic", "text": "x", "t0": 578.0, "t1": 580.0}]
    check("status: lag from the heartbeat's stream clock, last turn",
          ears_report(recs, base + 710)[1:],
          ["your last turn: 8 s ago", "transcripts land about 0.8 s after you stop speaking"])
    stop = {"ts": at(705), "kind": "event", "source": "mic", "event": "listen-stopped",
            "reason": "error", "error": "no audio"}
    check("status: a stopped capture says why", ears_report(recs + [stop], base + 710)[0],
          "heard: capture stopped 5 s ago (no audio)")
    shutil.rmtree(tmp, ignore_errors=True)

    # 20. re-arm: the Monitor expires mid-call; every turn the gate passes must reach the call
    # exactly once, compared with one listener that never expired. The kills land between a
    # barge-in and its turn, mid-line, and in a quiet stretch; the cursor is exact (SIGTERM)
    # or a second stale; the re-arm comes 3 s, 45 s or 100 s later.
    def raw(recs):
        return [json.dumps(r).encode() + b"\n" for r in recs]

    long_call = ears() + [
        turn(10, "First, check the build.", 7.0, 9.0),
        saying(12, "u1", line), partial(14.5, "wait hold on"), said(14.7, "u1"),
        turn(16, "Wait, hold on.", 12.3, 13.9),
        turn(30, "Not that one, the release notes.", 27.0, 29.5),
        saying(40, "u2", garble_line), partial(43, "Claude and Mike Goff."),
        partial(44.5, "No wait, switch projects"), said(44.8, "u2"),
        turn(47, "No wait, switch projects to the Atlas one first.", 42.6, 46.0),
        saying(60, "u3", brief), said(66, "u3"),
        turn(67, "Questions to a helmet, keep the reply sport.", 62.0, 65.5),
        turn(90, "And send me the summary after.", 87.0, 89.5),
        turn(130, "Also check the tests", 127.0, 129.0),
        turn(131.5, "on the release branch.", 130.0, 131.0)]
    for hp in (True, False):
        for every, gap, stale in ((16, 3, False), (16, 45, True), (33, 3, True), (45, 100, False),
                                  (8, 3, False), (8, 3, True)):
            ref, got, notes = rearm_simulation(raw(long_call), every, gap, headphones=hp, stale=stale)
            lost, dup = rearm_report(ref, got)
            check(f"re-arm ({'headphones' if hp else 'speakers'}, every {every} s, gap {gap} s"
                  f"{', stale cursor' if stale else ''}): nothing lost, nothing twice",
                  (len(ref) >= 6, all("resumed" in n for n in notes), lost, dup),
                  (True, True, [], []))

    # 21. re-arm across midnight: the rest of yesterday's log, then all of today's
    tmp = Path(tempfile.mkdtemp(prefix="midnight-test-"))
    day1, day2 = tmp / "heard_2026-01-01.jsonl", tmp / "heard_2026-01-02.jsonl"
    early = ears() + [turn(10, "First thing, check the build.", 7.0, 9.0)]
    day1.write_bytes(b"".join(raw(early)))
    mid = day1.stat().st_size
    with open(day1, "ab") as fh:
        fh.write(b"".join(raw([turn(40, "Also the release notes.", 37.0, 39.0)])))
    day2.write_bytes(b"".join(raw([turn(70, "And the changelog.", 67.0, 69.0)])))
    call = str(int(base))
    cur = tmp / "listen.cursor"
    write_cursor(day1, mid, call, path=cur, now=base + 20)
    got, fh, resumed = catch_up_all(Gate(lambda: True), "USER", read_cursor(cur), day2, call,
                                    now=base + 75)
    fh.close()
    check("re-arm across midnight: yesterday's rest, then today's log from its start",
          (resumed, [norm(x) for x in got], resume_logs(read_cursor(cur), day2, "9", base + 75)),
          (True, ["Also the release notes.", "And the changelog."], []))

    # 22. what was pressed or switched while no listener ran is reported first, Stop leading
    before = {"focus": "", "muted": False, "mic": "open", "stop": 100.0}
    after = {"focus": "scribe", "muted": True, "mic": "talk", "stop": 200.0}
    check("re-arm: Stop, focus, mic mode and mute changes meanwhile are reported",
          [x.split(" (")[0] for x in state_news(before, after, "USER", workers)],
          ["USER: Stop.", "FOCUS: on key=scribe name=Scribe voice=bf_emma session=",
           "MIC: talk", "EARS: muted"])
    check("re-arm: nothing changed, or an old cursor with no state -> nothing to report",
          (state_news(before, dict(before), "USER", workers), state_news(None, after, "USER", workers),
           state_news({"focus": ""}, {**after, "focus": ""}, "USER", workers)), ([], [], []))

    # 23. one call, one chat: /gods in another chat takes the call; this listener steps back
    check("handover: only a known session that differs from the call's owner moves",
          [moved("a", "b"), moved("a", "a"), moved("", "b"), moved("a", "")],
          [True, False, False, False])

    # 24. the mic mode in config.json: written with every other key kept, read safely
    cfg = tmp / "config.json"
    errs = [set_mic("talk", cfg)]
    modes = [mic_mode(load_config(cfg))]
    cfg.write_text(json.dumps({"approvals": {"outward": "typed"}, "user_label": "Sam",
                               "call": {"other": 1, "mic": "talk"}, "_help": {"x": "y"}}))
    errs.append(set_mic("open", cfg))
    kept = json.loads(cfg.read_text())
    cfg.write_text("{broken")
    errs.append(set_mic("talk", cfg) is not None)
    errs.append(set_mic("loud", cfg) is not None)
    modes += [mic_mode({"call": {"mic": "talk"}}), mic_mode({"call": "talk"}), mic_mode({}),
              mic_mode({"call": {"mic": "TALK"}})]
    check("mic mode: set_mic keeps every other key; a broken file or bad mode changes nothing",
          (errs, kept, cfg.read_text(), modes),
          ([None, None, True, True], {"approvals": {"outward": "typed"}, "user_label": "Sam",
                                      "call": {"other": 1, "mic": "open"}, "_help": {"x": "y"}},
           "{broken", ["talk", "talk", "open", "open", "open"]))

    # 25. talk mode: a turn is whole (the mic closed after it), never "mid-thought"
    outs = [Gate(lambda: True, "USER", talk=lambda: t).feed(turn(20, "And then", 17.0, 18.0), now=base + 20)
            for t in (False, True)]
    check("talk mode: an unfinished sentence goes out as a plain turn",
          outs, [("emit", "USER (mid-thought, wait for more): And then", False),
                 ("emit", "USER: And then", True)])

    # 26. talk watch: when the mic closes again after a press at 100
    def ev(sec, name):
        return {"ts": at(sec), "kind": "event", "source": "mic", "event": name}

    def watch(recs, until):
        w, why = TalkWatch(base + 100, wait_s=10, start_s=15, max_s=90), None
        for r in recs:
            why = why or w.feed(r)
        return why or w.tick(base + until)

    check("talk watch: first turn, nothing said, ears never up, stopped, too long, still going",
          [watch([ev(101, "listen-started"), partial(103, "check the build"),
                  turn(106, "Check the build.", 1.0, 4.0)], 106),
           watch([ev(101, "listen-started")], 112),
           watch([], 116),
           watch([ev(99.8, "listen-stopped"), ev(101, "listen-started"), ev(104, "listen-stopped")], 104),
           watch([ev(101, "listen-started"), partial(103, "a very long thought")], 191),
           watch([ev(99.5, "listen-started"), turn(99.6, "the last turn's tail", 0, 1),
                  ev(101, "listen-started"), partial(103, "still talking")], 108)],
          ["turn", "nothing said", "ears did not start", "stopped", "too long", None])
    calldir, logdir = tmp / "call", tmp / "logs"
    calldir.mkdir()
    logdir.mkdir()
    token = f"{base + 100:.3f}"
    (calldir / "talk").write_text(token + "\n")
    (logdir / "heard_2026-01-01.jsonl").write_bytes(b"".join(raw(
        [ev(101, "listen-started"), partial(103, "check the build"),
         turn(106, "Check the build.", 1.0, 4.0)])))
    rc = talk_watch(token, calldir, logdir, clock=lambda: base + 107, nap=0)
    closed = (rc, (calldir / "talk").exists(), (calldir / "ears.stop").exists())
    (calldir / "ears.stop").unlink()
    (calldir / "talk").write_text("123.000\n")      # a newer press took over
    superseded = (talk_watch(token, calldir, logdir, clock=lambda: base + 107, nap=0),
                  (calldir / "talk").read_text().strip(), (calldir / "ears.stop").exists())
    check("talk watch: closes the mic after the turn; a superseded press touches nothing",
          (closed, superseded), ((0, False, True), (0, "123.000", False)))
    shutil.rmtree(tmp, ignore_errors=True)

    # 19. the narrate hook's pacing (its own self-test, run here so CI covers it)
    narrate = Path(__file__).resolve().parent / "narrate"
    if narrate.exists():
        res = subprocess.run([sys.executable, "-I", "-B", str(narrate), "--selftest"],
                             capture_output=True, text=True)
        for row in res.stdout.splitlines():
            checks += 1
            fails += not row.startswith("PASS")
            print(row)

    print(f"\n{checks - fails} passed, {fails} failed")
    return fails


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--replay")
    ap.add_argument("--since", default="00:00:00")
    ap.add_argument("--headphones", action="store_true")
    ap.add_argument("--speakers", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--worker", metavar="NAME")
    ap.add_argument("--receipt", action="store_true")
    ap.add_argument("--start", type=float)
    ap.add_argument("--stop", type=float)
    ap.add_argument("--call-dir", type=Path)
    ap.add_argument("--log-dir", type=Path)
    ap.add_argument("--replay-rearm", metavar="FILE")
    ap.add_argument("--every", type=float, default=1800.0)
    ap.add_argument("--gap", default="5,30,120")
    ap.add_argument("--stale", action="store_true")
    ap.add_argument("--talk-watch", metavar="TOKEN")
    ap.add_argument("--set-mic", choices=MIC_MODES)
    args = ap.parse_args()
    try:
        if args.selftest:
            raise SystemExit(1 if selftest() else 0)
        if args.replay_rearm:
            gaps = [float(g) for g in args.gap.split(",") if g.strip()]
            raise SystemExit(1 if replay_rearm(args.replay_rearm, args.every, gaps,
                                               args.headphones and not args.speakers,
                                               args.stale) else 0)
        if args.talk_watch:
            raise SystemExit(talk_watch(args.talk_watch, args.call_dir, args.log_dir))
        if args.set_mic:
            err = set_mic(args.set_mic, (args.call_dir / "config.json") if args.call_dir else None)
            if err:
                raise SystemExit(f"call mode: {err}")
            print(f"mic: {args.set_mic}")
            raise SystemExit(0)
        if args.status:
            status()
            raise SystemExit(0)
        if args.worker is not None:
            everyone = load_workers(args.call_dir)
            w = find_worker(args.worker, everyone)
            if not w:
                names = ", ".join(f"{x.get('name') or x['key']} ({x['key']})" for x in everyone)
                print(f"no worker named '{args.worker}' (exact key or name). "
                      f"Workers: {names or 'none'}", file=sys.stderr)
                raise SystemExit(1)
            print("\t".join([w["key"], str(w.get("name") or w["key"]), voice_of(w),
                             str(w.get("session") or "-"), god_of(w)]))
            raise SystemExit(0)
        if args.receipt:
            if args.start is None:
                raise SystemExit("listen.py --receipt needs --start EPOCH")
            path = write_receipt(args.start, args.stop or time.time(), call_dir=args.call_dir,
                                 log_dir=args.log_dir)
            print(f"receipt: {path}" if path else "receipt: none (no turns on this call)")
            raise SystemExit(0)
        if args.replay:
            replay(args.replay, args.since, args.headphones and not args.speakers)
        else:
            live()
    except KeyboardInterrupt:
        pass
