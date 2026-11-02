# Troubleshooting

Start with the doctor. It checks every part of CludeGods and says how to fix what is not
right:

```bash
~/.claude/skills/gods/bin/cludegods doctor
```

The Workers pane runs the same checks in its health strip (Voice, Listening, Workers) and
lists each red or amber one under **Needs you**, with a button when it has an automatic fix.
In Terminal, a failed check with a fix prints it as a line you can run:
`~/.claude/skills/gods/bin/cludegods doctor --fix <fix>`. The fix has its own name, which is
not always the check's (the `skills` check is fixed by `reinstall-skills`).

Below, `cludegods` means `~/.claude/skills/gods/bin/cludegods` and `call` means
`~/.claude/skills/gods/bin/call`. Voice checks (`vad`, `voice-service`, `whisper`, `mic`)
only run once voice is set up.

- [Doctor checks](#doctor-checks): [skills](#skills), [hooks](#hooks), [config](#config),
  [workers](#workers), [panes](#panes), [voice](#voice), [vad](#vad),
  [voice-service](#voice-service), [whisper](#whisper), [pill](#pill), [mic](#mic),
  [worker-chats](#worker-chats)
- [Call problems](#call-problems): [no sound](#no-sound), [the mic is silent](#the-mic-is-silent),
  [echo on laptop speakers](#echo-on-laptop-speakers),
  [the mic key or talk button does nothing](#the-mic-key-or-talk-button-does-nothing),
  [the pill is on the wrong screen](#the-pill-is-on-the-wrong-screen)

## Doctor checks

### skills

**Skills installed.** The `gods` or `spaces` skill (or `gods/bin/call`) is missing from
`~/.claude/skills`, or the old `colleague` skill from before 0.5 is still there and loads as
a second skill.

- **Fix:** **Reinstall**, or `cludegods doctor --fix reinstall-skills`. It runs `install.sh`
  again from the source you installed from, with the same options, which also moves the old
  `colleague` skill to `~/.claude/cludegods-backups/`.
- **By hand:** run the one-line installer again, or `./install.sh` in your clone. To remove
  only the old skill, move `~/.claude/skills/colleague` out of `~/.claude/skills`.

### hooks

**Hooks in settings.json.** The `narrate`, `guard` or `permit` hook is missing from
`~/.claude/settings.json`, or still points at `skills/colleague/`.

- **Fix:** **Add hooks**, or `cludegods doctor --fix reinstall-hooks`. It backs up
  `settings.json`, points old `colleague` hooks at `skills/gods`, and adds the missing ones,
  keeping every other hook.
- **By hand:** merge `config/settings.example.json` into `~/.claude/settings.json`. If the
  doctor says the file is not valid JSON, there is no automatic fix: correct it by hand,
  then check again. Restart the Claude app afterwards so every chat picks up the hooks.

### config

**Settings (config.json).** `~/.voicemode/call/config.json` is missing (every setting is
then its default), is not valid JSON, or has a value that is not one of its choices (the
doctor names the key, its choices and the default that applies).

- **Fix:** when it is missing, **Create it** (`cludegods doctor --fix restore-config`) copies
  the defaults. When it is not valid JSON, **Back up and reset**
  (`cludegods doctor --fix reset-config`) saves your copy to `~/.claude/cludegods-backups/`
  and writes the defaults. A value out of range has no button: edit the key.
- **By hand:** `config/config.example.json` explains every key. Copy it to
  `~/.voicemode/call/config.json`, or fix the one key the doctor names.

### workers

**Workers registry (workers.json).** `~/.voicemode/call/workers.json` is missing, is not
valid JSON or not `{"workers": [...]}`, or has an entry without a `key` or a key used twice.

- **Fix:** when it is missing, **Create it** (`cludegods doctor --fix create-workers`) writes
  an empty registry. Anything else has no button, because a repair could lose a worker: fix
  the file by hand.
- **By hand:** `config/workers.example.json` shows every field. Give each entry its own
  `key`. The Workers pane cannot read the file until it is valid.

### panes

**Workers and Spaces panes.** The `workers-pane` or `spaces-pane` plugin is not installed or
is turned off, or the Claude Code CLI was not found to check. `inbox-relay` missing is only a
note: it is needed for Slack alone.

- **Fix:** **Install panes**, or `cludegods doctor --fix install-panes`. It adds the
  `AKamaly/CludeGods` marketplace if needed, then installs or turns on each pane. Restart
  the Claude app afterwards.
- **By hand:** in the desktop app, **+** next to the prompt box, **Plugins**, **Add
  marketplace** with `AKamaly/CludeGods`, then add `workers-pane`, `spaces-pane` and, for
  Slack, `inbox-relay`. Or in a terminal session of Claude Code:
  `/plugin install workers-pane --marketplace AKamaly/CludeGods` (and the same for the
  others).

### voice

**Voice (VoiceMode).** Voice is not set up. This is not an error: Workers and Spaces work
without it, so the strip shows Voice and Listening as off instead of red.

- **Fix:** **Enable voice** on the Workers pane's Welcome view, or type `/gods` and say yes,
  or `cludegods doctor --fix setup-voice` (the same as `cludegods setup voice --yes`). It
  needs [Homebrew](https://brew.sh), downloads a few GB and takes a few minutes.
- **By hand:** `cludegods setup voice` shows what it will install and asks first. If a step
  fails it prints the next step; run it again and it picks up where it stopped. The manual
  commands are in the README's Manual install.

### vad

**Silero VAD (the ears).** The ears need `onnxruntime` in VoiceMode's Python and the model
at `~/.voicemode/models/silero_vad.onnx`, and one of them is missing.

- **Fix:** **Install Silero VAD**, or `cludegods doctor --fix setup-vad` (the same as
  `cludegods setup vad`).
- **By hand:**

  ```bash
  uv pip install --python ~/.local/share/uv/tools/voice-mode/bin/python onnxruntime
  mkdir -p ~/.voicemode/models
  curl -fL -o ~/.voicemode/models/silero_vad.onnx \
    https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
  ```

### voice-service

**Voice service (8890 or 8880).** Nothing answers on port 8890 (mlx-audio) or 8880 (Kokoro),
so calls have no voice.

- **Fix:** **Restart voice**, or `cludegods doctor --fix restart-voice`. It restarts
  mlx-audio (Kokoro on a Mac without Apple Silicon) and waits for it to answer. The first
  load after a restart can take a minute; check again before trying anything else.
- **By hand:** `voicemode service start mlx-audio`. If it stays down,
  `voicemode service logs mlx-audio` says why.

### whisper

**Whisper (2022).** Nothing answers on port 2022, so the ears cannot turn speech into text.

- **Fix:** **Restart Whisper**, or `cludegods doctor --fix restart-whisper`.
- **By hand:** `voicemode service start whisper`, and `voicemode service logs whisper` if it
  stays down. A missing model: `voicemode whisper model large-v3-turbo`.

### pill

**CallPill.** `CallPill.app` is not installed. Calls still work, without the floating card.
It is amber once voice is set up, and only a note before that.

- **Fix:** **Install CallPill**, or `cludegods doctor --fix rebuild-pill`. It builds CallPill
  when the Xcode command line tools are installed, and otherwise downloads the prebuilt app
  from the latest release and signs it on your Mac.
- **By hand:** `xcode-select --install`, then the fix again. If the download fails, the
  latest release may not carry `CallPill-macos.zip` yet; the Xcode tools are then the way.
  From a clone: `scripts/build-pill.sh ~/.claude/skills/gods/bin`.

### mic

**Mic last heard.** What the ears heard on the last call. It passes when there has been no
call yet, or when they heard you. It fails when:

- **The mic sends silence (level 0).** macOS is blocking the microphone. There is no button
  for this one: see [the mic is silent](#the-mic-is-silent).
- **The ears stopped with an error.** When the error is about Whisper, **Restart Whisper**
  (`cludegods doctor --fix restart-whisper`). Otherwise `call status` shows what is down;
  end the call and type `/gods` again.

### worker-chats

**Workers' chats.** A worker in the registry has no chat yet, no transcript yet, or a
transcript the doctor cannot find. There is no button: each case needs you in the Workers
pane.

- **No chat:** press **Start chat** on its card, then Enter on the request it puts in your
  prompt box.
- **No transcript yet:** its own chat fills this in on its first turn. Send it a task from
  its card. Until then the guard does not hold it to its tools.
- **Transcript not found:** the chat it points at is gone. **Open chat** on the card to
  check; if the chat was deleted, **Delete** the card (two presses) and create the worker
  again.

## Call problems

`call status` is the first look at a call: the ears, the mouth, the voice service, Whisper,
the speaker, the mic mode, what the ears last heard, and whether a listener is armed.

### No sound

- `call status` shows `voice: DOWN`: [voice-service](#voice-service).
- The first line after the voice service starts can take up to half a minute while the model
  loads.
- Lines play on the Mac's current sound output, and follow it when it changes. Check the
  `speaker:` line in `call status` and the volume of that device. `CALL_OUTPUT_DEVICE` pins
  one output.
- Crackling or cut-off speech on AirPods or other Bluetooth output: `cludegods setup
  bluetooth`. Run it again after upgrading VoiceMode.
- Still nothing: `call stop --now`, then `/gods` again.

### The mic is silent

Claude never hears you, or the doctor's `mic` check says the mic is sending silence.

1. **The macOS microphone permission.** Open System Settings, Privacy & Security,
   Microphone, and turn on **Claude** (calls run inside the Claude app). If you ran
   `cludegods setup voice` in Terminal, turn on Terminal (or your terminal app) as well, for
   its mic test. Then quit and reopen the Claude app, and start the call again.
2. **Muted.** The pill's mic button shows a red mic-slash. Press it, or `call unmute`.
3. **Push to talk.** `call mode` prints the mode. In `talk` the mic is off until you press
   the mic button, `call talk` or your mic key, and it closes after your turn.
   `call mode open` turns the always-on mic back on.
4. **The wrong input.** On headphones the call listens on the Mac's built-in mic, because
   Bluetooth headset mics drop to a low-quality call mode. `CALL_MIC_DEVICE` names another
   input.

### Echo on laptop speakers

On speakers the mic hears Claude's own voice, and there is no echo canceller. The echo gate
strips Claude's words from what the mic hears, so a cut-in needs at least two content words
that are not in Claude's own line. The signs: your cut-ins do not land, or now and then
Claude reacts to a garbled echo of its own line.

- **Headphones** fix it: nothing is stripped and two words of any kind cut in.
- **Push to talk** (`call mode talk`, or right-click the pill's mic button): the mic is off
  while Claude talks, so there is no echo to hear, and a press cuts Claude off.
- Lower the volume.
- To report a case the gate gets wrong, run
  `python3 ~/.claude/skills/gods/bin/listen.py --replay <log> --speakers` on that day's heard
  log (`~/.voicemode/logs/conversations/heard_YYYY-MM-DD.jsonl`) and include the decisions it
  prints. The log holds what you said, so read it before you share it.

### The mic key or talk button does nothing

- `call talk` needs a live call: start one with `/gods`.
- A Shortcuts key runs nothing until scripts are allowed: in Shortcuts, Settings, Advanced,
  turn on **Allow Running Scripts**. The action must run `~/.claude/skills/gods/bin/call mic`.
- In open mode, `call mic` mutes and unmutes; it only opens a turn in push to talk.

### The pill is on the wrong screen

CallPill opens on the screen under the mouse when the call starts, at the spot you last
dragged it to on that screen (top right until you move it), and it remembers one spot per
screen. Drag it where you want it. If its screen goes away, it comes back on the screen under
the mouse.

To forget every saved spot, hang up, then:

```bash
defaults delete dev.cludegods.callpill callCardPositions
```

The next call opens it top right on the screen under the mouse.
