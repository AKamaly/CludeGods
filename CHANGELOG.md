# Changelog

All notable changes to CludeGods are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): while the version is 0.x, a minor
release adds features and a patch release fixes things.

## [Unreleased]

### Changed

- The README's launch film link opens the film on YouTube.

## [0.4.0] - 2026-11-02

### Added

- **Tutorial video in the README**: the Overview now opens with a 54-second walkthrough (a
  call, narrated steps, click to approve, a worker task, a worker on the call) in place of the
  static app screenshot.
- **One-paste install**: the README's Get started now opens with a prompt you paste into
  Claude Code; Claude installs VoiceMode, CludeGods and the panes, checks them, and tells you
  how to start your first call.
- **A settings file**: `~/.voicemode/call/config.json`, with an `approvals` block
  (`outward`, `permission_prompts`, `worker_publish`), `user_label`, and
  `workers.default_tools`. `install.sh` creates it from `config/config.example.json`, which
  explains every key, and never overwrites it.
- **Nothing said is lost when the listener restarts**: the Monitor that hears you expires
  every 30 minutes; a re-armed listener now delivers what you said in between, and one armed
  right after the call starts hears you from the first word.
- **Your name on the call**: `user_label` sets the label your lines carry (default `USER`).
- **`call status` explains itself**: the voice and Whisper services, what the ears last heard
  and how far behind, and whether a listener is armed.
- **A mute key**: `call mic` toggles the mic; bind it to a keyboard shortcut.
- **Today view** in the Workers pane: what waits for your yes across all workers, an **Ask
  all** field, and what each worker did since midnight.
- **Change** on an outbox item sends the worker a note on what to revise.
- **Workers report on themselves**: a worker's own chat fills in its `transcript` and writes
  `status/<key>.json` and `runs/<key>.jsonl`.
- **Default tools for new workers**: `workers.default_tools` in `config.json`, with "Make this
  the default" in the + New worker form.
- CI runs `permit --selftest`.

### Changed

- **Outward actions on a spoken yes**: on a call, a send, post, delete or purchase goes ahead
  on a clear spoken yes after Claude writes the exact action in the chat and reads it back in
  one sentence. `"outward": "typed"` restores the typed-yes rule.
