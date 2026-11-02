# Changelog

All notable changes to CludeGods are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): while the version is 0.x, a minor
release adds features and a patch release fixes things.

## [Unreleased]

### Added

- **Tutorial video in the README**: the Overview now opens with a 54-second walkthrough (a
  call, narrated steps, click to approve, a worker task, a worker on the call) in place of the
  static app screenshot.
- **One-paste install**: the README's Get started now opens with a prompt you paste into
  Claude Code; Claude installs VoiceMode, CludeGods and the panes, checks them, and tells you
  how to start your first call.

### Fixed

- CI: the worker-permissions speed check gives shared CI runners more room (200 ms instead of
  50 ms), so a slow runner no longer fails `main`.

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

[Unreleased]: https://github.com/AKamaly/CludeGods/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/AKamaly/CludeGods/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AKamaly/CludeGods/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AKamaly/CludeGods/releases/tag/v0.1.0
