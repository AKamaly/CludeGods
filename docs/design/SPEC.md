# CludeGods v0.2 build spec: the film's look, OpenDots' features, Claude Code's engine

Goal: the app looks and behaves like the launch film. Every surface (Workers pane, call pill,
permission card, outbox, Spaces) uses the same characters, palette and card anatomy, and the
features OpenDots ships (Spaces and Pages, specialist workers with permissions, review before
saving, Slack, calls) exist here too, built on Claude Code primitives instead of a web server.

## 1. Look

Reference frames (1920x1080 or 960x540 PNG), read them before drawing anything:
- Gods line-up: `$FILM/snaps-gods/t2.00.png`
- Permission card + light call card: `$FILM/snaps-ui/t2.00.png`
- App with Workers pane + call card: `$FILM/snaps/t7.60.png`, `$FILM/snaps/t23.00.png`
- Dark call card: `$FILM/snaps/t30.00.png`
- Spoken steps: `$FILM/snaps/t35.50.png`; outbox "needs your yes": `$FILM/snaps/t44.90.png`
- Make them yours (name, voice, hours): `$FILM/snaps/t47.50.png`

`$FILM` is the launch film's working folder (not in this repo); `art/gods.js` is the character source.

### Palette (from claude-ui.js, use these exact values)
| token | hex | use |
|---|---|---|
| page | `#faf9f5` | card and pane background |
| side | `#f5f4ef` | inset fields, command boxes, chips |
| border | `#e8e6dc` | card border |
| border2 | `#dedcd1` | input border |
| text | `#1f1e1d` | primary text |
| sub | `#73726c` | secondary text |
| faint | `#9a988f` | meta, placeholders |
| accent | `#c96442` | Allow button, send chip, selected border, badges' text |
| accentHi | `#d97757` | hover |
| accentSoft | `#fbe9e5` | badge background, terminal icon tile |
| selectedBorder | `#e6c4b6` | selected card ring (outer), accent inner |
| green | `#2f8f5b` | "Working", "Allowed" |
| amber | `#b7791f` | "needs your yes" |
| red | `#c2412d` | stop square, Deny-confirmed |
| blue | `#3b6fd8` | spoken-line text ("Reading the CI log.") |
| dark card | `#1b1b24` to `#121219` | dark call card only |

Fonts: Geist / Geist Mono in rendered art (`$FILM/fonts`). Native surfaces use the system font
(SF Pro) and SF Mono, which read the same at these sizes.

### Card anatomy (Workers pane, from t23.00 / t44.90)
```
[god 40px] Name  [2 drafts]                     ● Working   |  ○ Idle · 3m ago
           Role line, dim, one line
[ Ask Name…                                         (↑) ]   <- inset field, orange send chip
(⏱ Mon to Fri · 9:00)          ▷ Run now   ▭ Outbox · 2   Open ↗
```
- White card on page, 1px border, 10-12px radius where the surface allows.
- Selected card: accent border. Working: green dot + "Working". Idle: hollow dot + "Idle · <ago>".
- Badge: accentSoft background, accent text ("2 drafts", "1 draft").
- Header: "Workers · N standing chats" left, "+ New worker" button right.
- Outbox rows: file icon, title, right-aligned amber "needs your yes", then Approve / Decline.
- Icons: thin line icons (Lucide style, 1.5px stroke, ISC licence, credit in NOTICE).