- **Permission prompts stay in the app's own dialog** by default. `"permission_prompts":
  "pill"` sends them to CallPill, now only while a call is live.
- **Workers save Spaces pages directly** in the spaces they may write (`pages new`, or `pages
  publish` of their own draft). `"worker_publish": "approve"` restores draft-then-Approve for
  every worker. `pages publish` marks the draft's outbox item approved.
- **New workers start with full tools** (was drafts only) unless `config.json` says
  otherwise. The `read` and `drafts` presets are opt-in restrictions, and guard messages name
  the preset that denied a call.
- **One-step create**: + New worker adds the card at once and asks for its chat in one
  self-contained request; **Start chat** on the card asks again. A name already in use is
  refused.
- A worker with hours and no charter now wakes to check in on its role (**Check in** on the
  card).
- Status reads the worker's own report: Working and for how long, Idle, Stopped, an error, or
  No chat yet.
- The example Inbox worker files mail and sends drafts once you approve them.
- The example workers in `config/workers.example.json` all have full tools; presets are
  there to add when you want one, not the starting point.
- **A faster first word**: `call start --greet` speaks the greeting as soon as the voice is
  up, warmed in the call's own voice, and the skill starts the call in fewer steps.
- **Cut in and get an answer**: when you talk over Claude, the listener cuts the speech itself
  and Claude answers out loud right away; every turn gets a spoken reply, and spoken lines
  stay under 40 words.
- **Calmer narration**: steps never land on top of an answer, a helper's steps come at most
  every 20 seconds, "Working on it." only after a quiet stretch, and a step that would play
  late is dropped.
- `call stop` lets the goodbye finish (`--now` cuts it).

### Fixed

- `install.sh` keeps its backups of replaced skills in `~/.claude/cludegods-backups/`. A
  backup left in `~/.claude/skills/` loaded as a second copy of the skill.
- CI: the worker-permissions speed check gives shared CI runners more room (200 ms instead of
  50 ms), so a slow runner no longer fails `main`.
- Workers never got a `transcript`, so their status stayed New, Activity stayed empty, and
  the guard never enforced their tools. It does now: a worker given a narrow tool list may be
  denied tools it was quietly using; widen them in its Settings.
- Scheduled wakes with several chats open: a failed delivery is retried by any pane after a
  shared backoff, and a claim left by a closed chat is taken over once.
- inbox-relay could relay a worker's own messages back to it when its transcript was stored
  as a path.
- On laptop speakers, Claude's own narrated steps and worker intros, garbled by the mic, no
  longer cut its speech as if you had cut in, and a long echoed answer no longer comes back
  as a turn of stray numbers.
- Lines keep playing when the sound output changes mid-call (AirPods back in the case)
  instead of being dropped until the call is restarted.
- Outbox heads-ups stay quiet while the mic is muted.

### Security

- Memory pages change only through a draft you approve, whatever the settings.
- A worker's `pages new` and `pages draft` must carry its own `--worker` key.
- Changing `config.json`, or loosening a worker's tools or spaces, needs a typed yes, never a
  spoken one.

## [0.3.0] - 2026-11-01

### Added

- **Wake every few hours**: a worker's hours can be every 1, 2, 3, 4, 6 or 12 hours, within
  optional active hours (for example 9:00 to 18:00) on chosen days, besides once a day. Each
  slot wakes once however many panes run; after a gap only the latest missed slot fires.
- **Expanded Workers pane**: when the pane is wide, workers are listed on the left and the
  selected worker opens on the right, with Overview, Outbox, Activity and Settings tabs.
  Narrow, the selected card gets the same tabs.
- **Each worker's own colour**: the selected worker's god colour drives its border, badges,
  chips, tabs and settings, readable in light and dark.
- **A release process**: this changelog, CI on every pull request and push to `main` (the
  self-tests, the unit tests, the CallPill build and a snapshot of every pill state), a pull
  request template, and [CONTRIBUTING.md](CONTRIBUTING.md).

### Fixed

- Worker settings: choosing a god, tools preset, voice or hours could leave several options
  looking selected, and quick clicks could undo each other. Every choice is now a single
  selection that moves on the click, and settings writes are queued so the last click wins.

## [0.2.0] - 2026-11-01

### Added

- **The gods**: six characters (colleague, research, scribe, scout, sales, herald) with idle,
  talk, listen, work and happy states. `art/gods.js` is the source; the panes draw them as SVG,
  CallPill animates them from sprite strips (`scripts/render-gods.mjs`).
- **Workers pane redesign**: god cards with a drafts badge, status, an Ask field, hours, Run
  now, Outbox and Open; **Make them yours** settings (name, god, voice, hours, tools, pause,
  spaces); outbox **Approve** and **Decline** with a decisions log; an **Activity** view of
  each worker's last steps.
- **Spaces and Pages**: Markdown spaces under `~/.voicemode/call/spaces/`, the `pages` CLI,
  the Spaces pane (search, nested pages, Ask a worker, Open in editor), a **Memory** space every
  worker reads, and drafts that land only after your approval.
- **Per-worker voices**: `call say --voice / --as`; outbox heads-ups in each worker's voice.
- **Calls with a worker**: "put me on with Scribe" (`call focus`), and the pill shows that
  worker.
- **Call receipts**: each call leaves a summary page in the Calls space.
- **Tool permissions per worker**: the `guard` hook enforces `read`, `drafts`, `full` or an
  explicit tool list.
- **Slack bridge**: a local Socket Mode app with user and channel allow-lists, and the
  inbox-relay mod that hands messages to workers; `bin/reply`, `bin/bridge`.
- **Easy install**: `install.sh`, a plugin marketplace (`/plugin install workers-pane
  --marketplace AKamaly/CludeGods`), and a How to use it guide.

### Changed

- **CallPill is the film's call card**: the god on the call, a caption line, always-visible
  mic and stop buttons, light and dark, a compact mode, and a permission card with Deny and
  Allow. It no longer uses Metal or reads the microphone.
- Outbox drafts are approved with a click in the Workers pane or a typed yes in the worker's
  chat, never by voice.

### Fixed

- On laptop speakers, Claude's own lines could leak back as the user's words right after a
  call started, while speech-to-text was still warming up, and cut a worker's reply. Echo is
  now also caught by its words, whatever its timing.
- The Spaces pane crashed at startup when its `/spaces` command clashed with the `spaces`
  skill; the command is now `/spaces-pane`. Every space, page and subpage row has an Open
  button.
- The README architecture diagram failed to render (`call` is a Mermaid keyword).

## [0.1.0] - 2026-11-01

### Added

- The `colleague` skill: a live voice call with a Claude Code session on VoiceMode's ears and
  mouth, with an echo gate and barge-in.
- The `narrate` hook (each step said out loud) and the `permit` hook with CallPill, where only
  a physical click approves a permission.
- The Workers pane mod, and proactive workers with a charter, a schedule and an outbox.
- A Bluetooth patch for VoiceMode's mouth.
- The silent launch film, attached to the release.

[Unreleased]: https://github.com/AKamaly/CludeGods/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/AKamaly/CludeGods/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AKamaly/CludeGods/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AKamaly/CludeGods/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AKamaly/CludeGods/releases/tag/v0.1.0
