#!/usr/bin/env python3
"""Stream the user's finished turns from the VoiceMode ears, one line each, for Monitor.

Tails ~/.voicemode/logs/conversations/heard_*.jsonl from its current end and prints:

    USER: <text>                               a turn of theirs
    USER (mid-thought, wait for more): <text>  they paused without finishing the sentence
    USER (over you): <text>                    they spoke over me; my own words removed
    USER (over you, full turn): <text>         the whole turn behind a barge-in already sent
    EARS: down (<why>)                         the capture stopped or went silent
    EARS: muted / EARS: unmuted                they turned the mic off or on with the pill
    USER: Stop. (...)                          they pressed Stop on the pill
    PANE: ...                                  a request from the Workers pane mod
    FOCUS: on key=… name=… voice=… session=…    a worker was put on the call (`call focus`)
    FOCUS: off                                 the call is back with the main colleague

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
    listen.py --worker NAME         a worker by exact key or exact name: key, name, voice,
                                    session, god (tab-separated); exit 1 if there is none
    listen.py --receipt --start EPOCH [--stop EPOCH]
                                    the call receipt: his turns (through the same echo gate)
                                    and the spoken replies, as a page in the Spaces "calls"
                                    space (~/.voicemode/call/spaces/calls/<date-time>.md)

Standard library only.
"""

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
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
CALL = Path(__file__).resolve().parent / "call"
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
    his = [w for w in heard if not mine_word(w, said, joined)]
    content = [w for w in his if w not in BARGE_STOPWORDS]
    need = BARGE_MIN_CONTENT + (1 if heard and 1 - len(his) / len(heard) >= ECHO_SHARE else 0)
    return his if len(content) >= need else []


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

    def __init__(self, headphones):
        self.headphones = headphones   # a callable, so a device switch mid-call is honoured
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
            flags = [mine_word(w, set(said), "".join(said) + " ") for w in heard]
            if sum(flags) / len(heard) < ECHO_TEXT_SHARE:
                continue
            rest = [w for w, f in zip(heard, flags) if not f]
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
        return ("barge", f"USER (over you): {text}" if fresh else None)

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
        return ("emit", f"USER (over you, full turn{wait}): {text}", False)

    def judge_turn(self, rec, now=None):
        text = (rec.get("text") or "").strip()
        if NOISE.match(text) or CJK.search(text):
            return ("drop", "noise")

        if not self.headphones():
            rest = self.text_echo(rec)
            if rest is not None:
                if not self.enough(rest):
                    return ("drop", "echo of me (by its words)")
                return ("emit", f"USER: {' '.join(rest)}", True)

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
                    return ("emit", f"USER (over you): {rest}", False)
                if echoed:
                    if not rest:
                        return ("drop", "echo of me")
                    text = rest

        if re.search(r"[.?!]['\"]?$", text) and not text.endswith(("...", "…")):
            return ("emit", f"USER: {text}", True)
        return ("emit", f"USER (mid-thought, wait for more): {text}", False)


def mtime(path):
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def newest_log():
    logs = sorted(LOG_DIR.glob("heard_*.jsonl"))
    return logs[-1] if logs else None


def hush():
    subprocess.Popen([str(CALL), "hush"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def barge_in(line, cut=hush, say=print, mark=lambda: (CALL_DIR / "accepted").touch()):
    """He spoke over me: cut the mouth first (non-blocking), then hand the call his words."""
    cut()
    if line:
        mark()
        say(line, flush=True)


def live():
    gate = Gate(on_headphones)
    path = newest_log()
    fh = open(path) if path else None
    if fh:  # replay history silently (capture start, clock offset, my recent lines), then follow
        for line in fh:
            try:
                gate.feed(json.loads(line))
            except (ValueError, KeyError):
                continue
    gate.live_events = True
    last_seen = time.time()
    stop_file, muted_file = CALL_DIR / "stop-request", CALL_DIR / "muted"
    last_stop = mtime(stop_file)
    requests_dir = CALL_DIR / "requests"
    next_scan = 0.0
    focus = read_focus()  # a worker already on the call when listening starts is not news

    while True:
        stop_at = mtime(stop_file)
        if stop_at > last_stop:
            last_stop = stop_at
            print("USER: Stop. (The user pressed Stop on the pill: halt the current work and any helper "
                  "agents now, then say in a few words that you stopped.)", flush=True)
        if time.time() >= next_scan:  # the Workers pane's requests, twice a second
            next_scan = time.time() + 0.5
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
        line = fh.readline() if fh else ""
        if not line:
            newer = newest_log()
            if newer and newer != path:  # midnight roll
                path, fh = newer, open(newer)
                continue
            if time.time() - last_seen > HEARTBEAT_LIMIT_S:
                if not muted_file.exists():
                    print("EARS: down (no heartbeat)", flush=True)
                last_seen = time.time()
            time.sleep(0.1)
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        last_seen = time.time()
        out = gate.feed(rec)
        if not out:
            continue
        if out[0] == "down":
            if muted_file.exists():
                print("EARS: muted (the user turned the mic off on the pill; do not restart it)", flush=True)
            else:
                print(f"EARS: down ({out[1]})", flush=True)
        elif out[0] == "up":
            print("EARS: unmuted", flush=True)
        elif out[0] == "barge":
            barge_in(out[1])
        elif out[0] == "emit":
            if out[2] and os.environ.get("CALL_FILLERS") == "on":  # off by default: they sound canned
                play_filler()
            (CALL_DIR / "accepted").touch()  # the pill's Thinking follows this, not raw mic turns
            print(out[1], flush=True)


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
    import shutil
    import tempfile
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

    print(f"\n{checks - fails} passed, {fails} failed")
    return fails


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--replay")
    ap.add_argument("--since", default="00:00:00")
    ap.add_argument("--headphones", action="store_true")
    ap.add_argument("--speakers", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--worker", metavar="NAME")
    ap.add_argument("--receipt", action="store_true")
    ap.add_argument("--start", type=float)
    ap.add_argument("--stop", type=float)
    ap.add_argument("--call-dir", type=Path)
    ap.add_argument("--log-dir", type=Path)
    args = ap.parse_args()
    try:
        if args.selftest:
            raise SystemExit(1 if selftest() else 0)
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
