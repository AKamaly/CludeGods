# Slack bridge

Mention the bot in Slack, or DM it, and the message lands in one of your workers' standing
chats. The worker answers in the same Slack thread. Replies in that thread keep going to the
same worker.

It runs on your Mac. The bridge uses Slack's Socket Mode, an outbound websocket from this Mac
to Slack, so there is no public URL, no open port, no webhook and no third-party relay.

```
Slack ──Socket Mode──> slack_bridge.py ──> ~/.voicemode/call/inbox/<worker>.jsonl
                         (allow-lists)            │
                                                  ▼  inbox-relay mod ($.session.send)
                                            the worker's chat
                                                  │  bin/reply <inbox-id> "..."
                                                  ▼
Slack <──thread reply── slack_bridge.py <── ~/.voicemode/call/replies/<inbox-id>.json
```

## 1. Create the Slack app from a manifest

1. Open https://api.slack.com/apps, choose **Create New App**, then **From a manifest**.
2. Pick your workspace, paste the manifest below (YAML tab), then **Create**.
3. **Install to Workspace** and allow the scopes.

```yaml
display_information:
  name: CludeGods
  description: Your Claude Code workers, reachable from Slack. Runs on your own Mac.
  background_color: "#c96442"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: CludeGods
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read   # see mentions of the bot
      - chat:write          # post the workers' replies
      - reactions:write     # the "eyes" reaction on a message a worker received
      - im:history          # read DMs sent to the bot
      - channels:history    # optional, see below
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
      - message.channels    # optional, goes with channels:history
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Why each scope is there, and what is left out:

- `channels:history` and `message.channels` let a reply in a thread reach the worker without
  mentioning the bot again. They also mean Slack sends the bridge every message in public
  channels the bot is a member of; the bridge drops all of it except replies in threads it
  already knows. If you would rather mention the bot every time, delete both lines.
- `im:read` is not needed: the bridge never looks up DM details. `users:read` is not needed:
  display names come from your allow-list (below).
- Private channels: mentions work once the bot is invited. Thread replies without a mention
  would need `groups:history` and `message.groups`; they are left out, so mention the bot in
  private-channel threads.

## 2. Tokens: into the keychain, never into a file

Two tokens:

- **Bot token** (`xoxb-...`): app settings, **OAuth & Permissions**, after installing.
- **App-level token** (`xapp-...`): **Basic Information**, **App-Level Tokens**, **Generate
  Token and Scopes**, scope `connections:write`. This is what Socket Mode connects with.

Store them in the macOS keychain. With `-w` last and no value, `security` asks for the token,
so it never lands in your shell history:

```sh
security add-generic-password -U -s cludegods-slack-bot -a "$USER" -w
security add-generic-password -U -s cludegods-slack-app -a "$USER" -w
```

Or set `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in the environment `bin/bridge start` runs in;
the environment wins over the keychain. The bridge never writes a token to disk or to its log.
To remove them: `security delete-generic-password -s cludegods-slack-bot` (and `-app`).

## 3. Allow-list and routes: `~/.voicemode/call/slack.json`

Only people and places listed here reach a worker. Everything else is dropped and logged.

```json
{
  "team": "T0123ABCD",
  "allow_users": { "U0123ABCD": "You", "U0456EFGH": "Teammate" },
  "allow_channels": { "C0123ABCD": "ops", "C0456EFGH": "launch" },
  "allow_dms": true,
  "default_worker": "scribe",
  "routes": {
    "write": "scribe",
    "C0456EFGH": "herald",
    "dm": "sales"
  }
}
```

| key | what it does |
|---|---|
| `allow_users` | Slack member ids allowed to reach a worker. A list, or a map of id to the name the worker sees. Required. |
| `allow_channels` | Channel ids where a mention counts. A list, or a map of id to name. |
| `allow_dms` | DMs to the bot from allowed users (default `true`). |
| `team` | Optional workspace id. When set, a message from anyone in another workspace (a Slack Connect channel) is dropped. |
| `default_worker` | The worker key a new conversation goes to when nothing else picks one. |
| `routes` | A word, a channel id, or `dm`, to a worker key (below). |

Ids, not names: a member id is in a person's profile, **More** (three dots), **Copy member ID**.
A channel id is at the bottom of the channel's details. The workspace id starts with `T`.

Then invite the bot to each allowed channel: `/invite @CludeGods`.

A running bridge picks up edits to `slack.json` within a second, so taking someone off the
list is immediate. A file that does not validate is logged and the last good one stays.

### Which worker gets a message

