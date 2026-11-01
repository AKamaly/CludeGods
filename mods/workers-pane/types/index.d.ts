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
  /** When the pane wakes the worker to run its charter. */
  schedule?: Schedule
}

/**
 * A wake time: `days` like "mon-fri", "sun-thu", "mon,wed,fri" or "daily"; `time`
 * "HH:MM" in the IANA zone `tz`.
 */
export type Schedule = { days: string; time: string; tz: string }

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
  needs_approval: boolean
  /** A page's space and its draft awaiting review; `page` names the page a revision changes. */
  space?: string
  draft_path?: string
  page?: string
}

/** One line of `outbox/<key>.decisions.jsonl`. */
export type Decision = { id: string; decision: 'approved' | 'declined'; at: string }

/** One tool call from a worker's transcript, as the activity view draws it. */
export type ActivityStep = { id: string; tool: string; arg: string; atMs: number }

/** What a worker's status line says right now. */
export type WorkerStatus = { isWorking: boolean; lastActiveMs: number; isNew: boolean }

/** The last task sent to a worker from the pane. */
export type SentTask = { text: string; atMs: number; isDelivered: boolean; reason?: string }

/** The panel open under a card: its outbox, its recent steps, or its settings. */
export type Panel = 'outbox' | 'activity' | 'settings'

/**
 * The New worker form's drawn state; the typed "Name, role" line lives in the hook.
 * `isTried` turns on once a create was attempted with an invalid name, so the
 * hint shows only after a failed try, never before typing. `god` is a god kind.
 */
export type FormState = { isOpen: boolean; isValid: boolean; isTried: boolean; god: string }

/**
 * A create the pane put in the prompt box: once a worker of that exact name (and a
 * key that was not in the registry then) appears, the pane fills in the god, voice and
 * tools the call session left out.
 */
export type PendingCreate = { god: string; voice: string; tools: ToolsPreset; atMs: number; known: string[] }

declare module 'claude-code' {
  interface PluginState {
    'workers-pane': {
      /** A signature of the registry and statuses: the poll's redraw trigger. */
      roster: Shaped<string>
      /** Bumped after the pane writes the registry, so the cards redraw at once. */
      rev: Shaped<number>
      sent: Shaped<Record<string, SentTask>>
      form: Shaped<FormState>
      /** The key of the card last opened (name or Open): drawn with the accent border. '' for none. */
      selected: Shaped<string>
      /** Worker key to when its Delete was armed (ms); a second press within 5 s deletes. */
      confirming: Shaped<Record<string, number>>
      /** Worker key to when its delete request was written; cleared once it leaves the registry. */
      removing: Shaped<Record<string, number>>
      /** Whether the Workers pane is the one shown. */
      paneShown: Shaped<boolean>
      /** Worker key to the panel open under its card. */
      panels: Shaped<Record<string, Panel>>
      /** Outbox item id to when its Approve or Decline started (ms), while it runs. */
      deciding: Shaped<Record<string, number>>
      /** Worker name to the create waiting for the call session to register it. */
      pending: Shaped<Record<string, PendingCreate>>
    }
  }
}