### Call card (from snaps-ui t2.00 and t30.00)
- White card, 16px radius, soft shadow. Top row: orange dot + "Claude" (or the worker's name),
  timer right in mono (OFF by default, `CALLPILL_TIMER=on` shows it: the owner removed it).
- The god in the middle (colleague for the main call, the worker's own god when a worker is on).
- One caption line under the god: what is being said, or "Listening" / "Thinking".
- Two round buttons: mic (white, thin border) and stop (soft red circle, red square).
- Dark variant uses the dark card colours; follow the system appearance.

### Permission card (from snaps-ui t2.00)
- Terminal icon in an accentSoft tile + "Claude wants to run" (bold).
- Mono command box (side background, border2).
- Deny (outlined) and Allow (accent, white text) right-aligned. After a click: "✓ Allowed" green
  or "Denied" sub colour, then the card leaves.

## 2. The gods

Six characters, glossy sphere + face + gold halo + one accessory (source of truth: `$FILM/gods.js`):

| kind | body c / c2 | accessory | default role |
|---|---|---|---|
| colleague | `#b9c6ff` / `#3d4aa0` | headphones | the voice call itself |
| research | `#a78bfa` / `#6d28d9` | glasses | research |
| scribe | `#60a5fa` / `#2563eb` | quill | drafting |
| scout | `#a3e635` / `#65a30d` | wings | watching things |
| sales | `#fb923c` / `#ea580c` | paper plane | follow-ups |
| herald | `#facc15` / `#ca8a04` | trumpet | announcements |

States: `idle | talk | listen | work | happy`.

### Contracts
- **SVG** (Workers pane, Spaces pane): `mods/workers-pane/hooks/gods.ts`
  ```ts
  export type GodKind = 'colleague'|'research'|'scribe'|'scout'|'sales'|'herald'
  export type GodState = 'idle'|'talk'|'listen'|'work'|'happy'
  export const GOD_KINDS: readonly GodKind[]
  export function godSvg(kind: GodKind, opts?: { size?: number; state?: GodState;
    animated?: boolean; halo?: boolean }): string   // a whole <svg>, < 60k chars
  ```
  `animated: true` uses SMIL only (bob, blink, halo glint, talk mouth), shown with
  `<Svg isInteractive>`; still frames otherwise. Transparent background. Other mods copy this file
  (a mod cannot import another mod's files): `spaces-pane/hooks/gods.ts` is a verbatim copy.
- **Sprites** (call pill, native): `skills/colleague/bin/gods/<kind>-<state>.png`, each a
  horizontal strip of `frames` square frames, plus `skills/colleague/bin/gods/index.json`
  `{ "frame": 256, "frames": 24, "fps": 12, "box": 1.6 }`. Rendered from gods.js by
  `scripts/render-gods.mjs` (puppeteer-core + chrome-headless-shell, like `$FILM/render.js`).
  `box`: the frame is 1.6x the sphere diameter, sphere centred, halo inside the frame.
- `art/gods.js` + `art/gods.html` in the repo: the character source, copied from the film.

## 3. State files (all under `~/.voicemode/call/`)

### workers.json v2 (pane writes, everyone reads; unknown keys must be preserved)
```jsonc
{ "workers": [ {
  "key": "scribe", "name": "Scribe", "role": "Drafts docs and replies, drafts only",
  "god": "scribe",                 // NEW, GodKind. Missing: derive from "avatar" colour:
                                   // purple→research, blue→scribe, green→scout,
                                   // orange|red→sales, yellow→herald, else colleague
  "voice": "af_heart",             // NEW, Kokoro voice id. Missing: per-god default
                                   // colleague af_heart, research af_nicole, scribe bf_emma,
                                   // scout am_adam, sales am_michael, herald bm_george
  "tools": "drafts",               // NEW, "read" | "drafts" | "full" | string[] of tool names
  "paused": false,                 // NEW, true: no scheduled wakes
  "spaces": ["notes"],             // NEW, Spaces this worker may write to
  "model": "...", "effort": "...", "session": "local_…", "transcript": "….jsonl",
  "avatar": "blue", "charter": "...", "schedule": { … }
} ] }
```
Tool presets: `read` = Read, Grep, Glob, WebSearch, WebFetch, LS. `drafts` = read + Write/Edit
only under `~/.voicemode/call/` (outbox, spaces drafts) + Bash read-only allow-list. `full` = no
guard. A string array is an explicit allow-list.

### outbox/<key>.jsonl v2 (worker appends, pane reads)
```jsonc
{ "id": "ob_<12 hex>", "at": "<ISO>", "kind": "draft" | "note" | "page",
  "title": "...", "body": "...", "needs_approval": true,
  "to": "...",                                  // drafts
  "space": "notes", "draft_path": "...md" }     // pages: review before saving
```
Old lines without `id`: id = `ob_` + first 12 hex of sha1(at + title).
Decisions: `outbox/<key>.decisions.jsonl` lines `{ "id", "decision": "approved"|"declined", "at" }`.
An item with a decision leaves the "needs your yes" list.
- Approve on a `draft`/`note`: `$.session.send` to the worker: "Approved in the Workers pane:
  <title> (<id>). Go ahead with exactly what the draft says, then report back."
- Approve on a `page`: run `~/.claude/skills/colleague/bin/pages publish <draft_path> --space <space>`,
  then tell the worker it was saved.
- Decline: tell the worker "Declined: <title> (<id>). Don't do it." No other effect.

### spaces/ (Spaces and Pages)
`spaces/<space-slug>/space.json` `{ "name", "created", "emoji"? }` and
`spaces/<space-slug>/<page-slug>.md` with front matter (`title`, `created`, `updated`, `by`
(worker key or "you"), `parent` (page slug, optional)). Drafts awaiting review live in
`spaces/.drafts/<id>.md` with the same front matter plus `space`.
CLI `~/.claude/skills/colleague/bin/pages`: `list [--space S] [--q text]`, `show S/page`,
`new S "Title" [--from file|-]`, `draft S "Title" --worker K [--from file|-]` (writes the draft
AND the outbox `page` item), `publish <draft_path> --space S`, `spaces`, `mkspace "Name"`.

### Calls with a worker
`focus` holds the worker key on the call, empty for the main colleague. The pill draws that
worker's god and name; the call session routes the owner's lines to that worker; the worker
speaks with `call say --voice <its voice>` (lines also tagged in `said`).

### Bridges (Slack first)
- Inbound: `inbox/<key>.jsonl` lines `{ "id", "at", "source": "slack", "from", "channel",
  "thread", "text", "delivered": false }`. The inbox-relay mod delivers each undelivered line to
  the worker with `$.session.send`, then records it in `inbox/<key>.delivered`.
- Replies: the worker runs `~/.claude/skills/colleague/bin/reply <inbox-id> "<text>"`, which writes
  `replies/<inbox-id>.json`; the bridge daemon posts it in that thread and deletes the file.
- Only allow-listed Slack users and channels reach a worker. Everything else is dropped and
  logged. Tokens come from the environment or the macOS keychain, never from a file in the repo.

## 4. Who owns what (parallel build: never edit a file you do not own)

| track | owns (live path) |
|---|---|
| A gods art | `dev-mods/<s>/workers-pane/hooks/gods.ts`, `~/.claude/skills/colleague/bin/gods/`, repo `art/`, repo `scripts/render-gods.mjs` |
| B Workers pane | `dev-mods/<s>/workers-pane/` except `hooks/gods.ts` |
| C call pill | `~/.claude/skills/colleague/bin/pill.swift`, `CallPill.app`, repo `scripts/build-pill.sh` |
| D Spaces | `dev-mods/<s>/spaces-pane/`, `bin/pages`, `~/.claude/skills/spaces/` |
| E bridges | `dev-mods/<s>/inbox-relay/`, `~/.claude/skills/colleague/bridges/`, `bin/reply`, `bin/bridge` |
| F voice + guard | `bin/call`, `bin/listen.py`, `bin/narrate`, `bin/outbox-say`, new `bin/guard`, `~/.claude/skills/colleague/SKILL.md`, `~/.claude/settings.json` hooks |

`<s>` = the session's dev-mods folder. Integration, the public repo, README, commits and pushes:
the lead session only. Tracks write files; they never run `git add`, `commit` or `push`.

## 5. Rules for every track
- Do not break what works today: the live call, the pill, the Workers pane and the Sales
  worker's schedule are in daily use. Read before you write; keep every existing behaviour.
- Mods: validate and test with the app's CLI, not the `claude` on PATH:
  `CC="$HOME/Library/Application Support/Claude/claude-code/2.1.309/5af865b9901c/claude.app/Contents/MacOS/claude"`
  then `"$CC" plugin validate <mod>` and `"$CC" plugin test <mod>`. Desktop quirks already
  learned: each `Input` draws its own submit chip; `Button` ignores Text colour; `Svg` sizes are
  CSS px; the `Svg` markup is drawn as an image (gradients, filters fine; SMIL needs `isInteractive`).
- Nothing sends, posts or publishes anything outward during the build. Slack is built and tested
  against a fake client; live use waits for the owner's own tokens.
- Public-repo hygiene (everything you write may be published): no company, deal or person names,
  no session ids, no absolute home paths (use `~` or `$HOME`), no tokens.
- Copy style: short, plain, no em dashes, no exclamation marks.
- Report: what you built, how you verified it (commands + results, screenshots as file paths),
  what is not verified, and every file you touched.