1. **A thread the bridge already knows** keeps its worker, whatever the reply says.
2. **A leading word**: a `routes` word, a worker key or a worker's name.
   `@CludeGods scout watch the pricing page` goes to `scout` with "watch the pricing page".
   `scout:` and `scout,` work too.
3. **The place**: `routes["dm"]` for a DM, `routes["<channel id>"]` for that channel.
4. **`default_worker`**. With none of these, the message is dropped and logged.

Worker keys are the `key`s in `~/.voicemode/call/workers.json`.

## 4. Run it

```sh
~/.claude/skills/colleague/bin/bridge start     # first start makes its own venv (below)
~/.claude/skills/colleague/bin/bridge status
~/.claude/skills/colleague/bin/bridge log
~/.claude/skills/colleague/bin/bridge stop
```

The first `start` installs `slack_sdk==3.45.0` (pinned) into
`~/.voicemode/venvs/slack-bridge` with `uv`. System Python is never touched. Checking the
config and `status` need only the standard library.

The inbox-relay mod (in the app's mods) hands each inbox line to the worker's chat and records
it in `inbox/<worker>.delivered`. A paused worker (`"paused": true` in `workers.json`) holds its
messages and you get a toast; they go out when it resumes.

### How a worker answers

The worker's chat receives:

```
Slack message from Teammate in #ops (id in_3f2a9c01b7de): can you draft the release note?

Reply in that thread with `~/.claude/skills/colleague/bin/reply in_3f2a9c01b7de "..."`. ...
```

```sh
~/.claude/skills/colleague/bin/reply in_3f2a9c01b7de "Draft is in the outbox for review."
~/.claude/skills/colleague/bin/reply in_3f2a9c01b7de < reply.md      # or from stdin
```

`reply` refuses an id that is in no inbox file. The bridge posts the reply in that thread,
converts Markdown to Slack's format, splits anything over 3,500 characters into ordered
pieces (code blocks closed and reopened across pieces), then deletes the file. If you run
workers behind a tool guard, allow this one command for them.

## What the bridge refuses

- Any sender not in `allow_users`, any channel not in `allow_channels`, DMs when
  `allow_dms` is off, another workspace when `team` is set.
- Bots (its own messages included), edits, deletions, joins and every other message subtype
  except a person's message with a file (the worker is told a file was attached, not given it)
  and a thread reply also sent to the channel.
- Plain channel messages that neither mention the bot nor reply in a thread it knows.
- A reply whose inbox id did not come from an allowed message. The destination always comes
  from the bridge's own record of that message (`slack-threads.json`); a channel or thread
  written in a reply file is ignored. Refused files move to `replies/.refused/`.
- A reply into a channel that has since left `allow_channels`.

Each drop is one log line with the reason, the user id and the channel id, never the text.

## What leaves the Mac

- **To Slack**: the replies your workers send with `bin/reply` (posted as the bot, in the
  thread they answer), the "eyes" reaction, and the API calls behind them (`auth.test`,
  `reactions.add`, `chat.postMessage`). The Socket Mode websocket is opened from this Mac.
- **From Slack to this Mac**: mentions of the bot, DMs to it, and with `channels:history`
  every message in public channels it is a member of. Only allowed messages are written
  down; the rest is dropped in memory.
- **To the model**: an allowed message becomes part of the worker's chat, so it is sent to
  Claude like anything else in that chat.
- Nothing else: no public endpoint, no relay service, no telemetry.

On disk, all mode 600, under `~/.voicemode/call/`: `inbox/` (message text), `replies/`,
`slack-threads.json` (channel and thread ids), `slack-bridge.log` (ids and reasons), and
`slack-bridge.state`. Anything posted to Slack follows your workspace's retention rules.

## Microsoft Teams: not supported yet

Teams has no Socket Mode. A Teams bot needs an Azure Bot registration, and Teams delivers
every message by HTTPS POST to a public messaging endpoint. Running that from this Mac means
exposing it through a tunnel or hosting a relay, which breaks the "local, no public URL" rule
this bridge keeps. `bin/bridge status teams` says so.

## Files

| file | what |
|---|---|
| `slack_bridge.py` | the daemon (`run`), `check` and `status`; standard library at import |
| `tests/` | `python3 -B -m unittest discover -s ~/.claude/skills/colleague/bridges/slack/tests` |
| `../../bin/bridge` | start, stop, status, log |
| `../../bin/reply` | a worker's reply into its thread |

The allow-list and thread rules (allowed users only, humans only, no edits or deletes, a
thread continues only once the bot was addressed in it, errors logged without provider text)
follow the Slack channel in CopilotKit's OpenDots (MIT). No code was copied.
