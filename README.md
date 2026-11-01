# CludeGods

Talk to Claude Code like a colleague, out loud, inside the Claude desktop app. Keep a few
always-on worker chats beside you and hand them tasks by voice or from a pane.

CludeGods is a small set of parts that sit on top of Claude Code and
[VoiceMode](https://github.com/mbailey/voicemode):

- **`colleague` skill**: a live voice call with your Claude Code session. An
  always-on mic streams your words in, Claude answers out loud without blocking its own
  work, and you can cut in at any time.
- **CallPill**: a floating macOS status card with a live voice orb, mute and stop
  controls, and the only place outside the app where a permission prompt can be approved,
  by a physical click.
- **Hooks**: `narrate` says each step out loud as it happens; `permit` routes permission
  prompts to the pill.
- **Workers pane mod**: a pane beside the chat with your standing worker chats as persona
  cards, live status, and a task box per worker.

> Demo GIF goes here: `docs/demo.gif`

## What it feels like

You type `/colleague`. A small orb appears in the corner and Claude says "I'm here. What's
first?" You talk the way you would to someone sitting next to you: "Can you check why the
build broke this morning?" Claude says "Hmm, let me look," and while it reads logs you hear
"Reading the CI log." and "Searching the code." between your own questions. Halfway through
its answer you say "wait, not that one," and it stops talking and listens.

Long jobs go to helper agents that report milestones in a sentence. Anything outward, like
an email or a post, lands in the chat as a draft, and nothing goes out until you type yes.

Over on the right, the Workers pane shows your standing chats: Research is working, Scribe
is idle since ten minutes ago. You type a task into Scribe's box and press Enter.

## Architecture

```mermaid
flowchart LR
  mic([Microphone]) --> ears

  subgraph VoiceMode["VoiceMode (local services)"]
    ears["ears: voice_mode.listen<br/>Silero VAD + Whisper large-v3-turbo"]
    mouth["mouth: voice_mode.mouth<br/>mlx-audio Kokoro (Kokoro-FastAPI fallback)"]
  end

  ears -- "heard_*.jsonl" --> listen["listen.py<br/>echo gate + barge-in"]
  listen -- "USER: ... lines" --> monitor["Monitor tool"]
  monitor --> call["the call session<br/>(Claude Code, colleague skill)"]
  call -- "call say" --> mouth
  mouth --> spk([Speakers / headphones])
  listen -. "call hush on barge-in" .-> mouth

  call -- "PreToolUse" --> narrate["narrate hook"]
  narrate -- "call say" --> mouth

  call -- "PermissionRequest" --> permit["permit hook"]
  permit -- "permit/&lt;id&gt;.json" --> pill["CallPill"]
  pill -- "click writes &lt;id&gt;.answer" --> permit
  ears -- "heard log (state)" --> pill
  pill -- "mute / stop" --> call

  pane["Workers pane mod"] <--> reg[("~/.voicemode/call/workers.json")]
  call <--> reg
  pane -- "send task / open" --> workers["worker chats"]
  pane -- "requests/*.json" --> listen
  call -- "start_session / SendMessage" --> workers
  pane -- "scheduled wake / Run now" --> workers
  workers -- "outbox/*.jsonl" --> pane
  pane -- "outbox-say" --> mouth
```

Everything runs on your Mac. The only state is plain files under `~/.voicemode/call/`.

## Components

### `skills/colleague/bin/call`

The plumbing, one shell script. `call start` launches the ears (always-on capture with
Silero VAD and Whisper), the mouth (a non-blocking speech queue), and the pill.
`call say "text"` returns at once and lines queue in order; `call say --now` cuts in.
`call hush`, `call mute`, `call unmute`, `call stopwork`, `call stop`, `call status`.
Settings by environment: `CALL_VOICE` (default `af_heart`), `CALL_SPEED`,
`CALL_SILERO_THRESHOLD`, `CALL_SILENCE_S`, `CALL_MIC_DEVICE`, `VOICEMODE_PY`.

### `skills/colleague/bin/listen.py`

Runs under Claude Code's `Monitor` tool and turns the ears' log into one line per event:
`USER: …`, `USER (over you): …`, `EARS: down`, `EARS: muted`, `PANE: …`. Two jobs:

- **Echo gate.** On laptop speakers the mic hears Claude's own voice and there is no echo
  canceller. A turn whose audio starts while Claude is speaking has Claude's words stripped
  (loosely matched, because the echo comes back garbled), and only a real remainder gets
  through. On headphones nothing is stripped.
- **Barge-in.** While a line is playing, each partial transcript is checked at once. If it
  is you, the mouth is cut and your words go to the session without waiting for the turn to
  end.

`listen.py --selftest` runs the gate against synthetic logs; `--replay FILE` runs a real
log through it and prints every decision.

### `skills/colleague/bin/narrate`

A `PreToolUse` hook. During a live call, and only in the call's own session, it turns the
tool call into a short spoken line ("Now I'm going to run the tests.", "Reading
config.py.") at most once every 6 seconds. Standard library only, always exits 0, never
blocks a tool.

### `skills/colleague/bin/permit` and CallPill

`permit` is a `PermissionRequest` hook. If CallPill is not running it does nothing and the
app behaves as usual. If it is, it writes the request to `~/.voicemode/call/permit/<id>.json`
and waits up to 50 seconds for `<id>.answer`. CallPill shows the request in a panel beside
the orb with Deny and Allow. A mouse click is the only thing that writes the answer. On a
timeout the hook prints nothing and the normal in-app dialog takes over.

CallPill (`pill.swift`) is a native AppKit and Metal app: the orb from
`design/orb.html` ported to a Metal shader, states for Listening, You, Thinking, Claude and
Mic off, hover controls for Mute and Stop, scroll or pinch to resize. It can also list
sessions waiting on you from `~/.voicemode/call/pending/*.json` with an Open button per
row (see [Waiting sessions](#waiting-sessions-optional)).

### `mods/workers-pane`

A Claude Code mod (plugin with a hooks module) for the desktop app. It draws a Workers pane
from `~/.voicemode/call/workers.json`: one card per worker with an animated SVG avatar,
Working or Idle status read from the worker's transcript, a task box that sends straight to
that chat, and a two-press Delete; the name opens the chat. Workers with a charter also get
Run now, a schedule, and an outbox feed (see [Proactive workers](#proactive-workers)).
"+ New worker" puts a `Create worker: …` request
in your prompt box for your own Enter, because the app refuses to start sessions from
automated events. A `Workers · N` launcher sits in the footer. All paths are resolved from
`$HOME` at runtime.

`tsconfig.json` only extends `.claude-plugin/types/tsconfig.json`, which Claude Code
generates when it loads the mod. It is there so your editor and `tsc` type-check the mod;
the generated types are not committed.

### `patches/voicemode-mouth-bluetooth.patch`

A small diff against VoiceMode's `voice_mode/mouth/output.py`: play at the output device's
native sample rate (48 kHz on AirPods) with continuous upsampling, and open the stream at
high latency. Without it, Bluetooth outputs crackle. `VOICEMODE_MOUTH_LATENCY` overrides
the latency.

### `skills/colleague/design/`

`orb.html` is the WebGL reference for the orb; `workers.html` is the pane mockup. Open
either in a browser.

## Install (macOS on Apple Silicon)

You need the Claude desktop app with Claude Code, Homebrew, `uv`, and the Xcode command line
tools (`xcode-select --install`).

1. **VoiceMode.** In Claude Code:

   ```
   /plugin marketplace add mbailey/voicemode
   /plugin install voicemode@voicemode
   /voicemode:install
   ```

   This installs the `voicemode` CLI as a uv tool. Then the local services:

   ```bash
   voicemode service install whisper
   voicemode service install kokoro
   voicemode service install mlx-audio
   voicemode whisper model large-v3-turbo
   voicemode service enable whisper
   voicemode service enable mlx-audio
   ```

2. **Silero VAD** into the VoiceMode environment:

   ```bash
   VM_PY=~/.local/share/uv/tools/voice-mode/bin/python
   uv pip install --python "$VM_PY" onnxruntime
   mkdir -p ~/.voicemode/models
   curl -L -o ~/.voicemode/models/silero_vad.onnx \
     https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
   ```

3. **The Bluetooth patch** (recommended if you use AirPods or other Bluetooth output):

   ```bash
   SITE=$("$VM_PY" -c 'import voice_mode, os; print(os.path.dirname(voice_mode.__path__[0]))')
   patch -d "$SITE" -p1 --dry-run < patches/voicemode-mouth-bluetooth.patch && \
   patch -d "$SITE" -p1 -b < patches/voicemode-mouth-bluetooth.patch
   ```

   Reinstalling or upgrading VoiceMode removes it; apply it again after.

4. **Copy the skill and build the pill:**

   ```bash
   mkdir -p ~/.claude/skills
   cp -R skills/colleague ~/.claude/skills/
   scripts/build-pill.sh ~/.claude/skills/colleague/bin
   ```

   The first time the pill runs, macOS asks for microphone access (it reads the level so the
   orb moves with your voice; nothing is recorded).

5. **Add the hooks.** Merge `config/settings.example.json` into `~/.claude/settings.json`
   (keep any hooks you already have). It registers `narrate` on `PreToolUse` and `permit` on
   `PermissionRequest`.

6. **Workers registry.** Start from the example, or let the call session create workers for
   you:

   ```bash
   cp config/workers.example.json ~/.voicemode/call/workers.json
   ```

   Replace the placeholder `session` ids with your own chats' ids (`local_…`) and
   `transcript` with the path of each chat's `.jsonl`, relative to `~/.claude/projects/`.

7. **Load the mod.** Either:
   - hot-reload it while you work on it, through the plugin-authoring flow in the desktop
     app (ask Claude to load `mods/workers-pane` as a mod), or
   - start Claude Code with `--plugin-dir /path/to/CludeGods/mods/workers-pane`, or set
     `CLAUDE_CODE_PLUGIN_DIRS=/path/to/CludeGods/mods/workers-pane`.

## Usage

- **Start a call:** type `/colleague` (or say "let's talk" in a chat with the skill
  installed). Claude starts the ears, the mouth and the pill, arms the listener, and greets
  you. The conversation runs best on Haiku at low effort; heavier work goes to Sonnet or
  Opus helpers automatically.
- **The pill:** hover for Mute (the mic is really off, capture stops) and Stop (cuts speech
  and tells the session to halt current work and helpers). Drag to move, scroll or pinch to
  resize. Permission requests appear to its left with Deny and Allow.
- **Hang up:** say "that's it" or "end the call".
- **Workers pane:** open it from the `Workers` launcher in the footer, `/workers`, or by
  asking on the call. Type a task in a card and press Enter to send it. Click the name to
  jump to that chat. Delete needs two presses; the chat is archived, not deleted.

### Waiting sessions (optional)

CallPill can list sessions waiting on you. It reads `~/.voicemode/call/pending/*.json`,
one record per session:

```json
{"session_id": "…", "at": 1767268800.0, "title": "Fix the build", "message": "Waiting for approval",
 "link": "claude://claude.ai/epitaxy/local_…", "transcript_path": "…", "cwd": "…"}
```

Write these from your own `Notification` hook if you want the list. Open only ever opens a
`claude://` session link; there is no Allow in that list.

## Safety model

The mic hears the whole room: a video, a phone call, another person. The design assumes it
will mishear.

- **Only a physical click approves a permission.** The `permit` hook waits for an answer file
  that only the pill's mouse-click handler writes. There is no keyboard path and no voice
  path, and clicks are ignored for 0.6 seconds after a request appears so a new request
  cannot catch a click meant for the previous one.
- **Outward actions need a typed yes.** Sending email or messages, posting, publishing,
  deleting, purchases, invites: the exact action goes in the chat and Claude waits for you to
  type yes. A spoken yes does not count.
- **Voice never starts sessions.** New worker chats start only from text you submit
  yourself. The desktop app also refuses session starts from automated events, so a mod or
  hook cannot do it on its own.
- **Names are never fuzzy-matched.** If Claude is unsure it heard a person or company right,
  it asks.
- **The echo gate** keeps Claude from hearing itself on laptop speakers and acting on its
  own words as if you had said them. Lines that make no sense as speech are treated as room
  noise and questioned, never acted on.

## Honest limits

- Your Mac and the Claude desktop app must be on. Nothing here runs in the cloud.
- macOS on Apple Silicon only (Metal, AppKit, mlx-audio).
- On laptop speakers, a barge-in needs at least two content words that are not in Claude's
  own line. On headphones two words of any kind are enough.
- The Workers pane uses desktop app mod surfaces (panes, the footer launcher, SVG). In the
  terminal it degrades to plain text.
- VoiceMode's always-on ears (`voice_mode.listen`) and non-blocking mouth
  (`voice_mode.mouth`) are experimental upstream and may change between releases.
- The first spoken line after a cold start can take up to a minute while the voice model
  loads.

## Proactive workers

A worker can run on its own and report back instead of waiting for a task. Two optional
registry fields turn it on (see the `inbox` worker in `config/workers.example.json`):

- **`charter`**: the worker's standing instructions, limits included. For example: each
  run, read new replies, draft follow-ups to the outbox, never send. The card never shows
  it; every wake sends all of it.
- **`schedule`**: when it runs, as `{"days": "mon-fri", "time": "09:00", "tz": "UTC"}`.
  `days` takes a range (`mon-fri`, `sun-thu`, `fri-mon`), a list (`mon,wed,fri`) or
  `daily`; `tz` is any IANA zone. The card shows it as one dim line after the role:
  `role · Mon–Fri · 9:00`.

**The pane is the scheduler.** At the scheduled time the Workers pane sends the worker's
own chat a wake message carrying its charter. It has to be the pane: the only local thing
that can put a message into an existing desktop chat is a mod's `$.session.send`. A
launchd job or cron has no way into a chat, and a scheduled task starts a new session
instead of waking the one that holds the worker's context. Each wake claims
`~/.voicemode/call/wakes/<key>-<date>` with an atomic `mkdir`, so a worker is woken once a
day however many sessions run the pane. A wake that is not delivered (the chat is not
running yet) gives its claim back and retries every 10 minutes.

**Run now** on a card sends the same wake at once.

**The outbox.** The charter tells the worker to append one JSON line per item to
`~/.voicemode/call/outbox/<key>.jsonl`:

```json
{"at": "2026-01-05T09:04:00Z", "kind": "draft", "title": "a reply to the venue about Friday",
 "body": "Hi, Friday works for us...", "to": "events@example.com", "needs_approval": true}
```

`kind` is `draft` (something outward, `needs_approval: true`) or `note` (a finding). The
card's Outbox button reads `Outbox · 2 drafts` while something is new, and it is the only
draft indicator. Pressing it lists the newest items with their recipient, age and first
lines, and marks them seen. The pane never sends anything.

**The spoken heads-up.** Each new outbox line is toasted in the app. During a live call,
`skills/colleague/bin/outbox-say` also speaks one line for it ("Inbox drafted a reply to
the venue about Friday"), once per line, however many panes saw it.

**Approvals stay a typed yes in the worker's own chat.** Click the worker's name (or Open
chat under the feed) to review a draft there, edit it, and type yes to send. A spoken yes
does not count.

Limits:

- The desktop app must be open. The pane runs inside it; nothing wakes a worker while it is
  closed.
- A wake missed while the Mac sleeps or the app is closed fires later the same day, as soon
  as the pane polls again.
- A day missed entirely is skipped, not replayed.

## Repository layout

```
skills/colleague/        the skill: SKILL.md, bin/ (call, listen.py, narrate, permit, outbox-say, pill.swift), design/
mods/workers-pane/       the Workers pane mod
patches/                 the VoiceMode Bluetooth diff
config/                  example settings hooks and workers registry
scripts/build-pill.sh    builds and ad-hoc signs CallPill.app
```

## Credits

- [VoiceMode](https://github.com/mbailey/voicemode) by Mike Bailey (MIT): the ears, the mouth
  and the local service manager this all runs on.
- [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M): the voice.
- [Whisper](https://github.com/openai/whisper) and
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp): speech to text.
- [Silero VAD](https://github.com/snakers4/silero-vad): voice activity detection.
- [mlx-audio](https://github.com/Blaizzy/mlx-audio): fast local speech on Apple Silicon.

## License

MIT, see [LICENSE](LICENSE). See [NOTICE](NOTICE): CludeGods is an independent community
project, not affiliated with or endorsed by Anthropic. It works with Claude Code; "Claude" is
a trademark of Anthropic.
