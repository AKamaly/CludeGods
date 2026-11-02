/**
 * What a worker may do, as the guard reads it: `read` (Read, Grep, Glob, WebSearch,
 * WebFetch, LS), `drafts` (read, plus writes under ~/.voicemode/call and read-only
 * Bash), `full` (no guard), or an explicit allow-list of tool names.
 */
export type ToolsPreset = 'read' | 'drafts' | 'full'

/**
 * One worker as `~/.voicemode/call/workers.json` lists it (registry v2): the fields
 * the pane reads. The file may carry more (a model, an effort, keys a newer tool
 * added); the pane rewrites an entry key by key, so every key it does not know is kept.
 */
export type RegistryWorker = {
  key: string
  name: string
  role?: string
  /** The app's chat id (`local_…`): what SendMessage and the claude:// link take. */
  session?: string
  /**
   * The CLI transcript the live status and the activity view read: a bare file name
   * (found under ~/.claude/projects/<any project>/), a path relative to
   * ~/.claude/projects, `~/`-relative, or absolute. Absent for a chat not yet started.
   */
  transcript?: string
  /** A v1 colour preset (blue, violet, orange, rose, lime, gold); `god` wins when set. */
  avatar?: string
  /** The character drawn for it: colleague, research, scribe, scout, sales or herald. */
  god?: string
  /** Its Kokoro voice id; absent, the god's default. */
  voice?: string
  /** Absent means `full`, so a v1 worker keeps what it had. */
  tools?: ToolsPreset | string[]
  /** True: no scheduled wakes (Run now still works). */
  paused?: boolean
  /** Space slugs it may write pages to, or "*" for all; absent, Notes only (as `bin/pages` reads it). */
  spaces?: string[] | '*'
  /** The worker's standing brief: every wake carries all of it; the pane never draws it. */
  charter?: string
  /** When the pane wakes the worker to run its charter (or, with no charter, to check in on its role). */
  schedule?: Schedule
  /** When the pane wrote the entry (ISO), for a worker made with + New worker. */
  created?: string
}

/**
 * When the pane wakes the worker to run its charter, in the IANA zone `tz`, on the
 * weekdays `days` ("mon-fri", "sun-thu", "mon,wed,fri", "sat,sun" or "daily"). Two shapes:
 *
 * - Once a day (no `every`), as before: `{ "days": "mon-fri", "time": "09:00", "tz": "Asia/Riyadh" }`.
 *   Claimed as `wakes/<key>-<date>`; due from `time` until midnight.
 * - Every N hours: `{ "days": "mon-fri", "every": "3h", "from": "09:00", "to": "18:00", "tz": "Asia/Riyadh" }`.
 *   `every` is "1h", "2h", "3h", "4h", "6h" or "12h". Slots start at `from` (00:00 when
 *   absent) and repeat every N hours through `to`, inclusive (the end of the day when
 *   absent; a window never crosses midnight). Each slot is claimed as
 *   `wakes/<key>-<date>-<HHMM>` and is due until the next slot (or midnight): a missed
 *   slot fires once, late, and older missed slots never fire.
 */
export type Schedule = {
  days: string
  tz: string
  /** Once a day: "HH:MM". Ignored when `every` is set. */
  time?: string
  /** Every N hours: "1h" to "12h". */
  every?: string
  /** The interval's active hours, "HH:MM"; both absent is all day. */
  from?: string
  to?: string
}

/**
 * One line of `~/.voicemode/call/outbox/<key>.jsonl` (outbox v2), as the worker
 * appends it. A line written before v2 has no `id`: it gets `ob_` + the first 12 hex
 * of sha1(at + title).
 */
export type OutboxItem = {
  id: string
  at: string
  kind: 'draft' | 'note' | 'page'
  title: string
  body: string
  to?: string
  /** An email draft's subject line, when the worker wrote one. */
  subject?: string
  needs_approval: boolean
  /** A page's space and its draft awaiting review; `page` names the page a revision changes. */
  space?: string
  draft_path?: string
  page?: string
}

/**
 * One line of `outbox/<key>.decisions.jsonl`. `changes`: the owner asked for a revision
 * (`note` says what), so the item leaves the "needs your yes" list and the worker drafts
 * a new one.
 */
export type Decision = { id: string; decision: 'approved' | 'declined' | 'changes'; at: string; note?: string }

/** One tool call from a worker's transcript, as the activity view draws it. */
export type ActivityStep = { id: string; tool: string; arg: string; atMs: number }

/**
 * What a worker's status line says right now. `state` comes from the worker's own chat
 * (`status/<key>.json`, written as each turn starts and ends); without it, the status is
 * read from the transcript's mtime alone.
 */
export type WorkerStatus = {
  isWorking: boolean
  lastActiveMs: number
  isNew: boolean
  /** No `session` yet: the chat was asked for and has not started. */
  isStarting?: boolean
  state?: WorkerState['state']
  /** When the running turn started, or the last one ended. */
  sinceMs?: number
}

/**
 * `~/.voicemode/call/status/<key>.json`, written by the worker's own chat (this mod runs
 * in every chat, and a chat that finds itself in the registry reports on itself): what
 * it is doing, from its turns, not guessed from a file's mtime.
 */
export type WorkerState = {
  state: 'working' | 'idle' | 'stopped' | 'error'
  /** When this was written (ms). */
  at: number
  /** When the running turn started, or the last one did (ms). */
  since: number
  /** The first line of what the turn was asked, short. */
  asked?: string
}

/**
 * One line of `~/.voicemode/call/runs/<key>.jsonl`, appended by the worker's own chat as
 * each turn ends: what it was asked and the start of its answer. The Today view reads it.
 */
export type RunRecord = {
  at: string
  turn: string
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  durationMs: number
  asked: string
  answer: string
}

/** The `workers` key of `~/.voicemode/call/config.json`: what this pane owns there. */
export type WorkersConfig = { defaultTools: ToolsPreset }

/** The last task sent to a worker from the pane. */
export type SentTask = { text: string; atMs: number; isDelivered: boolean; reason?: string }

/**
 * The tab a worker's detail shows: Overview (the Ask field, hours, Run now, Open), its
 * outbox, its recent steps, or its settings. Absent is Overview.
 */
export type Panel = 'overview' | 'outbox' | 'activity' | 'settings'

/**
 * A setting picked in the pane and not yet read back from workers.json: drawn at once
 * in place of the registry's value, dropped once its write lands (or fails, or after a
 * few seconds). `value` null means the key is being removed.
 */
export type PendingEdit = { value: EditValue; at: number }

/** Worker key to field to its pending pick. */
export type PendingEdits = Record<string, Record<string, PendingEdit>>

/** A setting's value as workers.json holds it: plain JSON. */
export type EditValue = string | number | boolean | null | readonly EditValue[] | { readonly [key: string]: EditValue }

/**
 * The New worker form's drawn state; the typed "Name, role" line lives in the hook.
 * `isTried` turns on once a create was attempted with an invalid name, so the
 * hint shows only after a failed try, never before typing. `god` is a god kind.
 */
export type FormState = { isOpen: boolean; isValid: boolean; isTried: boolean; god: string; tools?: string }

/**
 * A create the pane put in the prompt box. The pane writes the entry itself (`key`);
 * if a call session that predates that registers a second entry of that exact name (or
 * key), the pane folds it into the first. An older pane's create has no `key`: then the
 * god, voice and tools are filled in where the new entry lacks them.
 */
export type PendingCreate = { god: string; voice: string; tools: ToolsPreset; atMs: number; known: string[]; key?: string }

/** What the pane body shows: the workers, or the Today digest across them. */
export type PaneView = 'workers' | 'today'

declare module 'claude-code' {
  interface PluginState {
    'workers-pane': {
      /** A signature of the registry and statuses: the poll's redraw trigger. */
      roster: Shaped<string>
      /** Bumped after the pane writes the registry, so the cards redraw at once. */
      rev: Shaped<number>
      sent: Shaped<Record<string, SentTask>>
      form: Shaped<FormState>
      /**
       * The worker whose detail shows: the card drawn with its god's colour (narrow), or
       * the row and the detail column (wide). '' or a key gone: the first worker.
       */
      selected: Shaped<string>
      /** Worker key to when its Delete was armed (ms); a second press within 5 s deletes. */
      confirming: Shaped<Record<string, number>>
      /** Worker key to when its delete request was written; cleared once it leaves the registry. */
      removing: Shaped<Record<string, number>>
      /** Whether the Workers pane is the one shown. */
      paneShown: Shaped<boolean>
      /** Worker key to the tab its detail shows; absent is Overview. */
      panels: Shaped<Record<string, Panel>>
      /** Outbox item id to when its Approve or Decline started (ms), while it runs. */
      deciding: Shaped<Record<string, number>>
      /** Worker name to the create waiting for the call session to register it. */
      pending: Shaped<Record<string, PendingCreate>>
      /**
       * Worker key to field to a setting picked but not yet written: what makes a radio
       * group's highlight move on the click, before the registry write lands.
       */
      edits: Shaped<PendingEdits>
      /** The Workers list, or the Today digest. */
      view: Shaped<PaneView>
      /** Outbox item id to true while its "What should change?" field is open. */
      changing: Shaped<Record<string, boolean>>
    }
  }
}
